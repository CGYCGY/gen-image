# gen-image — Design

An image render service with no model in its path. `cli/render.ts` takes a JSON spec, validates all
of it, renders every image concurrently in code, and prints one JSON line carrying one result per
requested image in request order. Images are produced by the Codex CLI's built-in `image_gen` on the
ChatGPT/Codex subscription; backends are pluggable.

Section numbers are referenced from code comments — renumbering breaks those references. Grep for
`§` before touching a heading.

## 1. Purpose & non-goals

Purpose: give any caller — an agent, a plan runner, a script — one trusted endpoint that turns
explicit render parameters into image files on disk, on the Codex subscription, and reports a
machine-readable verdict per image. The caller carries zero image-generation knowledge: no model
names, no codex invocation, no output-file plumbing, no encoder settings, no API keys.

Non-goals:

- Not an agent. There is no LLM anywhere in the path (§2), no conversation, no intent extraction.
- Not a daemon or a network service. It is a process the caller runs and waits for.
- Not an image library or CDN. It writes the files the caller named and exits.
- Not a job queue. Nothing is persisted: no job store, no resume, no partial-batch recovery. A
  failed entry comes back failed and the caller re-requests that one image.

## 2. Why there is no LLM in the path

The previous shape was a gated pi agent: the caller sent prose over pi RPC, a spoke LLM turned that
prose into `generate_image`/`edit_image` tool calls, and code did the rendering. That LLM step is
deleted. It translated parameters the caller already had — the caller knows the prompt, the path
and the style, and writing them as JSON is strictly cheaper than writing them as a sentence for a
model to parse back into JSON.

What it cost was worse than what it bought. Turning prose into tool calls is the model's step, so an
image the model never called for left no trace inside the extension: N images requested could come
back as N−1 results, silently. An entire reconciliation mechanism existed for that one failure — the
driver took an `--expect` list of paths and synthesized a missing entry for anything no verb had
touched. Removing the model removes the failure, and `--expect` with it. Nothing reconciles anything
now; `results.length === images.length` is a property of `Promise.all` over the request array.

Three invariants follow, and they are the contract:

- **N in, N out, in request order.** `renderAll` maps over the validated jobs, so there is exactly
  one result per requested image and position is meaningful. Callers may match by index; matching by
  `out_path` also works and stays the documented habit.
- **The whole spec is validated before anything renders.** Every check in `buildJobs` is pure — path
  guards included — so a rejected spec leaves nothing on disk and the caller can fix it and re-run
  without wondering which half already happened. The one disk side effect validation deliberately
  skips is creating parent directories; `prepareOutPath` runs in a second pass, only after the
  entire spec has passed, so a bad spec never leaves empty directories behind.
- **stdout is exactly one line.** The final JSON, and nothing else. Progress, codex chatter and
  errors go to stderr and the log file, because a caller parses the last stdout line.

Validation is strict rather than forgiving. An unknown key throws instead of being ignored: a
mistyped `styles`/`outpath` that is merely dropped produces an image nobody asked for, which is the
same class of silent divergence the spec exists to prevent. Fields belonging to the other `op` are
rejected for the same reason — silently discarding the caller's `instruction` on a `generate`
renders something they never asked for. A duplicate `out_path` within one spec is a spec error: two
images landing on one path means one is lost, and which one depends on render order, so the batch is
wrong before it starts. That last guard used to be the spoke model's job.

### Exit codes

The distinction that matters to a script is not how many images failed but whether anything
happened:

- `0` — every image ok, or a successful `--dry-run` / `--list-styles`.
- `1` — at least one image failed. A partial batch is still `kind:"results"`: the successes exist on
  disk, and the caller re-requests only the failed paths.
- `2` — spec, usage or config error (`kind:"error"`, with `reason` one of `bad_spec`,
  `unknown_style`, `bad_args`, `config_error`). **Nothing rendered; no image file exists.** The one
  side effect reachable at exit 2 is a created parent directory, from a `prepareOutPath` pass that
  failed partway. Re-running the fixed spec is always safe.

## 3. How generation works

The default `gpt-image-2` backend (`image/backends/codex-imagegen.ts`) drives the Codex CLI:

