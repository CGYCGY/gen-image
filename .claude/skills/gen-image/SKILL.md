---
name: gen-image
description: Generates or edits an image by conversing with the gated pi-image spoke over pi RPC — sends a natural-language image request, answers any question it asks, and relays the structured result. Use when asked to "generate an image", "create an image", "make a picture/icon/logo", "edit this image", or fill a plan's image slots. Runs on the Codex/ChatGPT subscription (no API key).
argument-hint: <image request including an absolute out_path> [edit <input_path>]
allowed-tools: Bash, Read
user-invocable: true
---

# Generate Image via pi-image

## Instructions

- STYLES: if USER_INPUT names a style — `<name>:` prefix, "in <name> style", "as a <name>" — pass it as `--style <name>` on `generate`/`send`. The flag is REPEATABLE and ORDER IS PRECEDENCE: when two styles set the same property (orientation, text policy), the LAST one wins. So pass the names in the ORDER THE USER SAID THEM — never reorder, dedupe, or drop one. Do NOT read any style file or paste style text into the request: the driver reads the files itself, and what reaches the model is then exactly what is on disk.
- An unknown style name FAILS LOUDLY with the full available set, so just pass the name the user used — you never need to look up the vocabulary before calling. Relay that list to the user and retry with a real name. Run the `styles` tool only when the user asks what is available.
- Naming no style prepends nothing. Guidelines the user writes inline take precedence over a style; inline guidelines with no style named → send the request as-is.
- Every request MUST name an ABSOLUTE out_path (and, for an edit, an absolute input_path). The spoke refuses relative paths and will ask — resolve the path from the user before sending.
- The request is natural language; the spoke routes it to generate vs edit. For an edit, name the existing image's absolute path and the change to make.
- A call is synchronous and typically takes 1–2 minutes per image; under heavy parallel load it can additionally wait in the machine-wide render queue (excess calls queue, they never fail) — so a slow call is normal. Do not poll, time out, or re-run it.
- Branch on the LAST JSON line's `kind` (`results` | `reply` | `error` | `ok`) — see Cookbook. A concluded turn is ALWAYS `results`, an ARRAY, even for one image: one entry, same fields. There is no singular form.
- Every subcommand takes an optional `--session <id>`; each session is a fully isolated spoke (own state, own process). Default session is `main` — except a bare `generate`, which auto-picks a unique ephemeral session, so concurrent one-shot generates NEVER collide.
- Every output line carries `session`. To follow up on a spoke (answer its question, send the next image), pass that id back via `--session`.
- For several images, name them ALL in ONE request to ONE session — this is the default, not process fan-out. The spoke issues one verb call per image in a single turn and they render CONCURRENTLY on one spoke: 4 images landed in 78 s, the wall-clock of one.
- `results` is in COMPLETION order, NOT request order. Match every entry by its `out_path`; never by position. Count them — fewer entries than images asked for means the spoke skipped some, so re-send only the missing paths.
- Process fan-out (one run_in_background `generate` per image) is the FALLBACK: use it when images need separate sessions (their own back-and-forth), or when a single turn keeps dropping some. It costs one spoke + one pi per image instead of one for the whole batch. `run_in_background: true` is what parallelizes it; foreground fan-out silently degrades to N×2 min.
- For several images built INTERACTIVELY (back-and-forth, or sequential edits on prior outputs), keep one spoke WARM instead: `up` once → `send` per image → `down` (one boot, many cheap images).
- Never pass or guess a model — pi-image pins its models in its own config. Generation bills the Codex/ChatGPT subscription; no API key is involved.

## Tools

### generate
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" generate [--session <id>] [--style <name>]... "<request>"`
- **Args:** `request (str, required)` — a natural-language image request naming the absolute out_path; `--session (str, optional)` — omit for a unique ephemeral session (parallel-safe); `--style (str, optional, repeatable)` — style names in the user's order
- **Does:** Summons an isolated spoke, sends one request, prints one JSON line; auto-ends the session on a final `result`. Safe to run many at once (each gets its own spoke).

### send
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" send [--session <id>] [--style <name>]... "<message>"`
- **Args:** `message (str, required)` — the next image request, or an answer to the spoke's question; `--session (str, optional)` — target session (default `main`; use the `session` from a prior output to continue that spoke); `--style (str, optional, repeatable)` — style names in the user's order
- **Does:** Sends one prompt to the LIVE session and prints its next JSON line. Use after `up`, or after a `kind:"reply"`.

### up
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" up [--session <id>]`
- **Args:** `--session (str, optional)` — session id (default `main`)
- **Does:** Starts a persistent warm spoke session (for many images / back-and-forth).

### down
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" down [--session <id>]`
- **Args:** `--session (str, optional)` — session id (default `main`)
- **Does:** Ends that spoke session and frees its state. Idempotent — always safe to call at the end.

### styles
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" styles`
- **Args:** none
- **Does:** Prints the available style names, as `looks` (medium/palette/mark-making) and `forms` (artifact kind/layout/text policy). Any name from either list is valid for `--style`; the two can be combined.

### clean
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" clean`
- **Args:** none
- **Does:** Kills every session's spoke and its `pi`, plus any driver process still running — including one blocked on a dead session's FIFO — then clears all session state. Reports what it actually killed. It is a nuke: it ends other terminals' in-flight generates too.
- **Triggers:** "spoke stuck", "clean up pi-image", "stale session"

