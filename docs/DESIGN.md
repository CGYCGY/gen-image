# pi-image — Design

Standalone agentic image-generation service built on pi. A caller summons it over pi's native RPC
mode (`pi --mode rpc`, stdin/stdout JSONL) and converses with it in natural language; the spoke's own
LLM extracts intent, runs one verb, and returns a structured result. Images are produced by the Codex
CLI's built-in `image_gen` on the ChatGPT/Codex subscription; backends are pluggable. Sibling to
`pi-deployment-manager`, following the shared pi-* philosophy in
[`../../docs/building-pi-agents.md`](../../docs/building-pi-agents.md).

Section numbers here are referenced from code comments and from the plan docs in this directory —
renumbering breaks those references.

## 1. Purpose & non-goals

Purpose: give any caller — a plan runner, another agent, a script — one trusted endpoint that turns a
natural-language request into an image file on disk, on the Codex subscription, and reports back a
machine-readable verdict. The caller carries zero image-generation knowledge: no model names, no codex
invocation, no output-file plumbing, no encoder settings, no API keys.

Non-goals:

- Not a general assistant. It does not read or reason about any codebase; it only creates/edits images
  through its two verbs (`.pi/APPEND_SYSTEM.md` states this to the spoke).
- Not a daemon or a network service. It is a pi subprocess the caller owns over pipes — no HTTP port,
  no token, no portfile.
- Not an image library/CDN. It writes one file to the path the caller names and is done.
- Not a job queue. One request may conclude several images — one verb call each, rendered concurrently
  inside the turn (§8) — but nothing is persisted: no job store, no retry, no resuming a partial batch.
  A failed entry comes back failed and the caller re-asks for that one.

## 2. The gate — a closed semantic tool surface

The spoke LLM sees exactly two tools: `generate_image` and `edit_image`. pi's built-in
`bash`/`read`/`write`/`edit`/`glob` do not exist in its world. Principle #1 (closed semantic tool
surface — no raw Bash/Edit/Read), enforced two ways:

- `--no-builtin-tools` at spawn — the built-ins are never registered, so they are unrepresentable, not
  merely discouraged.
- `setActiveTools([...VERB_NAMES])` on `session_start` — re-pins the active set to exactly the two
  verbs, in case anything else tried to widen it.

The persona (`before_agent_start` appends `IMAGE_RULES`, plus `.pi/APPEND_SYSTEM.md`) is flow-level
only: extract the description/instruction and the absolute path(s), call one verb, stop. It states
rules the gate already enforces and carries no backend specifics — those live in the backend modules,
per the system-prompt-is-not-a-comment gotcha: a stale hardcoded hint is worse than none. The always-on
render rules are likewise appended by backend code, not by the persona and not by a style preset (§5).
Neither verb can act outside "make/edit one image at a named path".

read ≠ write is enforced by the path guards in `shared/sandbox.ts` (principle #3 — sandbox in code, not
trust):

- `validateOutPath` requires an absolute path with an image extension, and creates the parent dir.
- `validateInputPath` additionally requires an existing file.
- A bad or relative path throws before any work, so the spoke relays it and asks the caller — it never
  concludes a failed job over a fixable typo.
- The extension it accepts constrains the path, not the delivered format. What actually lands there is
  §4.

## 3. How generation works

pi has no native image tool. The default `gpt-image-2` backend (`image/backends/codex-imagegen.ts`)
reaches the subscription path the only way available: by driving the Codex CLI's built-in `image_gen`
from the verb's code (principle #2, capabilities wrapped not exposed — the spoke LLM never reaches a
subprocess; only `shared/subprocess.ts` does).

```bash
codex exec --skip-git-repo-check --json --sandbox workspace-write \
  -c sandbox_workspace_write.network_access=true -c model=gpt-5.6-sol \
  "<prompt instructing codex to use $imagegen and then stop>"
```

Why `codex exec` and not the OpenAI Images API: the built-in `image_gen` bills the ChatGPT/Codex
subscription, with no `OPENAI_API_KEY`; the Images API is API-key-billed. Shelling out to `codex` is the
entire reason this backend exists — it is the only way to get image generation onto a subscription the
user already pays for. The spoke orchestrator model, `openai-codex/gpt-5.6-terra`, is subscription-backed
for the same reason.

Why each flag:

- `--skip-git-repo-check` — `codex exec` otherwise refuses to run outside a trusted/git dir, and the cwd
  here is `CODEX_HOME` (neither). Image gen never touches a repo, so the check is moot.