```bash
codex exec --skip-git-repo-check --json --sandbox workspace-write \
  -c sandbox_workspace_write.network_access=true -c model=gpt-5.6-sol \
  "<prompt instructing codex to use $imagegen and then stop>"
```

Why `codex exec` and not the OpenAI Images API: the built-in `image_gen` bills the ChatGPT/Codex
subscription with no `OPENAI_API_KEY`, while the Images API is key-billed. Shelling out to `codex`
is the entire reason this backend exists — it is the only way to get image generation onto a
subscription the user already pays for.

Why each flag:

- `--skip-git-repo-check` — `codex exec` otherwise refuses to run outside a trusted/git directory,
  and the cwd here is `CODEX_HOME`, which is neither. Image gen never touches a repo, so the check
  is moot.
- `--sandbox workspace-write` + `network_access=true` — the built-in tool reaches Codex's backend
  over the network, which a workspace-write run must enable explicitly.
- `-c model=…` — pin the driver model so a change to the user's codex default cannot silently swap
  it. It drives `image_gen`; gpt-image-2 renders either way. Keep to a `code_mode` model:
  `code_mode_only` ones (terra/luna) cannot emit a direct tool call and shell out to re-read the
  imagegen skill doc first — ~50% more tokens for an identical image.
- `--json` — codex ≥0.146 no longer prints the human-readable session-id header that used to be
  scraped, and without that id a produced image cannot be attributed to the run that made it. The
  JSONL event stream is the machine contract, carrying `thread.started`.`thread_id` (older builds:
  `session_id`) and the final agent message both. Non-JSON lines are interleaved on stdout, so
  unparseable lines are skipped rather than fatal.

Detection is fail-closed at three levels. The built-in tool cannot choose the output filename — it
writes under `$CODEX_HOME/generated_images/<session>/`, and the basename varies by driver model
(`call_*.png` on a direct tool call, `exec-*.png` via code mode). Every concurrent run on the
machine shares that parent directory: other agents, other terminals, other checkouts. **A wrong
image delivered as a success is the one failure nothing downstream can catch** — both runs look
successful, both files exist, and the md5s differ, so no consumer notices. Each guard therefore
throws rather than guesses:

- **Scoped to this run's session dir.** The id comes off the `--json` event stream, and only that
  directory is scanned, for images at or after a timestamp floor recorded before the run (2 s skew
  margin). The floor separates a fresh render from a stale leftover: nothing newer means this run
  produced no image, surfaced as a failure with codex's own output tail even if a sibling run just
  succeeded. There is deliberately no cross-session fallback — an unidentifiable session fails the
  run loudly, because the only alternative (newest image anywhere under `generated_images`) hands a
  sibling's render to this caller whenever two runs overlap.
- **Exactly one candidate.** Two images in one session dir means the run rendered twice, or
  something else wrote there. Recency is not evidence of ownership, so the run fails naming both
  files rather than picking the newest.
- **Claimed exactly once, machine-wide.** Before delivery the chosen source is recorded in an O_EXCL
  claims registry under the state dir (`claims.ts`), keyed by a hash of the source path; a second
  claim throws naming the prior claimant (pid, time, its `out_path`). The kernel arbitrates the
  create, so this holds across processes and terminals without a lock daemon, and it catches
  cross-assignment even when the cause is something the first two guards do not model. Records are
  pruned after a week — long enough to outlive any investigation of a mis-delivery, short enough
  that the directory never becomes a scan cost.

Why not a per-run `CODEX_HOME`: it would make `generated_images/` per-run and cross-assignment
structurally impossible, which is the shape this project usually prefers. Evaluated and rejected —
codex keeps auth under `CODEX_HOME`, its refresh tokens are single-use and rotated, and a temp home
that is later deleted can burn the machine-wide codex login days after the run that did it, a
failure with no plausible trail back to the cause. It also costs ~30 MB per run and refetches the
model cache. Claims plus single-candidate detection buy the same guarantee against the only failure
that matters, without putting the user's login at risk.

Timeouts say what happened. `RunResult.timedOut` distinguishes a SIGKILL by us from a spawn error —
`code: null` alone cannot — and is checked before detection, so a killed run reports "timed out
after Ns" and never "produced no image", which would send the reader hunting a detection bug that
is not there. `codex.timeoutMs` (default 900 s) is a backstop against a hung codex, not an operating
limit: generates land at 1–2 min, but an edit was killed mid-render at a 5 min ceiling and queued
runs stretch further. Every run logs its `durationMs` and how long it `waitedMs` for a slot, so the
next value for that ceiling can come from a distribution rather than a judgement call.