## Workflow

### Phase 1: Resolve the request
1. From USER_INPUT build a single natural-language request naming an ABSOLUTE out_path (and input_path for an edit).
2. If no absolute path is given, ask the user for one before sending.
3. If the user named any style, add one `--style <name>` per name, in the order they said them.

### Phase 2: Drive the spoke
1. One image → run the `generate` tool. Several images → name them all in ONE request: `up` once, one `send` listing every image with its own absolute path, then `down` (Cookbook). Images needing their own back-and-forth → process fan-out (Cookbook).
2. The call is synchronous — about 1–2 min whether it renders one image or a batch, since a batch renders concurrently. Do not poll or re-run it.
3. Parse the LAST JSON line and branch (see Cookbook).

## Cookbook

### Turn concluded
- **IF:** a tool prints `kind:"results"`
- **THEN:** an ARRAY, one entry per image — one entry when one image was asked for. For EACH entry: if `status=="ok"`, report the RETURNED `out_path` + `bytes`, not the path you asked for (the backend may rewrite the extension to match the configured delivery format; `requested_path` present = the file is NOT where you asked). Surface any `warning` verbatim. If `"failed"`, surface that entry's `error` — some entries failing while others succeed is normal and is NOT a whole-turn failure. Entries are in COMPLETION order, so identify each by `out_path`, never by position; fewer entries than images asked for means the spoke skipped some, so re-send only the missing paths. A one-shot `generate` already auto-ended; after `up`/`send`, run the `down` tool when finished.
- **EXAMPLES:** "result status:ok", "image saved", "generate these 4 illustrations"

### Spoke asks a question
- **IF:** a tool prints `kind:"reply"`
- **THEN:** read its `text` (usually it needs an absolute out_path or input_path); resolve it and answer with the `send` tool, passing `--session <the session from that output line>` so the answer reaches the SAME spoke. Repeat until `kind:"results"`.
- **EXAMPLES:** "needs an absolute out_path", "which file should I edit?"

### Unknown style name
- **IF:** a tool prints `kind:"error"` with reason `unknown_style`
- **THEN:** the `detail` lists every available look and form. Nothing was generated and no spoke was started, so retrying is free: pick the closest name (or ask the user which they meant) and re-run the same command with the corrected `--style`.
- **EXAMPLES:** "unknown style \"neon-glow\"", "the user invented a style name"

### Spoke won't start / stuck
- **IF:** a tool prints `kind:"error"` with reason `spawn_failed` / `ready_timeout` / `spoke_down` / `timeout`
- **THEN:** run the `clean` tool, surface the `detail` (point at `<stateDir>/logs/image.log`), and retry once.
- **EXAMPLES:** "spoke did not start", "no result within N min"

### Batch of images (one turn — DEFAULT)
- **IF:** the request needs several images that don't depend on each other
- **THEN:** `up` once, then ONE `send` naming every image with its own absolute out_path, then `down`. The spoke issues one verb call per image in a single turn; pi runs sibling tool calls concurrently, so they render at the same time behind ONE spoke and ONE pi — 4 images in 78 s, versus one spoke + one pi per image for process fan-out. Returns `kind:"results"`, one entry per image, in completion order. Give every image a DISTINCT out_path; two images on one path makes the spoke stop and ask.
- **EXAMPLES:** "generate these 4 illustrations", "fill all the plan images"

### Batch via process fan-out (FALLBACK)
- **IF:** each image needs its own back-and-forth, or a one-turn batch keeps coming back short
- **THEN:** issue one `generate` Bash call PER IMAGE, each with run_in_background: true — they run as concurrent processes, so 7 images land in ~2 min instead of ~14; read each task's output when its completion notification arrives. Do NOT fan out as foreground calls: the harness runs non-read-only Bash sequentially even when batched in one message, so that silently becomes N×2 min. OpenAI does not rate-limit concurrent subscription image_gen renders (verified); total quota burn is the same. Bare `generate` auto-isolates per invocation — no session ids to coordinate. Cap a wave at ~15 concurrent calls — beyond that the SPOKE-model layer stalls, not rendering (observed at 30-way fan-out: first responses starved for many minutes) — and start the next wave as results land. Each call prints its own JSON line; if one prints `kind:"reply"`, answer it afterward with `send --session <its session>`. Collect every `result` and report all paths. Do NOT spawn subagents just for parallelism — only when each image may need its own back-and-forth.
- **EXAMPLES:** "generate these 7 illustrations", "fill all the plan images fast"

### Batch of images (warm reuse — sequential)
- **IF:** the request needs several images built interactively, or later images depend on earlier outputs (e.g. edits)
- **THEN:** run `up` once, run the `send` tool per image, then `down` at the end — one boot, many cheap images.
- **EXAMPLES:** "fill all the plan images", "generate 6 icons, tweaking as we go"

## Report

- Relay the spoke's results faithfully: an image succeeded ONLY when the line is `kind:"results"` AND that entry's `status=="ok"` — report its `out_path` and `bytes`. On anything else, report it as failed and surface `error` (or the `reply` text).
- Always report the result's `out_path`, never the path you requested — they differ whenever `requested_path` is present. Surface `warning` whenever it is set.
- When several images were generated, list each path, and say which failed if any did — never report a batch as wholly succeeded when one entry failed, and never drop a failed entry silently.
