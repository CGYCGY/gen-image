---
name: gen-image
description: Generates or edits an image by conversing with the gated pi-image spoke over pi RPC — sends a natural-language image request, answers any question it asks, and relays the structured result. Use when asked to "generate an image", "create an image", "make a picture/icon/logo", "edit this image", or fill a plan's image slots. Runs on the Codex/ChatGPT subscription (no API key).
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
- For several images in one run, prefer `up` once → `send` per image → `down`. This keeps the spoke WARM (one boot, many cheap images) instead of re-paying startup each time.
- Never pass or guess a model — pi-image is pinned to gpt-5.5 in its own config. Generation bills the Codex/ChatGPT subscription; no API key is involved.

## Tools

### generate
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" generate "<request>"`
- **Args:** `request (str, required)` — a natural-language image request naming the absolute out_path
- **Does:** Summons the spoke if needed, sends one request, prints one JSON line; auto-ends the session on a final `result`.
- **Triggers:** "generate an image", "create an image", "make a picture", "edit this image"

### send
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" send "<message>"`
- **Args:** `message (str, required)` — the next image request, or an answer to the spoke's question
- **Does:** Sends one prompt to the LIVE session and prints its next JSON line. Use after `up`, or after a `kind:"reply"`.
- **Triggers:** "next image", "answer the spoke", "another one"

### up
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" up`
- **Args:** none
- **Does:** Starts the persistent warm spoke session (for many images / back-and-forth).
- **Triggers:** "start the image session", "warm up pi-image"

### down
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" down`
- **Args:** none
- **Does:** Ends the spoke session and frees its state. Idempotent — always safe to call at the end.
- **Triggers:** "finished generating", "close the image session"

### clean
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" clean`
- **Args:** none
- **Does:** Kills a stale/leftover spoke process and clears session state.
- **Triggers:** "spoke stuck", "clean up pi-image", "stale session"

## Workflow

### Phase 1: Resolve the request
1. From USER_INPUT build a single natural-language request naming an ABSOLUTE out_path (and input_path for an edit).
2. If no absolute path is given, ask the user for one before sending.

### Phase 2: Drive the spoke
1. One image → run the `generate` tool. Several images in one run → run `up`, then `send` per image, then `down`.
2. The call is synchronous (1–2 min/image); do not poll or re-run it.
3. Parse the LAST JSON line and branch (see Cookbook).

## Cookbook

### Image concluded
- **IF:** a tool prints `kind:"result"`
- **THEN:** if `status=="ok"`, report `out_path` + `bytes`; if `"failed"`, surface `error`. A one-shot `generate` already auto-ended; after `up`/`send`, run the `down` tool when finished.
- **EXAMPLES:** "result status:ok", "image saved"

### Spoke asks a question
- **IF:** a tool prints `kind:"reply"`
- **THEN:** read its `text` (usually it needs an absolute out_path or input_path); resolve it and answer with the `send` tool. Repeat until `kind:"result"`.
- **EXAMPLES:** "needs an absolute out_path", "which file should I edit?"

### Spoke won't start / stuck
- **IF:** a tool prints `kind:"error"` with reason `spawn_failed` / `ready_timeout` / `spoke_down` / `timeout`
- **THEN:** run the `clean` tool, surface the `detail` (point at `<stateDir>/logs/image.log`), and retry once.
- **EXAMPLES:** "spoke did not start", "no result within N min"

### Batch of images (warm reuse)
- **IF:** the request needs several images (e.g. a plan's hero + per-phase slots)
- **THEN:** run `up` once, run the `send` tool per image, then `down` at the end — one boot, many cheap images.
- **EXAMPLES:** "fill all the plan images", "generate 6 icons"

## Supporting Files

- `tools/session.ts` - RPC driver (run with bun): `generate` / `up` / `send` / `down` / `clean`
- `tools/lib.ts` - spoke locator, pi spawn argv, JSONL framing, notify-marker contract

## Report

- Relay the spoke's result faithfully: a job succeeded ONLY when the line is `kind:"result"` AND `status=="ok"` — report its `out_path` and `bytes`. On anything else, report it as failed and surface `error` (or the `reply` text).
- When several images were generated, list each path.