A failed render is retried **in code** (`renderWithRetry` in `image/render.ts`), `maxRetries` times,
default 1. Retrying lives there rather than with the caller because the caller's unit of work is a
whole batch: re-running it to rescue one flaky image would pay for every image in it again. It must
never be a model's decision either — that was true of the deleted spoke and stays true of the
calling agent, because a retry decided outside the render loop produces a second result for the same
image, and N images come back as N+k entries. Each attempt is a fresh `codex exec` with its own
timeout, never a continuation: the failures worth retrying (a hung codex we killed, a run that
produced nothing) leave nothing to resume.

Two failures never retry, however high `maxRetries` goes: the claim-once collision and the ambiguous
multi-candidate session. Those are safety verdicts, not flaky renders — a retry that happens to
succeed mutes the alarm without fixing what tripped it. They are marked `terminalError` at the throw
site (flagged on the error object rather than by class, so it survives the module boundary) and the
retry loop breaks on `isTerminal`. A result that took more than one attempt reports `attempts`,
because a backend failing half the time otherwise reads as perfectly healthy.

`renderImage` never throws for a failed render; it resolves a `status:"failed"` result. That is what
makes one bad image cost the caller only that image. `renderAll` still wraps the call, because a
defect that does throw must not cost the batch either.

## 4. Delivering the file

The codex agent is told to generate and stop, not to move anything, but correctness does not depend
on it obeying: an agent's own `cp` would be sandbox-bound and could fall outside an arbitrary caller
`out_path`. `deliver()` owns the whole "codex produced a file → the caller gets a file" transition,
in our code.

### 4a. The format invariant

**The bytes at the returned `out_path` always match its extension**, on every path including the
failure ones. Codex emits PNG and nothing else, so without this step an accepted `.webp` path means
PNG bytes under a webp name, reported as success with a byte count ~10× a real webp's — the same
defect class as cross-assignment: code asserting something it never verified. Where the invariant
conflicts with the caller's chosen filename, the filename gives way and the original comes back as
`requested_path` (§7), because a `.webp` holding PNG bytes is a lie every downstream consumer
inherits.

- Format comes from config, `output.{format,quality,effort}` — one source of truth, no per-call
  override. `"preserve"` (the shipped default) honours the `out_path` extension; naming a format
  rewrites the extension to match. webp at quality 80 / effort 6 measures ~11× smaller than PNG on
  infographic renders, and more on flat art, which is why the knob exists. An unrecognised value
  falls back to `preserve` rather than throwing: honouring the caller's extension is the one
  behaviour that is always correct.
- Same format in and out is never re-encoded. PNG→PNG would be a pointless generation loss on the
  one path where the caller explicitly asked for what codex produced.
- Verification decodes the destination. A size check cannot tell a real webp from PNG bytes under a
  `.webp` name — exactly the defect this step exists to make impossible — so the written file is
  decoded and its format compared, and a pass-through is byte-checked against the source.
- An encode failure never discards a completed render. The partial output is removed (so it cannot
  survive as a plausible-looking file), the original PNG is delivered at a `.png` path, and the
  result carries `format:"png"` plus a `warning`. The job still succeeds; it tells the truth about
  what landed.
- Any format added to `OUTPUT_FORMATS` must first be verified readable by `codex exec -i`, since
  today's output is tomorrow's edit input.

### 4b. Move, not copy

Delivery is a move (`keepSourceImages`, default false). Codex never prunes `generated_images/`, so
copying leaves every image on disk twice forever — 246 MB of accumulated sources at the point this
was measured. Pass-through renames, with a copy+unlink path for the `EXDEV` case (`CODEX_HOME` and
an arbitrary caller `out_path` are routinely on different filesystems); conversion encodes, verifies,
then unlinks. `place()` returns whether the source is already gone, because a rename cannot lose
bytes whereas a copy must be verified before the source is removed. The emptied session dir is
removed non-recursively, because other codex usage writes under that root and a directory that is
not empty must survive untouched rather than be swept. Nothing but the exact source this run claimed
is ever touched. Setting the flag true restores the copy behaviour, which is worth doing while the
sources are wanted as an evidence trail for a suspected mis-delivery.