- `--sandbox workspace-write` + `network_access=true` — the built-in tool reaches Codex's backend over
  the network, which a workspace-write run must enable explicitly.
- `-c model=gpt-5.6-sol` — pin the model so a change to the user's codex default can't silently swap it.
  sol because it *drives* `image_gen` (gpt-image-2 renders either way), and `code_mode_only` models
  can't call a tool directly.
- `--json` — codex prints no human-readable session-id header to scrape, and without that id a produced
  image cannot be attributed to the run that made it. The JSONL event stream is the machine contract,
  carrying `thread.started`.`thread_id` and the final agent message both.

Detection is fail-closed at three levels (principle #4, deterministic + fail-closed). The built-in tool
cannot choose the output filename — it writes under `$CODEX_HOME/generated_images/<session>/`, where
`<session>` is the run's codex session id and the basename varies by driver model (`call_*.png`,
`exec-*.png`). Every concurrent run on the machine shares that parent directory — other driver sessions,
other agents, other terminals — so a wrong image delivered as a success is the one failure nothing
downstream can catch. Each guard throws rather than guesses:

- Scoped to this run's session dir. The id comes off the `--json` event stream, and only that dir is
  scanned, for images at/after a timestamp floor recorded before the run (2 s skew margin). The floor
  distinguishes a fresh render from a stale leftover: nothing newer means this run produced no image, a
  failure surfaced with the output tail even if a sibling run just succeeded. There is deliberately no
  cross-session fallback — an unidentifiable session fails the run loudly, because the only alternative
  (newest image anywhere under `generated_images`) hands a sibling's render to this caller whenever two
  runs overlap.
- Exactly one candidate. Two images in one session dir means the run rendered twice, or something else
  wrote there. Recency is not evidence of ownership, so the run fails naming both files rather than
  picking the newest.
- Claimed exactly once, machine-wide. Before delivery the chosen source is recorded in an O_EXCL claims
  registry under the state dir (`claims.ts`), keyed by source path; a second claim throws naming the
  prior claimant (pid, time, its `out_path`). The kernel arbitrates the create, so this holds across
  processes, terminals and driver sessions without a lock daemon, and catches cross-assignment even when
  the cause is something the first two guards don't model. Records are pruned after a week — long enough
  to outlive any investigation of a mis-delivery.

Why not a per-run `CODEX_HOME`: it would make `generated_images/` per-run and cross-assignment
structurally impossible, which is the shape this project usually prefers. Evaluated and rejected — codex
keeps auth under `CODEX_HOME`, its refresh tokens are single-use and rotated, and a temp home that is
later deleted can burn the machine-wide codex login days after the run that did it, a failure with no
plausible trail back to the cause. It also costs ~30 MB per run and refetches the model cache. Claims
plus single-candidate detection buy the same guarantee against the only failure that matters, without
putting the user's login at risk.

Timeouts say what happened. `RunResult.timedOut` distinguishes a SIGKILL by us from a spawn error —
`code: null` alone cannot — and is checked before detection, so a killed run reports "timed out after
Ns" and never "produced no image", which would send the reader hunting a detection bug that isn't there.
`codex.timeoutMs` (default 900 s) is a backstop against a hung codex, not an operating limit: generates
land at 1–2 min, but an edit was killed mid-render at a 5 min ceiling and queued runs stretch further.
Every run logs its `durationMs` and how long it `waitedMs` for a slot, so the next value for that ceiling
can come from a distribution rather than a judgement call. The driver's own turn budget derives from the
same config value plus 10 min of queue/boot headroom rather than sitting below it, so a legitimately
queued call is never cut off from the outside.

A failed render is retried **in code**, `maxRetries` times (config, default 1), inside the verb. Not by
the spoke: a model deciding when to call a verb again would conclude a second result for the same
image, so N images could come back as N+k entries. Each attempt is a fresh `codex exec` with its own
timeout, never a continuation — the failures worth retrying (a run we killed, a run that produced
nothing) leave nothing to resume. Two failures never retry, however high `maxRetries` goes:

- The claim-once collision (§3), and
- the ambiguous multi-candidate session (§3).

Those are safety verdicts, not flaky renders. A retry that happens to succeed mutes the alarm without
fixing what tripped it, and cross-assignment is the one failure nothing downstream can catch. They are
marked `terminalError` at the throw site so the verb can tell them apart. A result that took more than
one attempt says so (`attempts`), because a backend failing half the time otherwise reads as healthy.

