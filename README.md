# pi-image

A standalone, **heavily-gated single-purpose** image-generation service built on [pi](../pi-references).
A caller **summons** it over pi's native RPC mode and **converses** with it in plain language —
*"generate a red fox in snow, save to /abs/fox.png"* / *"edit /abs/fox.png to add a hat, save to
/abs/fox2.png"* — and the spoke's own LLM extracts the intent, runs exactly one verb, and returns a
structured result. Images are produced by the **Codex CLI's built-in `image_gen`** on your
ChatGPT/Codex subscription (no `OPENAI_API_KEY`); backends are pluggable. Sibling to
`pi-deployment-manager`; see [`docs/DESIGN.md`](./docs/DESIGN.md) for the architecture and rationale.

## Requirements

- **`codex`** on PATH, signed in with ChatGPT (Codex subscription). The default `gpt-image-2` backend
  shells out to it; no `OPENAI_API_KEY` is needed or used.
- **`pi`** (`@earendil-works/pi-coding-agent`) on PATH and authenticated for the `openai-codex`
  provider. `pi --list-models` should show `openai-codex/gpt-5.6-terra`.
- **`bun`** to run the extension and the smoke test.

## Quickstart

```bash
cp config.json.example config.json   # adjust if your codex home/model differ
bun install

# end-to-end RPC smoke test: summons the spoke, sends one generate request, verifies the file
bun test/rpc-smoke.ts --out /abs/path/out.png --prompt "a cute cartoon water droplet, kawaii style"
```

With no flags the smoke test writes `./pi-image-smoke.png` with a default prompt. Exit codes: `0` ok
result + file present, `1` failed/question, `2` timeout.

## The two verbs

This is the **complete** tool surface the spoke LLM sees — pi's built-in `bash`/`read`/`write`/`edit`/`glob`
are gated off (`--no-builtin-tools` + `setActiveTools`). The wrong action is *unrepresentable*.

| Verb | Purpose | Params |
| --- | --- | --- |
| `generate_image` | Create a NEW image and save it to an absolute `out_path` (parent dirs auto-created). | `prompt`, `out_path`, `size?`, `quality?`, `backend?` |
| `edit_image` | Edit an EXISTING image (`input_path`) into `out_path`, preserving everything not mentioned. | `instruction`, `input_path`, `out_path`, `size?`, `quality?`, `backend?` |

Paths must be **absolute** and end in `.png`/`.jpg`/`.jpeg`/`.webp`; `input_path` must exist. A missing
absolute path makes the spoke **stop and ask** rather than invent one.

## RPC protocol contract (for callers)

1. **Spawn** pi in rpc mode with the extension and pin the model:

   ```bash
   pi --no-extensions --no-builtin-tools -nc --no-session --mode rpc \
      -e image/index.ts --name pi-image:rpc \
      --model openai-codex/gpt-5.6-terra --thinking high
   ```

2. **Wait for READY.** The spoke emits an `extension_ui_request` with `method: "notify"` whose text
   starts with `PIIMAGE_READY`. Only then is it booted and listening.

3. **Send a prompt** on stdin (one JSONL object per line):

   ```json
   {"type":"prompt","id":"req-1","message":"Generate this image and save it to /abs/out.png: a red fox in snow, soft morning light"}
   ```

4. **Read the RESULT.** A concluded job emits a notify whose text is `PIIMAGE_RESULT <json>`, where
   `<json>` is the `ImageJobResult`:

   ```json
   {"status":"ok","op":"generate","backend":"gpt-image-2","model":"gpt-5.6-sol","out_path":"/abs/out.png","bytes":482931}
   ```

   On failure: `{"status":"failed","op":"generate","backend":"gpt-image-2","out_path":"/abs/out.png","error":"<reason>"}`.

   The result is **built in code** from what the backend actually produced — never parsed from the
   spoke's prose. A turn that ends **without** a `PIIMAGE_RESULT` means the spoke asked a question
   (e.g. a missing absolute path); read the last assistant text and reply with another `prompt`.