`sharp` is the encoder and the only runtime dependency. It is native, which matters: under bun the
wasm libwebp builds silently produce structurally corrupted output — 14–20 dB PSNR against 33 dB for
the same library under node — at normal file sizes and with the encoder reporting success, the same
failure signature as everything else this section guards against. `shared/` stays
node-builtins-only, so sharp lives in the backend.

## 5. The style vocabulary — looks and forms

A style is one markdown file under `styles/`, on one of two axes: `looks/` (medium, palette,
mark-making, texture) and `forms/` (artifact kind, layout, orientation, text policy, legibility).
The split exists because a single fused preset silently mixes the two, and then choosing a look can
veto the form's orientation or its "text is required" clause.

Merge rules:

- Contested properties — today `orientation` and `text`, a small closed set — live only in form
  frontmatter and never in prose. A look that sets one is a loud error, not a quiet precedence
  puzzle.
- Frontmatter keys resolve last-wins in the caller's order; prose bodies concatenate in that same
  order. The two cannot contradict each other because the resolved properties are emitted last, in a
  trailing block that says it overrides.
- Multiple names are allowed on either axis and order is precedence: `["infographic","poster"]` is a
  landscape headline poster; reversed, it is a portrait infographic.
- Names are resolved across both directories, so a caller never has to know a name's axis. The
  namespaces must therefore stay disjoint: a name existing as both a look and a form throws, because
  resolution would otherwise depend on lookup order instead of on the file.
- Naming nothing prepends nothing. A default look would re-create the same fusion one layer deeper,
  invisible until someone combines names and gets a muddle.
- Unknown names throw, listing the available set — the same fail-loud convention as the backend
  registry (§6). A wrong guess self-corrects in one round trip, which is what makes preloading an
  index unnecessary.

Resolution happens in `cli/render.ts` before any render, and a failure is a `bad_spec`/`unknown_style`
error with exit 2 — so a typo'd style name costs nothing rather than half a batch. The merged text is
prepended to that image's own prompt/instruction, because the backend takes prose, not parameters.
Per-image `style` **replaces** the top-level list rather than merging: merging two ordered
last-wins lists has no defensible answer, and replacement is the one rule a caller can predict. An
explicit empty list is how one image opts out of a styled batch. Distinct lists are resolved once
each and cached per batch — re-reading and re-logging the same files N times says nothing the first
resolution did not.

`shared/styles.ts` is importable on its own, so a plan runner or a script can list and resolve
styles without going through the CLI.

`styles/base.md` is appended by backend code (`baseBlock()`), after the request and before the
operational trailer. Not by a preset and not by the calling agent: then no preset can omit it and no
caller can forget it, the same reasoning as building the result in code rather than parsing prose. A
missing `base.md` throws rather than rendering without it.

Two logs, opposite retention needs:

- `logs/styles.jsonl` — one line per resolution: the requested names, each resolved file with a
  content sha, and which name won each contested key. Failed lookups too, since an unknown style
  name records a preset someone wanted and we do not have. It carries no prompt or request text: the
  caller already has the request, and a permanent local record of every prompt has no use that
  justifies it. The sha is what makes the log worth keeping — when output changes, comparing hashes
  says immediately whether a preset changed underneath you or the model simply rolled differently.
  Backstop rotation at 50 MB × 2, checked per write (a single long-lived process is what a runaway
  loop looks like, so checking only at open would never fire for the case the cap exists to catch).
- `logs/image.log` — operational; rotates at 2 MB × 5 when opened, because error paths carry
  variable-size payloads such as a failed run's output tail, so one bad afternoon can outgrow a
  normal month.

Legitimate `styles.jsonl` growth is capped by render time at roughly 500 KB/year, so reaching 50 MB
means a caller is re-resolving without generating. That rotation is itself a bug signal and warns
into `image.log`, so it cannot stabilize at 100 MB and look normal.

## 6. Pluggable backends — and what does not generalize

