# pi-image — Design

> Standalone agentic **image-generation service**, built on pi. A caller **summons** it over pi's
> native RPC mode (`pi --mode rpc`, stdin/stdout JSONL) and **converses** with it in natural
> language; the spoke's own LLM extracts intent, runs one verb, and returns a structured result.
> Images are produced by the Codex CLI's built-in `image_gen` on the ChatGPT/Codex subscription;
> backends are pluggable. Sibling to `pi-deployment-manager`, following the shared pi-* philosophy in
> [`../../docs/building-pi-agents.md`](../../docs/building-pi-agents.md).

---

## 1. Purpose & non-goals

**Purpose.** Give any caller — a plan runner, another agent, a script — a single trusted endpoint that
turns a natural-language request into an image file on disk, on the Codex subscription, and reports
back a machine-readable verdict. The caller carries **zero** image-generation knowledge: no model
names, no codex invocation, no output-file plumbing, no API keys.

**Non-goals.**

- Not a general assistant. It does not read or reason about any codebase; it only creates/edits images
  through its two verbs (`.pi/APPEND_SYSTEM.md` states this to the spoke).
- Not a daemon or a network service. It is a pi subprocess the caller owns over pipes — no HTTP port,
  no token, no portfile.
- Not an image library/CDN. It writes one file to the absolute path the caller names and is done.
- Not multi-job-at-once *per spoke*. One purpose, one verb per request, one image at a time — a
  batch parallelizes by summoning **multiple isolated spokes** (driver sessions, §6), never by
  overlapping jobs inside one.

---

## 2. The gate — a closed semantic tool surface

The spoke LLM sees **exactly two tools**: `generate_image` and `edit_image`. pi's built-in
`bash`/`read`/`write`/`edit`/`glob` do not exist in its world. This is principle #1 (*closed semantic
tool surface — no raw Bash/Edit/Read*) made real, two ways, belt-and-braces:

- **`--no-builtin-tools`** at spawn — the built-ins are never registered, so they are *unrepresentable*,
  not merely discouraged.
- **`setActiveTools([...VERB_NAMES])`** on `session_start` — re-pins the active set to exactly the two
  verbs, in case anything else tried to widen it.

The persona (`before_agent_start` appends `IMAGE_RULES`, plus `.pi/APPEND_SYSTEM.md`) is **flow-level
only**: extract the description/instruction and the absolute path(s), call one verb, stop. It states
the rules the gate already enforces; it does not carry backend specifics (those live in the backend
modules, per the *system-prompt-is-not-a-comment* gotcha — a stale hardcoded hint would be worse than
none). The litmus test holds: neither verb can act outside "make/edit one image at a named path."

**read ≠ write** still applies through the path guards (`shared/sandbox.ts`, principle #3 — *sandbox in
code, not trust*): `validateOutPath` requires an absolute path with an image extension and creates the
parent dir; `validateInputPath` additionally requires an existing file. A bad/relative path **throws
before any work**, so the spoke relays it and asks the caller — it never concludes a failed job over a
fixable typo.

---

## 3. How generation works

pi has **no native image tool**. The default `gpt-image-2` backend (`image/backends/codex-imagegen.ts`)
reaches the subscription path the only way available — by driving the Codex CLI's built-in `image_gen`
from the **verb's code** (principle #2, *capabilities wrapped, not exposed* — the spoke LLM never
reaches a subprocess; only `shared/subprocess.ts` does):

```bash
codex exec --skip-git-repo-check --sandbox workspace-write \
  -c sandbox_workspace_write.network_access=true -c model=gpt-5.5 \
  "<prompt instructing codex to use $imagegen and then stop>"
```

**Why `codex exec`, not the OpenAI Images API.** The built-in `image_gen` bills the **ChatGPT/Codex
subscription** — no `OPENAI_API_KEY`. The Images API is API-key-billed. Shelling out to `codex` is
the *entire reason* this backend exists: it is the only way to get image generation onto the
subscription a user already pays for. (The spoke orchestrator model, `openai-codex/gpt-5.5`, is
subscription-backed for the same reason.)

**Why the flags.** `--skip-git-repo-check`: `codex exec` otherwise refuses to run outside a
trusted/git dir, and the cwd here is `CODEX_HOME` (neither) — image gen never touches a repo, so the
check is moot. `--sandbox workspace-write` + `network_access=true`: the built-in tool reaches Codex's
backend over the network, which a workspace-write run must enable explicitly. `-c model=gpt-5.5`: pin
the model so a change to the user's codex default can't silently swap it.

**The session-scoped detection guard** (principle #4, *deterministic + fail-closed*). The built-in tool
**can't choose the output filename** — it writes under `$CODEX_HOME/generated_images/<session>/ig_*.png`,
where `<session>` is the run's codex session id, printed in the `codex exec` header (`session id: …`).
The backend records a timestamp floor before the run (with a small skew margin), parses that id from
stdout afterward, and scans **only that run's session dir** for the newest image at/after the floor,
then `copyFileSync`s it to the caller's `out_path` and stat-checks the bytes. Scoping to the run's own
dir is what makes **concurrent runs safe**: they all share `generated_images/`, so a global
newest-since scan could copy a *sibling run's* image — silent cross-contamination. (The global scan
survives only as a logged fallback for a header-format change.) The floor distinguishes a fresh render
from a stale leftover: if the run's dir has nothing newer, codex produced no image — a **failure**,
surfaced with the stderr/stdout tail, never a silent copy of an old file. The codex agent is *told* to
generate and stop (not to move the file), but correctness does not depend on it obeying: an agent's own
`cp` would also be sandbox-bound and could fall outside an arbitrary caller `out_path`, so the move is
done in our code.

---

## 4. Pluggable backends — and what does not generalize