## 4. Delivering the file

The codex agent is told to generate and stop, not to move anything, but correctness does not depend on
it obeying: an agent's own `cp` would be sandbox-bound and could fall outside an arbitrary caller
`out_path`. `deliver()` owns the whole "codex produced a file → the caller gets a file" transition, in
our code.

The invariant: the bytes at the returned `out_path` always match its extension, on every path including
the failure ones. Codex emits PNG and nothing else, so without this step an accepted `.webp` path means
PNG bytes under a webp name, reported as success with a byte count ~10× a real webp's — the same defect
class as cross-assignment, code asserting something it never verified. Where the invariant conflicts
with the caller's chosen filename, the filename gives way and the original comes back as
`requested_path` (§7), because a `.webp` holding PNG bytes is a lie every downstream consumer inherits.

- Format comes from config, `output.{format,quality,effort}` — one source of truth, no per-call
  override. `"preserve"` (the shipped default) honours the `out_path` extension; naming a format
  rewrites the extension to match. webp at quality 80 / effort 6 measures ~11× smaller than PNG on
  infographic renders, and more on flat art, which is why the knob exists.
- Same format in and out is never re-encoded. PNG→PNG would be a pointless generation loss on the one
  path where the caller explicitly asked for what codex produced.
- Verification decodes the destination. A size check cannot tell a real webp from PNG bytes under a
  `.webp` name — exactly the defect this step exists to make impossible — so the written file is decoded
  and its format compared, and a pass-through is byte-checked against the source.
- An encode failure never discards a completed render. The partial output is removed, the original PNG
  is delivered at a `.png` path, and the result carries `format: "png"` plus a `warning`. The job still
  succeeds; it tells the truth about what landed.

Delivery is a move, not a copy (`keepSourceImages`, default false). Codex never prunes
`generated_images/`, so copying leaves every image on disk twice forever — 246 MB of accumulated sources
at the point this was measured. Pass-through renames, with a copy+unlink path for the `EXDEV` case
(`CODEX_HOME` and an arbitrary caller `out_path` are routinely on different filesystems); conversion
encodes, verifies, then unlinks. The emptied session dir is removed non-recursively, because other codex
usage writes under that root and a dir that is not empty must survive untouched rather than be swept.
Nothing but the exact source this run claimed is ever touched. Setting the flag true restores the old
behaviour, which is worth doing while the sources are wanted as an evidence trail for a suspected
mis-delivery.

`sharp` is the encoder and pi-image's first runtime dependency. It is native, which matters: under bun
the wasm libwebp builds silently produce structurally corrupted output — 14–20 dB PSNR against 33 dB for
the same library under node — at normal file sizes and with the encoder reporting success, the same
failure signature as everything else this section guards against. `shared/` stays node-builtins-only, so
sharp lives in the backend.

## 5. The style vocabulary — looks and forms

A style is one markdown file under `styles/`, on one of two axes: `looks/` (medium, palette,
mark-making, texture) and `forms/` (artifact kind, layout, orientation, text policy, legibility). The
split exists because a single fused preset silently mixes the two, and then choosing a look can veto the
form's orientation or its "text is required" clause.

Merge rules:

- Contested properties — today `orientation` and `text`, a small closed set — live only in form
  frontmatter and never in prose. A look that sets one is a loud error, not a quiet precedence puzzle.
- Frontmatter keys resolve last-wins in the caller's flag order; prose bodies concatenate in that same
  order. The two cannot contradict each other because the resolved properties are emitted last, in a
  trailing block that says it overrides.
- Multiple names are allowed on either axis and order is precedence: `--style infographic --style poster`
  is a portrait infographic with a headline; reversed, it is landscape.
- Naming nothing prepends nothing. A default look would re-create the same fusion one layer deeper,
  invisible until someone combines flags and gets a muddle.
- Unknown names throw, listing the available set — the same fail-loud convention as the backend registry
  (§6). A wrong guess self-corrects in one round trip, which is what makes preloading an index
  unnecessary.

Resolution is driver-side (`shared/styles.ts`), before the request reaches the spoke. There is no
structured parameter channel through the spoke — it receives prose and extracts intent — so the merged
text has to be assembled first. The module lives outside `.claude/skills/` on purpose: pi-image's premise
is that any caller can use it, and files reachable only from one skill would break that; the skill's
`session.ts` is a thin CLI over it. This also removes an instruction nobody could enforce — a calling
agent asked to paste a preset's full text can paraphrase or drop a bullet, and the only symptom is an
image that looks subtly off. Once the driver reads the file, what reaches the model is what is on disk.

