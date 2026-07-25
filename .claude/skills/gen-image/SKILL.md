---
name: gen-image
description: Generates or edits an image by conversing with the gated pi-image spoke over pi RPC — sends a natural-language image request, answers any question it asks, and relays the structured result. Use when asked to "generate an image", "create an image", "make a picture/icon/logo", "edit this image", or fill a plan's image slots. Runs on the Codex/ChatGPT subscription (no API key). For several independent images, run one `generate` per image as run_in_background Bash calls (NOT foreground — the harness serializes those) — sessions are isolated, so concurrent generates are safe and N images take the wall-clock of one.
argument-hint: <image request including an absolute out_path> [edit <input_path>]
allowed-tools: Bash, Read
user-invocable: true
---

# Generate Image via pi-image

## Purpose

Hand an image request to the gated pi-image spoke over pi RPC: send a natural-language prompt, answer any question it asks, and relay its code-derived result. Pure dispatch — this skill carries no generation logic; pi-image owns the backends and subscription auth.

## Instructions

- Every request MUST name an ABSOLUTE out_path (and, for an edit, an absolute input_path). The spoke refuses relative paths and will ask — resolve the path from the user before sending.
- The request is natural language; the spoke routes it to generate vs edit. For an edit, name the existing image's absolute path and the change to make.
- A call is synchronous and may take 1–2 minutes per image — do not poll, time out, or re-run it.
- Branch on the LAST JSON line's `kind` (`result` | `reply` | `error` | `ok`) — see Cookbook.
- Every subcommand takes an optional `--session <id>`; each session is a fully isolated spoke (own state, own process). Default session is `main` — except a bare `generate`, which auto-picks a unique ephemeral session, so concurrent one-shot generates NEVER collide.
- Every output line carries `session`. To follow up on a spoke (answer its question, send the next image), pass that id back via `--session`.
- For several INDEPENDENT images, PARALLEL fan-out is fastest: issue one `generate` Bash call per image with run_in_background: true — they run as concurrent processes, so 7 images land in ~2 min instead of ~14. CRITICAL: run_in_background is what parallelizes; FOREGROUND Bash calls are serialized by the harness even when batched in one message (only read-only commands parallelize), so foreground fan-out silently degrades to N×2 min. Wall-clock beats warmth; OpenAI does not rate-limit concurrent subscription image_gen calls (verified), though total quota burn is the same. Subagents are NOT needed for parallelism — only reach for one-subagent-per-image when each request might need its own back-and-forth with the spoke.
- For several images built INTERACTIVELY (back-and-forth, or sequential edits on prior outputs), keep one spoke WARM instead: `up` once → `send` per image → `down` (one boot, many cheap images).
- Never pass or guess a model — pi-image pins its models in its own config. Generation bills the Codex/ChatGPT subscription; no API key is involved.

## Tools

### generate
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" generate [--session <id>] "<request>"`
- **Args:** `request (str, required)` — a natural-language image request naming the absolute out_path; `--session (str, optional)` — omit for a unique ephemeral session (parallel-safe)
- **Does:** Summons an isolated spoke, sends one request, prints one JSON line; auto-ends the session on a final `result`. Safe to run many at once (each gets its own spoke).
- **Triggers:** "generate an image", "create an image", "make a picture", "edit this image"

### send
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" send [--session <id>] "<message>"`
- **Args:** `message (str, required)` — the next image request, or an answer to the spoke's question; `--session (str, optional)` — target session (default `main`; use the `session` from a prior output to continue that spoke)
- **Does:** Sends one prompt to the LIVE session and prints its next JSON line. Use after `up`, or after a `kind:"reply"`.
- **Triggers:** "next image", "answer the spoke", "another one"

### up
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" up [--session <id>]`
- **Args:** `--session (str, optional)` — session id (default `main`)
- **Does:** Starts a persistent warm spoke session (for many images / back-and-forth).
- **Triggers:** "start the image session", "warm up pi-image"

