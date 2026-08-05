# gen-image

An image render service with no model in its path. A JSON spec goes in, N images render
concurrently, one JSON line comes out with one result per requested image in request order.
Rendering runs through the **Codex CLI's built-in `image_gen`** on a ChatGPT/Codex subscription —
no `OPENAI_API_KEY`, no cloud creds. Backends are pluggable.

Callers are agents: they read [`SKILL.md`](./SKILL.md), which `setup.sh` installs as a Claude Code
skill. Architecture and the reasoning behind every guard: [`docs/DESIGN.md`](./docs/DESIGN.md).

## setup.sh — the front door

Idempotent. Running it again is also the upgrade path. It:

1. **Locates or clones the checkout** — `--dir`, else `$GEN_IMAGE_DIR`, else the directory the
   script itself lives in if that is a checkout, else `$HOME/.gen-image`. Missing → `git clone`.
   Present and a clean git checkout on a branch with an `origin` → `git pull --ff-only`. Local
   changes, detached HEAD or no origin → warns and skips the update rather than touching your work.
2. **Preflights** `bun` (fatal if missing) and `codex` (warns, and asks whether to continue, if the
   binary is absent or `codex login status` fails — only you can log in).
3. **`bun install`** in the checkout (`sharp` builds native binaries here).
4. **Writes `config.json`** from `config.json.example`, prompting for the four keys worth choosing.
   An existing config is never clobbered without a yes.
5. **Installs the skill** — copies `SKILL.md` to `~/.claude/skills/gen-image/SKILL.md`.
6. Prints the resolved paths and a smoke command.

### Flags

```
-y, --yes                 non-interactive; take defaults, never prompt
    --dir <path>          checkout location (default: $GEN_IMAGE_DIR, else ~/.gen-image)
    --repo <url>          git URL to clone when the checkout is missing
                          (default: $GEN_IMAGE_REPO, else the upstream GitHub URL)
    --state-dir <path>    config.json stateDir
    --output-format <f>   config.json output.format (preserve | webp | png | jpeg)
    --max-concurrent <n>  config.json maxConcurrentRenders
    --codex-timeout <ms>  config.json codex.timeoutMs
    --project <path>      install the skill into <path>/.claude/skills/gen-image/
                          instead of ~/.claude/skills/gen-image/
    --no-skill            do not install the skill
-h, --help
```

The four config flags only apply when a config is actually written. With `-y` and an existing
`config.json` they are ignored with a warning — delete the file to regenerate it.

`GEN_IMAGE_CONFIG` (if set) redirects both setup and the CLI to a config outside the checkout.

### Fresh machine

```bash
git clone https://github.com/CGYCGY/gen-image.git ~/.gen-image
bash ~/.gen-image/setup.sh
codex login          # if setup said codex was not signed in
```

Non-interactive (CI, containers):

```bash
bash ~/.gen-image/setup.sh -y --output-format webp --max-concurrent 8
```

`setup.sh` run from a directory that is not a checkout will clone one for you, so
`bash setup.sh --dir /opt/gen-image` works from anywhere.

### Upgrade

```bash
bash ~/.gen-image/setup.sh          # pulls, reinstalls deps, refreshes the installed skill
```

Or `git pull` in the checkout — but then re-run `setup.sh` (or copy `SKILL.md` yourself) so the
installed skill is not left on an old revision, and `bun install` if dependencies moved.

### Smoke test

Renders nothing, spends no quota:

```bash
bun ~/.gen-image/cli/render.ts --dry-run \
  '{"images":[{"prompt":"a red circle","out_path":"/tmp/gen-image-smoke.png"}]}'
```

Expect one line starting `{"kind":"plan"`. For a real render that costs quota, `bun run live`
(`test/live-render.ts`) drives the CLI as a subprocess end to end.

## Requirements

- **`bun`** — the only runtime. There is no build step.
- **`codex`** on PATH and signed in (`codex login`) with a ChatGPT/Codex subscription. The default
  `gpt-image-2` backend shells out to it; this is the entire reason it does not call the Images API.
- **No API key.** `OPENAI_API_KEY` is neither read nor wanted.
- `git` only for cloning/updating.

## CLI

```bash
bun <repo>/cli/render.ts '<json spec>'     # spec as argv
bun <repo>/cli/render.ts --stdin           # spec on stdin (big payloads)
bun <repo>/cli/render.ts --dry-run '<json>'
bun <repo>/cli/render.ts --list-styles
```