`styles/base.md` is appended by backend code in both verbs (`baseBlock()`), after the request and before
the operational trailer. Not by the persona and not by a preset: then no preset can omit it and no
calling agent can forget it, the same reasoning as building the result in code rather than parsing prose.
A missing `base.md` throws rather than rendering without it.

Two logs, opposite retention needs:

- `logs/styles.jsonl` — one line per resolution: the requested names, each resolved file with a content
  sha, and which name won each contested key. Failed lookups too, since an unknown style name records a
  preset someone wanted and we don't have. It carries no prompt or request text: the caller already has
  the request, and a permanent local record of every prompt has no use that justifies it. The sha is what
  makes the log worth keeping — when output changes, comparing hashes says immediately whether a preset
  changed underneath you or the model simply rolled differently. Backstop rotation at 50 MB × 2, checked
  per write.
- `logs/image.log` — operational; rotates at 2 MB × 5 when opened, because error paths carry
  variable-size payloads such as a failed run's output tail, so one bad afternoon can outgrow a normal
  month.

Legitimate `styles.jsonl` growth is capped by render time at roughly 500 KB/year, so reaching 50 MB means
a caller is re-resolving without generating. That rotation is itself a bug signal and warns into
`image.log`, so it cannot stabilize at 100 MB and look normal.

## 6. Pluggable backends — and what does not generalize

The backend registry (`image/backends/index.ts`) is principle #5 (pluggable target profiles) applied to
image engines. Both verbs resolve their engine via `resolveBackend(id?)`, a fail-loud lookup: an unknown
id throws with the available set, never a silent default. Adding a backend is one file implementing
`ImageBackend` (`id`, `label`, `subscription`, `generate`, `edit`) plus one line in the registry. The
verbs never change.

The one thing that does not generalize is subscription billing. Only the Codex-backed default is
subscription-billed; `ImageBackend.subscription` records this per backend, because each backend has its
own auth/billing reality:

- Gemini "Nano Banana" (the Gemini image model via Vertex AI) — API-key-billed.
- OpenAI Images API (direct) — API-key-billed.

A Codex-backed spoke cannot borrow a Gemini subscription, and "free via subscription" is a property of
the `gpt-image-2` path specifically, not of pi-image; treating it as universal is the trap this flag
prevents. `BackendCtx` carries the `codex` config for codex-backed backends — an API backend ignores it
and reads its own creds. Delivery settings (`output`) and the machine-wide `stateDir` coordination ride
on the same context, because §4's invariant and §3's claims are backend-agnostic.

## 7. The RPC result contract

Because pi-image is conversed with in natural language there is no bespoke wire union — the request is a
prompt, and the verbs take their target as params. What is structured is the outcome, carried on two
notify markers (`ctx.ui.notify` → `extension_ui_request`, `method: "notify"`) the driver greps for:

- `PIIMAGE_READY` — emitted on `session_start`, so the driver can confirm the spoke actually booted
  before sending work.
- `PIIMAGE_START <json>` — the `out_path` a verb has committed to, emitted BEFORE the render and only
  once validation passed. It is what separates "the spoke is working" from "the spoke never called a
  verb": without it the second costs the caller its whole budget to discover, silently (observed: 25
  minutes, no transcript, no verb call). It is also the driver's per-image progress heartbeat.
- `PIIMAGE_RESULT <json>` — the `ImageJobResult` (`status`, `op`, `backend?`, `model?`, `out_path?`,
  `format?`, `requested_path?`, `bytes?`, `warning?`, `error?`). `bytes` > 0 is the proof the file
  landed, and `format` always describes the bytes at `out_path`. One notify per verb call, so a turn
  that concluded several images emits several.

The driver accumulates a turn's notifies and reports one shape to its caller — `kind: "results"`, always
an array, one entry for one image and N for N:

- No singular form exists. A second shape for the common case would buy nothing and cost every consumer
  a branch. One-entry arrays are the normal case.
- Completion order, not request order — concurrent renders finish out of order. Identify entries by
  `out_path`, never by position.
- A short array means the spoke issued fewer verb calls than the request named. The caller re-asks for
  the missing paths.