Both ops resolve their engine through `resolveBackend(id?)` (`image/backends/index.ts`), a fail-loud
lookup: an unknown id throws with the available set, never a silent default. The CLI resolves it
during validation too, so a bad `backend` is a spec error before any render starts. Adding a backend
is one file implementing `ImageBackend` (`id`, `label`, `subscription`, `generate`, `edit`) plus one
line in the registry; nothing above it changes.

The one thing that does not generalize is subscription billing. Only the Codex-backed default is
subscription-billed; `ImageBackend.subscription` records this per backend, because each backend has
its own auth/billing reality:

- Gemini "Nano Banana" (the Gemini image model via Vertex AI) — API-key-billed.
- OpenAI Images API (direct) — API-key-billed.

"Free via subscription" is a property of the `gpt-image-2` path specifically, not of gen-image;
treating it as universal is the trap this flag prevents. `BackendCtx` carries the `codex` config for
codex-backed backends — an API backend ignores it and reads its own creds. Delivery settings
(`output`) and the machine-wide `stateDir` coordination ride on the same context, because §4's
invariant and §3's claims are backend-agnostic.

## 7. The result contract

One `ImageJobResult` per requested image (`shared/types.ts`), built in code from what the backend
actually produced, never parsed from any prose. The whole run is one JSON object on the last stdout
line:

```json
{"kind":"results","results":[ /* one entry per image, in REQUEST order */ ]}
```

- **REQUEST order, not completion order.** Renders finish out of order; code controls dispatch, so
  the array does not. Callers may match by index; matching by `out_path` also works and stays the
  documented habit.
- **No singular form and no short array.** One-entry arrays are the normal case; a second shape for
  it would buy nothing and cost every consumer a branch. A short array is now unrepresentable (§2).
- **Mixed ok/failed is normal**, not a whole-run failure. `bytes > 0` is the proof a file landed, and
  `format` always describes the bytes at `out_path`.
- **Callers must report the returned `out_path`, not the one they asked for.** `requested_path` is
  present exactly when the configured delivery format rewrote the caller's path (§4a); an agent that
  reports its own request writes `![](foo.png)` next to a file called `foo.webp`.
- **`warning` is a non-fatal degradation** — a job that succeeded with something worth saying — and
  is surfaced verbatim rather than folded into the status.
- **`attempts` is a health signal, not an action item.** Present only when an image took more than
  one render, on success and failure alike.

The other output kinds share the same "one line, always" rule: `kind:"plan"` for `--dry-run`
(op, out_path, resolved style names and a 160-char prompt preview per image — enough to check a
batch without spending it), `kind:"styles"` for `--list-styles`, and `kind:"error"` for anything
that failed before rendering. `run()` returns the `Out` value and only `import.meta.main` prints and
exits, which is what makes every one of these directly testable without a subprocess.

## 8. Concurrency and the render ceiling

Every image in a spec is dispatched at once (`Promise.all` in `renderAll`). There is deliberately no
second concurrency cap in the CLI: the backend's machine-wide semaphore is the one ceiling, and a
cap in the CLI would throttle against a limit it cannot see the other holders of.

`maxConcurrentRenders` (default 20) is enforced by a semaphore of O_EXCL slot files in the state dir
(`semaphore.ts`), so the limit is machine-wide. An in-process counter would be invisible to a second
process, agent or terminal, and the resources being protected — provider rate limits, and N
`codex exec` subprocesses' worth of RAM — are shared by the whole host.

- **It is tuning, not safety.** Excess callers queue and never fail: asking for 30 images yields 30
  images, just later. It must never be the thing standing between the user and a wrong image.
- A wait is logged when it starts and every 30 s after, so a slow batch is explainable rather than
  mysterious, and each run records the `waitedMs` it cost.
- A slot is held across delivery as well as the render — the extra ~400 ms is nothing against a
  ~120 s render, and releasing early would let a queued run start before this one has claimed its
  source.
- Slots abandoned by a crashed holder are reclaimed on pid liveness plus a hold-age ceiling (the
  render timeout plus a margin — a run cannot legitimately outlive its own SIGKILL), by atomic
  rename with a token re-check, so exactly one reclaimer wins and a slot legitimately re-acquired in
  the meantime is put back. Release only unlinks a slot still stamped with our own token.
- Poll intervals are jittered so a batch released together does not stampede the same slot file.
- The default of 20 is a judgement call expected to move with evidence.

What has actually been observed (under the previous driver, but against these same mechanisms):