The backend registry (`image/backends/index.ts`) is principle #5 (*pluggable target profiles*) applied
to image engines. Both verbs resolve their engine via `resolveBackend(id?)`, a **fail-loud** lookup: an
unknown id throws with the available set, never a silent default. **Adding a backend = drop one file**
implementing `ImageBackend` (`id`, `label`, `subscription`, `generate`, `edit`) + one line in the
registry. The verbs never change.

**The one thing that does not generalize: subscription billing.** Only the Codex-backed default is
subscription-billed. The `ImageBackend.subscription` boolean records this per backend, because each
backend has its own auth/billing reality:

- **Gemini "Nano Banana"** (the Gemini image model via **Vertex AI**) — **API-key-billed**.
- **OpenAI Images API** (direct) — **API-key-billed**.

A Codex-backed spoke **cannot** borrow a Gemini subscription, and "free via subscription" is a property
of the `gpt-image-2` path specifically, not of pi-image. Treating it as universal is the trap this flag
exists to prevent. `BackendCtx` carries the `codex` config for codex-backed backends; an API backend
ignores it and reads its own creds.

---

## 5. The RPC result contract

Because pi-image is conversed with in natural language, there is no bespoke wire union — the request is
a prompt, the verbs take their target as params. What is structured is the **outcome**, carried on two
notify markers (`ctx.ui.notify` → `extension_ui_request`, `method: "notify"`) the driver greps for:

- **`PIIMAGE_READY`** — emitted on `session_start` so the driver can confirm the spoke actually booted
  before sending work.
- **`PIIMAGE_RESULT <json>`** — the `ImageJobResult` (`status`, `op`, `backend?`, `model?`, `out_path?`,
  `bytes?`, `error?`). `bytes` > 0 is the proof the file landed.

The result is **built in code** (`concludeJob` in `image/index.ts`, called by the verbs in `tools.ts`)
from what the backend produced — **never parsed from the spoke's prose**. This is the same trust
boundary as principle #4: the verdict the caller acts on cannot be a hallucinated summary. A generation
failure is *terminal* for the job, so the verb still concludes — with `status: "failed"` and the error —
rather than throwing prose. By contrast, a **path-validation** error throws *before* work; the turn ends
with **no** RESULT, signaling the caller to read the assistant's question and reply. Plain unmarked
assistant text is always a human-facing reply, never a result.

---

## 6. Warm-spoke context economy & the speed tradeoff

This is principle #6 (*hub-and-spoke over RPC; shed per-task context with `compact()` between tasks*).
The real win of the RPC spoke is keeping it **warm across all images in one run**: summon once, generate
many, close at the end.

- **Between jobs, compact.** On `agent_end`, if the turn **concluded** a job (`concludedThisTurn`) and
  context has grown past a small threshold, the extension calls `ctx.compact()` with instructions to
  discard the finished request's prompt, paths, and result down to a single "ready for next image"
  line. The next, unrelated image starts lean. A **non-concluding** turn (a question) is left intact, so
  the caller's reply still has its context.
- **Why warm matters.** Closing the spoke after every image throws away this amortization and collapses
  to roughly the cost of a one-off `codex exec` per image, plus a fresh pi boot each time. Reusing one
  live session across a batch pays the startup once.
- **Warm within a run, not forever.** The point is a single batch/plan run, not an always-on daemon
  (see non-goals). `down`/abort at the end of the run; cold start loses nothing — pi-image owns no
  persistent state beyond config and its log.
- **Parallel sessions — trade warmth for wall-clock.** Each driver session
  (`--session <id>`, state under `<stateDir>/sessions/<id>/`) is a fully isolated spoke: own FIFO,
  own state file, own per-session pi `--name` tag (so tearing one down can't pkill a sibling). A bare
  one-shot `generate` auto-picks a pid-unique ephemeral session, so N concurrent generates — e.g.
  one caller issuing N parallel `generate` invocations — are isolated **by construction** and N
  images cost the wall-clock of one (~2 min instead of N×2). OpenAI does not serialize concurrent subscription
  `image_gen` calls (verified empirically at N=4); quota burn is unchanged, only elapsed time. Each
  parallel spoke pays its own boot, so for *sequential/interactive* work the single warm session
  remains the cheaper shape; the two patterns compose (a warm `main` plus ephemeral one-shots).

---

## 7. Security & billing notes

- **Subscription billing, no secrets.** The default path bills the ChatGPT/Codex subscription via the
  local `codex` CLI; pi-image stores and needs **no** `OPENAI_API_KEY` and **no** cloud creds. Config is
  just the spoke model, state dir, and how to drive codex.
- **Absolute-path guards, fail-closed.** Writes go only where the caller names, but the path must be
  absolute (no cwd ambiguity for a long-lived spoke) and a real image extension; edit sources must
  exist. Enforced in `shared/sandbox.ts`, not in a system-prompt sentence.
- **The engine is unreachable by the LLM.** Only verb code shells out (`shared/subprocess.ts`), with a
  hard `timeoutMs` that SIGKILLs a stuck run. The spoke cannot invoke `codex`, choose flags, or touch
  the filesystem outside the two verbs.
- **Per-backend billing is explicit.** `ImageBackend.subscription` keeps the subscription-vs-API-key
  reality of each backend visible rather than assumed (see §4).

---

## 8. Future work

- **Additional backends.** A Gemini "Nano Banana" (Vertex) backend and a direct OpenAI Images API
  backend — both API-key-billed, both a one-file drop into the registry, both flagged
  `subscription: false`.
- **Prompt refinement in the spoke.** Let the spoke optionally expand or normalize a terse caller
  request into a fuller render prompt before calling a verb — kept flow-level, with the structured
  result still built in code.