- Mixed `ok`/`failed` entries are normal, not a whole-turn failure.
- Distinct from `PIIMAGE_RESULT` above: that stays one notify per verb call, and is what the driver
  accumulates into this array.

The array holds one entry per image the caller asked for, reconciled from three sources in order of
authority: concluded results; a `PIIMAGE_START` that never concluded (the spoke died mid-render, and
code knows the path because the verb announced it); and a `--expect` path no verb ever touched. That
last source is the only one that can catch an image the SPOKE MODEL silently dropped — turning prose
into verb calls is the model's step, so an image it never calls leaves no trace inside the extension.
Callers that skip `--expect` get the first two guarantees only, and a dropped image just vanishes.

Callers must report the returned `out_path`, not the one they asked for. `requested_path` is present
exactly when the configured delivery format rewrote the caller's path (§4), and an agent that reports its
own request writes `![](foo.png)` next to a file called `foo.webp`. `warning` is a non-fatal degradation
— a job that succeeded with something worth saying — and is surfaced verbatim rather than folded into the
status.

The result is built in code (`concludeJob` in `image/index.ts`, called by the verbs in `tools.ts`) from
what the backend produced, never parsed from the spoke's prose. Same trust boundary as principle #4: the
verdict the caller acts on cannot be a hallucinated summary. A generation failure is terminal for the
job, so the verb still concludes — `status: "failed"` plus the error — rather than throwing prose. A
path-validation error throws before work, so the turn ends with no RESULT, signaling the caller to read
the assistant's question and reply. Plain unmarked assistant text is always a human-facing reply, never a
result.

## 8. Warm spokes, parallel sessions, and the render ceiling

Principle #6 (hub-and-spoke over RPC; shed per-task context with `compact()` between tasks). The real win
of the RPC spoke is keeping it warm across all images in one run: summon once, generate many, close at
the end.

- Between jobs, compact. On `agent_end`, if the turn concluded a job (`concludedThisTurn`) and context has
  grown past a small threshold, the extension calls `ctx.compact()` with instructions to discard the
  finished request's prompt, paths, and result down to a single "ready for next image" line, so the next
  unrelated image starts lean. A non-concluding turn (a question) is left intact, so the caller's reply
  still has its context.
- Why warm matters. Closing the spoke after every image throws away this amortization and collapses to
  roughly the cost of a one-off `codex exec` per image, plus a fresh pi boot each time.
- Warm within a run, not forever. The point is a single batch/plan run, not an always-on daemon (§1).
  `down`/abort at the end of the run; cold start loses nothing, since pi-image owns no persistent state
  beyond config, its logs, and the coordination files below.
- Batch inside one turn — the default for several independent images. pi executes sibling tool calls
  from one assistant message concurrently, so a request naming N images has the spoke issue N verb calls
  in one turn and the renders overlap behind one spoke and one `pi`.
  - Measured: 2 images in 71 s, the two `codex exec` launches 5 ms apart; 4 images in 78 s, all four
    within 9 ms. Each is about one render's wall-clock.
  - Costs 1 spoke + 1 pi + N codex, against N + N + N for the session-per-image shape below, and one
    spoke boot instead of N.
  - §3's guards are untouched: every image still gets its own verb call, its own `codex exec`, and so
    its own codex session dir. This adds concurrency without widening what detection must reason about.
  - Distinct `out_path`s are required. Two images on one path make the spoke stop and ask.
- Parallel sessions trade warmth for wall-clock. Each driver session (`--session <id>`, state under
  `<stateDir>/sessions/<id>/`) is an isolated spoke: own FIFO, own state file, own per-session pi `--name`
  tag, so tearing one down cannot pkill a sibling. A bare one-shot `generate` auto-picks a pid-unique
  ephemeral session, so N concurrent generates cost roughly the wall-clock of one rather than N×2 min.
  OpenAI does not serialize concurrent subscription `image_gen` calls; quota burn is unchanged, only
  elapsed time. Each parallel spoke pays its own boot, so for sequential/interactive work the single warm
  session remains the cheaper shape. The two patterns compose: a warm `main` plus ephemeral one-shots.

Where the isolation actually comes from: session isolation is real at the driver layer and stops at the
codex layer, because every spoke on the machine writes into the same `generated_images/`. What keeps one
caller from receiving another's image is not the session boundary — it is §3's fail-closed detection and
the claim-once registry, which hold across unrelated agents and terminals too. Read any claim about
parallel safety as a claim about those mechanisms.

