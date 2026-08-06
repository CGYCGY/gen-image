---
name: gen-image
description: Generate or edit real image files with gpt-image-2 on the Codex/ChatGPT subscription (no API key, no cloud creds). Use when asked to generate, create, make, draw or render an image, icon, logo, illustration, poster, diagram, infographic, sticker or picture; when asked to edit an existing image; or when a plan, document or page you are building has image slots to fill.
allowed-tools: Bash, Read, Write
user-invocable: true
---

# gen-image

## Purpose

Render or edit image files by handing a JSON spec to a render CLI — it validates the whole spec, renders every image concurrently, and prints ONE JSON line with ONE result per requested image, in REQUEST order. There is no model in its path: nothing you write gets reinterpreted, and N images in always produces N results out.

## Instructions

### Batching and timing — the one rule you must not break

- Put every image you need into ONE call. Concurrency is already inside the call — fanning out N processes for N images buys nothing and multiplies the ways the batch can go wrong. A spec larger than the install's `maxConcurrentRenders` does not fail; the excess queues for a slot, so size the batch by what you need, not by a guessed ceiling.
- The call is synchronous and slow: roughly 1–2 minutes whether you asked for one image or twelve (a batch renders concurrently, so its wall-clock is about one render's). Raise the Bash tool timeout — pass `timeout: 600000`. The default 2 minutes will cut off a legitimate render.
- Never poll it, never kill it, never re-run it because it feels slow. There is no job store, no resume, and no way to see a partial batch — a run killed at 90 seconds has burned the quota and produced nothing. Waiting is the correct behaviour, always.
- Queueing is normal: a busy machine makes renders wait for a slot rather than fail, and the wait shows up on stderr.

### Paths

- `out_path` and `input_path` must be absolute. The CLI's working directory is not yours, so a relative path is rejected outright rather than resolved somewhere surprising.
- If the user has not said where the images go, ask before rendering. Do not invent a destination and do not default to a temp dir for something they will want to keep — a two-minute render landing in the wrong place is worse than one question.

### Prompts and styles

- Write prompts as full descriptions — subject, composition, lighting, palette, mood. The prompt goes to the renderer verbatim (with the style block prepended); no one is going to improve it first.
- Styles are an ordered list of names: last wins, per-image `style` REPLACES the top-level list (never merges), omitting `style` prepends nothing, and an unknown name fails the whole spec loudly and prints the available set — so guess the name you want; you never need `--list-styles` first. Full resolution rules and the name list: **Read:** `reference/styles.md`

### Spec and results

- Compose the spec (top-level shape, per-image fields, full example, `--stdin` for big or quote-heavy specs): **Read:** `reference/spec.md`
- Parse the output (result JSON, reading rules, exit codes): **Read:** `reference/results.md` — the LAST line of stdout is the whole answer; everything else on stdout and stderr is progress.

## Tools

### render
- **Run:** `bun "${GEN_IMAGE_DIR:-$HOME/.gen-image}/cli/render.ts" '<json spec>'`
- **Args:** `spec (json string, positional)` — the render spec; mutually exclusive with `--stdin`
- **Args:** `--stdin (flag, optional)` — read the spec from stdin instead; use for anything over a few hundred characters, or any prompt containing quotes
- **Args:** `--dry-run (flag, optional)` — validate + report the plan, render nothing, spend no quota
- **Args:** `--list-styles (flag, optional)` — print the available style names
- **Does:** Validates the whole spec, renders every image concurrently, prints one JSON result line.
- **Triggers:** "generate an image", "create a logo", "edit this picture", "render these icons"

`$HOME/.gen-image` is the install location; `GEN_IMAGE_DIR` is a plain shell override for a checkout somewhere else — the shell expands it, so write the command exactly as above and it works either way. Implementation lives in the install, not in this skill's directory.

If that path does not exist, the runtime was never installed. `setup.sh` sits next to this file — `~/.claude/skills/gen-image/setup.sh` for a user-level install, `<project>/.claude/skills/gen-image/setup.sh` for a project one. Run it once with `-y` (it clones and builds the runtime, about a minute), then render. Tell the user if it reports that `codex` is missing or not logged in: only they can fix that, and every render fails until they do.

## Supporting Files

- `reference/spec.md` - Spec format: top-level shape, per-image field table, full example, `--stdin` usage
- `reference/styles.md` - Style resolution rules and the available style names
- `reference/results.md` - Result JSON shape, rules for using it, exit codes
- `setup.sh` - Installs and upgrades the runtime this skill drives; only needed when the install is missing or stale

## Report

- Report the returned `out_path` of each success, never the path you asked for (delivery may rewrite the extension).
- Surface any `warning` verbatim; report error text for anything that failed twice.