### down
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" down [--session <id>]`
- **Args:** `--session (str, optional)` — session id (default `main`)
- **Does:** Ends that spoke session and frees its state. Idempotent — always safe to call at the end.
- **Triggers:** "finished generating", "close the image session"

### clean
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" clean`
- **Args:** none
- **Does:** Kills ALL stale/leftover spoke processes (every session) and clears all session state.
- **Triggers:** "spoke stuck", "clean up pi-image", "stale session"

## Workflow

### Phase 1: Resolve the request
1. From USER_INPUT build a single natural-language request naming an ABSOLUTE out_path (and input_path for an edit).
2. If no absolute path is given, ask the user for one before sending.

### Phase 2: Drive the spoke
1. One image → run the `generate` tool. Several independent images → PARALLEL fan-out: one run_in_background `generate` Bash call per image (see Cookbook). Several interactive/sequential images → run `up`, then `send` per image, then `down`.
2. The call is synchronous (1–2 min/image); do not poll or re-run it.
3. Parse the LAST JSON line and branch (see Cookbook).

## Cookbook

### Image concluded
- **IF:** a tool prints `kind:"result"`
- **THEN:** if `status=="ok"`, report `out_path` + `bytes`; if `"failed"`, surface `error`. A one-shot `generate` already auto-ended; after `up`/`send`, run the `down` tool when finished.
- **EXAMPLES:** "result status:ok", "image saved"

### Spoke asks a question
- **IF:** a tool prints `kind:"reply"`
- **THEN:** read its `text` (usually it needs an absolute out_path or input_path); resolve it and answer with the `send` tool, passing `--session <the session from that output line>` so the answer reaches the SAME spoke. Repeat until `kind:"result"`.
- **EXAMPLES:** "needs an absolute out_path", "which file should I edit?"

### Spoke won't start / stuck
- **IF:** a tool prints `kind:"error"` with reason `spawn_failed` / `ready_timeout` / `spoke_down` / `timeout`
- **THEN:** run the `clean` tool, surface the `detail` (point at `<stateDir>/logs/image.log`), and retry once.
- **EXAMPLES:** "spoke did not start", "no result within N min"

### Batch of INDEPENDENT images (parallel fan-out — fastest)
- **IF:** the request needs several images that don't depend on each other and wall-clock matters
- **THEN:** issue one `generate` Bash call PER IMAGE, each with run_in_background: true — they run as concurrent processes; read each task's output when its completion notification arrives. Do NOT fan out as foreground calls: the harness runs non-read-only Bash sequentially even when batched in one message, so that silently becomes N×2 min. Bare `generate` auto-isolates per invocation — no session ids to coordinate. Each call prints its own JSON line; if one prints `kind:"reply"`, answer it afterward with `send --session <its session>`. Collect every `result` and report all paths. Do NOT spawn subagents just for parallelism — only when each image may need its own back-and-forth.
- **EXAMPLES:** "generate these 7 illustrations", "fill all the plan images fast"

### Batch of images (warm reuse — sequential)
- **IF:** the request needs several images built interactively, or later images depend on earlier outputs (e.g. edits)
- **THEN:** run `up` once, run the `send` tool per image, then `down` at the end — one boot, many cheap images.
- **EXAMPLES:** "fill all the plan images", "generate 6 icons, tweaking as we go"

## Supporting Files

- `tools/session.ts` - RPC driver (run with bun): `generate` / `up` / `send` / `down` / `clean`
- `tools/lib.ts` - spoke locator, pi spawn argv, JSONL framing, notify-marker contract

## Report

- Relay the spoke's result faithfully: a job succeeded ONLY when the line is `kind:"result"` AND `status=="ok"` — report its `out_path` and `bytes`. On anything else, report it as failed and surface `error` (or the `reply` text).
- When several images were generated, list each path.