- Ten concurrent one-shot generates come back clean — ten distinct sessions, one candidate each,
  verified by eye. The same shape without these guards mis-delivered several of ten with
  all-distinct md5s; a duplicate-hash check does not catch this, only opening the files does.
- A 38-render validation campaign, every image checked by eye, produced 0 cross-assignments and 0
  claim collisions.
- Queue-and-complete was proven at a ceiling of 2, with a maximum wait of 2.7 render-lengths.
- The semaphore was proven cross-process by running two separate shells against a small shared
  ceiling; the second shell's runs all waited on the first shell's slots.

None of these numbers is a safety guarantee. Safety is the fail-closed mechanism; an N is only what
was observed, and a batch size that has not been seen to fail is absence of evidence. Very large
batches are still best run in waves rather than as one 50-image spec — not because the semaphore
cannot hold, but because a single failure mode observed late costs the whole wave.

## 9. State, and one checkout per machine

`stateDir` (default `<repo>/state`, `~` expanded) holds `logs/`, `claims/` and `render-slots/`.

`claims/` and `render-slots/` are machine-wide arbitration, so putting them under the checkout makes
the checkout the arbitration boundary: **one checkout per machine.** Two checkouts rendering at once
have two independent registries — each arbitrates only against itself, the effective ceiling becomes
2×`maxConcurrentRenders`, and a cross-assignment between the two goes undetected, which §3 exists
entirely to prevent. This is an accepted, documented constraint, not a bug to fix. Two checkouts
that genuinely must coexist point their `stateDir`s at the same directory; a container overrides it
to a mounted volume for the same reason.

`PROJECT_DIR` self-locates from `import.meta.url`, so the checkout survives being moved and no
environment variable is consulted to find the code. `GEN_IMAGE_CONFIG` is the only env var the
runtime reads, and only to redirect `config.json`; it is resolved per call rather than at import, so
an embedder can point at a different file before the first `loadConfig()` without import-order
games. `GEN_IMAGE_DIR` is a `setup.sh` and caller-side convention for *where the checkout is* — no
runtime code reads it. A missing or unparseable config falls back to all defaults rather than
failing, so the service works out of the box.

## 10. Security & billing notes

- Subscription billing, no secrets. The default path bills the ChatGPT/Codex subscription via the
  local `codex` CLI; gen-image stores and needs no `OPENAI_API_KEY` and no cloud creds. Config is
  just the state dir, delivery format, the render ceiling, the retry budget and how to drive codex.
- Absolute-path guards, fail-closed. Writes go only where the caller names, but the path must be
  absolute (the caller's cwd is not ours) and a real image extension; edit sources must exist and be
  files. Enforced in `shared/sandbox.ts`.
- One place shells out. `shared/subprocess.ts`, with a hard `timeoutMs` that SIGKILLs a stuck run
  and stdin ignored so `codex exec` cannot block waiting on a pipe.
- Deletion is narrow. Move-delivery unlinks exactly one file — the source this run claimed — and
  removes its session dir only non-recursively. Nothing sweeps a shared directory.
- The logs hold no prompts. `styles.jsonl` records names, file hashes and winning keys only; the
  operational log records paths, sizes and durations, plus a failed run's output tail.
- One runtime dependency. `sharp`, used only to encode and re-decode local bytes — no network, no
  credentials. Everything else is `node:` built-ins.
- Per-backend billing is explicit. `ImageBackend.subscription` keeps the subscription-vs-API-key
  reality of each backend visible rather than assumed (§6).

## 11. Future work

- Additional backends. A Gemini "Nano Banana" (Vertex) backend and a direct OpenAI Images API
  backend — both API-key-billed, both a one-file drop into the registry, both flagged
  `subscription: false`.
- A per-image format override. Config-only delivery means there is no way to get a single PNG out of
  a webp-configured install without editing `config.json`. One optional spec field would fix it: it
  is a parameter `deliver()` reads after codex is done, not a codex instruction. Deferred for one
  source of truth; this is the fix if the trade ever bites.
- A cheap per-image progress channel. Today stderr carries `[i/N]` lines and a caller that only
  reads stdout sees nothing until the batch ends. Structured progress on stderr would let a long
  wave report as it lands, without touching the single-line stdout contract.