The render ceiling is tuning, not safety. `maxConcurrentRenders` (default 20) is enforced by a semaphore
of O_EXCL slot files in the state dir, so the limit is machine-wide: an in-process counter would be
invisible to a second driver session, agent or terminal, and the resources being protected (provider rate
limits, and N `codex exec` subprocesses' worth of RAM) are shared by the whole host.

- Excess callers queue and never fail. Asking for 30 images yields 30 images, just later.
- A wait is logged when it starts and every 30 s after, so a slow batch is explainable rather than
  mysterious, and each run records the `waitedMs` it cost.
- A slot is held across delivery as well as the render, so a queued run cannot start before this one has
  claimed its source.
- Slots abandoned by a crashed holder are reclaimed on pid liveness plus a hold-age ceiling (the render
  timeout plus a margin — a run cannot legitimately outlive its own SIGKILL), by atomic rename with a
  token re-check, so exactly one reclaimer wins and a slot re-acquired in the meantime is put back.
- The default of 20 is a judgement call expected to move with evidence. It must never be the thing
  standing between the user and a wrong image.

What has actually been observed:

- Ten concurrent one-shot generates come back clean — ten distinct sessions, one candidate each, verified
  by eye. The same shape without these guards mis-delivered several of ten with all-distinct md5s; a
  duplicate-hash check does not catch this, only opening the files does.
- A 38-render validation campaign, every image checked by eye, produced 0 cross-assignments and 0 claim
  collisions.
- Queue-and-complete was proven at a ceiling of 2, with a maximum wait of 2.7 render-lengths.
- The semaphore was proven cross-process by running two separate shells against a small shared ceiling;
  the second shell's runs all waited on the first shell's slots.

None of these numbers is a safety guarantee. Safety is the fail-closed mechanism; an N is only what was
observed, and a batch size that has not been seen to fail is absence of evidence.

The practical ceiling is the spoke layer, not the renders. Beyond roughly 15 concurrent spokes the spoke
model itself stalls — at 30-way fan-out the first responses were starved for over 8 minutes — so wide
batches run in waves of ≤15, launching the next as the previous one's results land. No render semaphore
can fix that; it is a limit of the layer above.

## 9. Security & billing notes

- Subscription billing, no secrets. The default path bills the ChatGPT/Codex subscription via the local
  `codex` CLI; pi-image stores and needs no `OPENAI_API_KEY` and no cloud creds. Config is just the spoke
  model, state dir, delivery format, the render ceiling, and how to drive codex.
- Absolute-path guards, fail-closed. Writes go only where the caller names, but the path must be absolute
  (no cwd ambiguity for a long-lived spoke) and a real image extension; edit sources must exist. Enforced
  in `shared/sandbox.ts`, not in a system-prompt sentence.
- The engine is unreachable by the LLM. Only verb code shells out (`shared/subprocess.ts`), with a hard
  `timeoutMs` that SIGKILLs a stuck run. The spoke cannot invoke `codex`, choose flags, or touch the
  filesystem outside the two verbs.
- Deletion is narrow. Move-delivery unlinks exactly one file — the source this run claimed — and removes
  its session dir only non-recursively. Nothing sweeps a shared directory.
- The logs hold no prompts. `styles.jsonl` records names, file hashes and winning keys only; the
  operational log records paths, sizes and durations, plus a failed run's output tail.
- One runtime dependency. `sharp`, used only to encode and re-decode local bytes — no network, no
  credentials. Everything else is `node:` built-ins plus pi itself.
- Per-backend billing is explicit. `ImageBackend.subscription` keeps the subscription-vs-API-key reality
  of each backend visible rather than assumed (§6).

## 10. Future work

- Additional backends. A Gemini "Nano Banana" (Vertex) backend and a direct OpenAI Images API backend —
  both API-key-billed, both a one-file drop into the registry, both flagged `subscription: false`.
- A per-call format override. Config-only delivery means there is no way to get a single PNG out of a
  webp-configured install without editing `config.json`. One optional verb field would fix it: it is a
  parameter `deliver()` reads after codex is done, not a codex instruction, and it does not weaken the
  gate, which is about which tools exist. Deferred for one source of truth; this is the fix if the trade
  ever bites.
- Prompt refinement in the spoke. Let the spoke optionally expand or normalize a terse caller request
  into a fuller render prompt before calling a verb — kept flow-level, with the structured result still
  built in code.