stdout carries **exactly one line**: the final JSON. Progress, codex chatter and errors go to
stderr and `<stateDir>/logs/image.log`, so parsing the last stdout line is always safe.

| Output kind | When |
| --- | --- |
| `{"kind":"results","results":[…]}` | a render — one `ImageJobResult` per image, in REQUEST order |
| `{"kind":"plan","images":[…]}` | `--dry-run` |
| `{"kind":"styles","looks":[…],"forms":[…]}` | `--list-styles` |
| `{"kind":"error","reason":…,"detail":…}` | `bad_spec` / `unknown_style` / `bad_args` / `config_error` — nothing rendered |

Exit codes: `0` every image ok (or a successful dry-run/list), `1` at least one image failed,
`2` spec/usage/config error with nothing written.

The spec schema, style semantics and the caller-side rules live in [`SKILL.md`](./SKILL.md); it is
the reference for anyone (human or agent) driving the CLI.

## config.json

Gitignored; `config.json.example` is the committed template and carries the same notes inline.
Every key is optional — a missing or unparseable config falls back to all defaults rather than
failing.

| Key | Default | What it affects |
| --- | --- | --- |
| `stateDir` | `<repo>/state` | Where `logs/`, `claims/` and `render-slots/` live. `~` expands. See the constraint below. |
| `maxConcurrentRenders` | `20` (clamped 1–200) | Ceiling on concurrent renders, enforced **machine-wide** by an O_EXCL semaphore in `stateDir` — every process on the host shares it. Excess renders **queue**, never fail. This is the only cap; the CLI adds none. A tuning limit (provider throttling, and one `codex exec` subprocess' worth of RAM each), not a correctness mechanism. |
| `maxRetries` | `1` (clamped 0–5) | Extra renders allowed for ONE image after a failed attempt; `0` disables. Each retry is a fresh `codex exec` with its own timeout. Only **transient** failures retry — a claim collision or an ambiguous session never does, at any value. A result that took more than one attempt reports `attempts`. |
| `keepSourceImages` | `false` | Keep codex's own copy under `CODEX_HOME/generated_images/` after delivery. `false` makes delivery a **move**, which is what stops that directory growing ~2 MB per image forever. Set `true` to keep the sources as an evidence trail when investigating a suspected mis-delivery. |
| `output.format` | `preserve` | `preserve` honours the `out_path` extension; `webp`/`png`/`jpeg` rewrite it, and the caller's original comes back as `requested_path`. An unrecognised value silently falls back to `preserve`. **The bytes at `out_path` always match its extension.** |
| `output.quality` | `80` (1–100) | Encoder quality, lossy formats only. Distinct from an image's `quality` *render hint*, which is prose in the codex prompt. |
| `output.effort` | `6` (0–6) | libwebp method. Higher is smaller and slower. |
| `codex.bin` | `codex` | The codex executable — on PATH or absolute. |
| `codex.model` | `gpt-5.6-sol` | The model that **drives** `image_gen`, not the renderer (gpt-image-2 renders either way). Pinned so a changed codex default cannot swap it. Keep to a `code_mode` model: `code_mode_only` ones (terra/luna) cannot emit a direct tool call and burn ~50% more tokens for an identical image. |
| `codex.home` | `~/.codex` | `CODEX_HOME`; also where `image_gen` writes (`generated_images/`). |
| `codex.sandbox` | `workspace-write` | `codex --sandbox` mode for the exec run. |
| `codex.network` | `true` | Adds `sandbox_workspace_write.network_access=true` when sandbox is `workspace-write` — the built-in tool reaches Codex's backend over the network. |
| `codex.timeoutMs` | `900000` | Hard cap for one `codex exec`, after which it is SIGKILLed. A backstop against a hung codex, **not** an operating limit: generates land at 1–2 min, an edit was killed mid-render at a 5-min ceiling, and queued runs stretch further. |

Config is read once per process and cached.

## State — and one checkout per machine

`stateDir` (default `<repo>/state/`, gitignored) holds:

```
state/
├── logs/image.log        operational log; rotates at 2 MB × 5
├── logs/styles.jsonl     one line per style resolution: names, file shas, winning keys.
│                         No prompts. Backstop rotation at 50 MB × 2
├── claims/               O_EXCL claim per codex source image, pruned after 7 days
└── render-slots/         O_EXCL slot files; the machine-wide concurrency semaphore
```

`claims/` and `render-slots/` are **machine-wide arbitration**, and they live under the checkout by
default. So: **one checkout per machine.** Two checkouts rendering at the same time have two
independent registries — each arbitrates only against itself, `maxConcurrentRenders` becomes 2N,
and a cross-assignment between the two goes undetected, which is the one failure nothing downstream
catches. This is an accepted, documented constraint, not a bug. If a second checkout is genuinely
needed, point both `stateDir`s at the same directory. A container overrides `stateDir` to a mounted
volume for the same reason.

## Layout

```
gen-image/
├── SKILL.md                    the entire skill: one file, installed to ~/.claude/skills/gen-image/
├── setup.sh                    installer / upgrader
├── config.json.example         committed template (config.json is gitignored)
├── cli/render.ts               THE entrypoint: parse argv, validate the whole spec, render all, print one line
├── image/
│   ├── render.ts               render one image: retry policy + ImageJobResult assembly
│   └── backends/
│       ├── types.ts            the ImageBackend contract
│       ├── index.ts            registry / resolveBackend (fail-loud)
│       ├── codex-imagegen.ts   gpt-image-2 via `codex exec` + deliver()
│       ├── claims.ts           claim each codex source image exactly once, machine-wide
│       └── semaphore.ts        render slots (maxConcurrentRenders; excess queues)
├── shared/
│   ├── config.ts               config.json + defaults; self-locates PROJECT_DIR
│   ├── log.ts                  file logger + jsonl appender, both size-rotated
│   ├── types.ts                ImageJobResult, terminalError
│   ├── sandbox.ts              validateOutPath / validateInputPath / prepareOutPath
│   ├── styles.ts               style vocabulary: parse, classify, merge
│   └── subprocess.ts           runCommand — the one place it shells out
├── styles/
│   ├── base.md                 rules injected into EVERY render by backend code
│   ├── looks/*.md              medium, palette, mark-making, texture
│   └── forms/*.md              artifact kind, layout, orientation, text policy
├── docs/DESIGN.md
└── test/                       unit tests (offline) + test/live-render.ts (spends quota)
```

`bun test` runs the offline suite; `bun run typecheck` runs `tsc --noEmit`.

## Troubleshooting

**codex not installed or not logged in.** Every render fails at the subprocess. `codex login status`
should print an account; if not, `npm i -g @openai/codex` then `codex login`. `setup.sh` checks this
and warns, but cannot do it for you.

**`codex produced no image in session <uuid>`.** Codex ran and returned, but wrote nothing into that
session's `generated_images/` directory. Read the error tail in the result (codex's own last
message) and `<stateDir>/logs/image.log`. Usual causes: not signed in, a refused prompt, or the
subscription's image quota. The trusted-directory check is already handled
(`--skip-git-repo-check`, cwd `CODEX_HOME`) — that is not this.