5. **Reuse the session** for every image in one run, then close it (`{"type":"abort"}` / kill the
   process). Keeping it warm amortizes startup; see *warm-spoke economy* in the design doc.

## Configuration

`config.json` (gitignored; copy from `config.json.example`). Every field has a default, but real RPC
runs should set `model`/`thinking` so the spoke model is pinned. pi-image holds **no cloud
creds** — generation rides the Codex subscription via the local `codex` CLI.

| Field | Default | Meaning |
| --- | --- | --- |
| `stateDir` | `~/.pi-image` | Logs (`<stateDir>/logs/image.log`) and RPC session state. |
| `model` | `openai-codex/gpt-5.6-terra` | The pi **spoke** (orchestrator) model. `openai-codex/*` is subscription-backed. |
| `thinking` | `high` | Spoke reasoning tier. |
| `maxConcurrentRenders` | `20` | Ceiling on concurrent renders, enforced **machine-wide** by a semaphore in `stateDir` — every terminal, agent and session shares it. Excess callers **queue**, never fail. A tuning limit (provider throttling + local RAM), not a correctness mechanism. |
| `keepSourceImages` | `false` | Keep codex's own copy under `generated_images/` after delivery. `false` makes delivery a **move**, so codex stops accumulating a duplicate of every image ever rendered. Set `true` to keep the sources as an evidence trail while investigating a mis-delivery. |
| `output.format` | `preserve` | `preserve` honours the `out_path` extension; `webp`/`png`/`jpeg` rewrite it (the real path comes back as `out_path`, the original as `requested_path`). **The bytes at `out_path` always match its extension.** |
| `output.quality` | `80` | Encoder quality, 1–100, lossy formats only. Distinct from the verbs' `quality` *render* hint. |
| `output.effort` | `6` | libwebp method, 0–6. Higher is smaller and slower. |
| `codex.bin` | `codex` | The codex executable (on PATH or absolute). |
| `codex.model` | `gpt-5.6-sol` | Model codex drives `image_gen` with (not the renderer — gpt-image-2 renders either way). Pinned so a changed codex default can't swap it. Avoid `code_mode_only` models (terra/luna): they can't emit a direct tool call and burn extra shell round-trips. |
| `codex.home` | `~/.codex` | `CODEX_HOME`; also where `image_gen` writes (`generated_images/`). |
| `codex.sandbox` | `workspace-write` | `codex --sandbox` mode for the exec run. |
| `codex.network` | `true` | Enable network for the workspace-write run (`image_gen` reaches Codex's backend). |
| `codex.timeoutMs` | `900000` | Hard cap for one `codex exec` (image gen + reasoning). A backstop against a hung codex, not an operating limit. |

## Backends

Pluggable registry in `image/backends/`. **Adding a backend = drop one file** implementing the
`ImageBackend` interface (`generate`/`edit`) + one line in `backends/index.ts`. The verbs never change.

| Backend | Billing | Status |
| --- | --- | --- |
| `gpt-image-2` (default) | **Codex/ChatGPT subscription** — shells `codex exec`, no API key | built |
| Gemini "Nano Banana" (Vertex AI) | **API key** | future |
| OpenAI Images API (direct) | **API key** | future |

> **Subscription does not generalize.** Only the Codex-backed default is subscription-billed (the
> entire reason it shells out to `codex` instead of calling the Images API). Every other backend has
> its own auth/billing reality — Gemini via Vertex and the OpenAI Images API are **API-key-billed**,
> and a Codex-backed spoke cannot borrow a Gemini subscription. The `ImageBackend.subscription`
> boolean records this per backend. Pass a non-default `backend` only when the caller names one.

## Project layout

```
pi-image/
├── package.json · tsconfig.json · config.json.example · config.json (gitignored) · .gitignore
├── .pi/APPEND_SYSTEM.md          harness system-prompt note
├── shared/
│   ├── config.ts                 loads config.json (stateDir, model, thinking, codex{...})
│   ├── log.ts                    file logger → <stateDir>/logs/image.log
│   ├── types.ts                  Role, READY/RESULT marks, PI_NAME, ImageJobResult
│   ├── sandbox.ts                validateOutPath / validateInputPath (absolute + image-ext guards)
│   └── subprocess.ts             runCommand (the one place it shells out)
├── image/
│   ├── index.ts                  the extension: persona, session_start gate + READY, agent_end compaction
│   ├── tools.ts                  the two verbs; concludeJob emits RESULT
│   └── backends/
│       ├── types.ts              ImageBackend interface
│       ├── codex-imagegen.ts     gpt-image-2 backend (codex exec → image_gen) + deliver()
│       ├── claims.ts             claim each codex source image exactly once, machine-wide
│       ├── semaphore.ts          state-dir render slots (maxConcurrentRenders; excess queues)
│       └── index.ts              registry / resolveBackend
├── .claude/skills/gen-image/    driver skill: callers invoke this to reach the spoke over RPC
│   ├── SKILL.md                  generate / send / up / down / clean tools (+ cookbook)
│   └── tools/{session.ts,lib.ts} the RPC driver (warm spoke, FIFO bridge, READY/RESULT)
└── test/rpc-smoke.ts            end-to-end RPC smoke test
```

## Driver skill (gen-image)

Callers don't spawn `pi` themselves — they use the bundled **gen-image** skill at `.claude/skills/gen-image/`, the analog of `deploy-via-manager`. It owns the spawn → READY → prompt → RESULT dance and keeps the spoke **warm** across a run:

```bash
GENI="bun .claude/skills/gen-image/tools/session.ts"
$GENI generate "a red fox mascot, flat vector. Save it to /abs/fox.png"   # one-shot
# sequential batch on one warm spoke (one boot, many images):
$GENI up; $GENI send "...save to /abs/a.png"; $GENI send "...save to /abs/b.png"; $GENI down
# parallel batch — each bare `generate` gets its own isolated ephemeral session, so N images
# take the wall-clock of one (~2 min); named sessions via --session <id> work too:
$GENI generate "...save to /abs/a.png" & $GENI generate "...save to /abs/b.png" & wait
```

### Installing the skill globally

The driver resolves this checkout through a fallback chain — `PI_IMAGE_DIR` env var → skill-local
`config.json {imageDir}` → self-location (when the skill runs from inside this repo). Pick the rung
that fits the machine:

- **Symlink (preferred on Linux/macOS/WSL).** One source of truth, zero config — self-location
  resolves through the realpathed link, so edits in the repo are live globally:

  ```bash
  ln -s /abs/path/to/pi-image/.claude/skills/gen-image ~/.claude/skills/gen-image
  ```

- **Copy + `config.json` (Windows, or git/library-distributed installs).** Windows symlinks need
  admin or Developer Mode and git checkouts mangle them, so copy the skill directory and add
  `{"imageDir": "/abs/path/to/pi-image"}` next to its `SKILL.md` (see `config.json.example`).
  `PI_IMAGE_DIR` overrides both for one-off runs against a different checkout.

Either way the machine still needs the [requirements](#requirements) — the skill is a thin driver,
not a hermetic bundle.

## Troubleshooting

- **"codex produced no image" / "Not inside a trusted directory".** The backend already passes
  `--skip-git-repo-check` and runs from `CODEX_HOME`, so the trusted-dir check is handled. A genuine
  "no image" means codex returned no new file under `generated_images/`; check the error tail in the
  RESULT and `<stateDir>/logs/image.log`, and confirm `codex` is signed in.
- **No `PIIMAGE_RESULT`, just a question.** The spoke is missing a required **absolute** path. Reply
  with a `prompt` that names an absolute `out_path` (and `input_path` for edits).
- **Spoke won't boot.** Confirm `pi --list-models` shows the configured `model` and that `codex` is
  signed in to the Codex subscription. Without the provider authenticated the spoke can't start.
- **Image lands in the wrong place / unexpected format.** `out_path` must be absolute and end in a
  supported extension; otherwise the verb throws before doing any work and the spoke asks again.