**`codex … timed out after Ns and was killed`.** It hit `codex.timeoutMs`. Distinct from "produced
no image" on purpose. Raise the ceiling if a legitimately slow edit or a deeply queued batch is
being cut off.

**`codex session … holds N images` / `codex source … was already claimed`.** Safety verdicts, not
flaky renders: two runs resolved to the same codex output, or one session produced more than one
candidate. Nothing was delivered and nothing retries. Check for a second checkout with its own
`state/` (see above) or a stray writer under `generated_images/`.

**The file has a different extension than requested.** `output.format` is not `preserve`, so
delivery rewrote it. `out_path` in the result is the real file; `requested_path` is what was asked
for. The bytes always match the extension — that invariant outranks the filename. Set
`output.format` to `preserve` to keep the caller's extension.

**A result carries `warning`.** The image landed, but a re-encode failed and the original PNG was
delivered under a `.png` path instead. Non-fatal, and the warning says exactly what happened.

**A failed entry carries `attempts`.** It already retried in code and failed again; re-running it
identically is unlikely to help. A *successful* result carrying `attempts` is a health signal — the
backend is failing part of the time and looks fine otherwise.

**Renders are slower than usual with no error.** All slots are busy; the wait is logged when it
starts and every 30 s after, in `image.log` and on stderr. Queueing never fails a render.

## Licence

MIT.
