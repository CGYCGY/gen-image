---
name: gen-image
description: Generate or edit real image files with gpt-image-2 on the Codex/ChatGPT subscription (no API key, no cloud creds). Use when asked to generate, create, make, draw or render an image, icon, logo, illustration, poster, diagram, infographic, sticker or picture; when asked to edit an existing image; or when a plan, document or page you are building has image slots to fill. One call renders many images concurrently.
allowed-tools: Bash, Read
user-invocable: true
---

# gen-image

A render CLI, not an agent. You hand it a JSON spec; it validates the whole spec, renders every
image concurrently, and prints ONE JSON line with ONE result per requested image, in REQUEST order.
There is no model in its path — nothing you write gets reinterpreted, and N images in always
produces N results out.

## The command

```bash
bun "${GEN_IMAGE_DIR:-$HOME/.gen-image}/cli/render.ts" '<json spec>'
```

`$HOME/.gen-image` is the install location. `GEN_IMAGE_DIR` is a plain shell override for a
checkout somewhere else — the shell expands it, so write the command exactly as above and it works
either way.

Modes:

| Form | Effect |
| --- | --- |
| `render.ts '<json>'` | render |
| `render.ts --stdin` | read the spec from stdin — use for anything over a few hundred characters, or any prompt containing quotes |
| `render.ts --dry-run '<json>'` | validate + report the plan, render nothing, spend no quota |
| `render.ts --list-styles` | print the available style names |

`--stdin` and an argv spec are mutually exclusive.

## The spec

```json
{
  "style": ["watercolor", "poster"],
  "images": [
    {"prompt": "a red fox curled asleep in snow, soft morning light",
     "out_path": "/abs/dir/fox.png"},

    {"prompt": "a lighthouse in fog",
     "out_path": "/abs/dir/lighthouse.png",
     "size": "1536x1024", "quality": "high"},

    {"prompt": "a paper boat on a puddle",
     "out_path": "/abs/dir/boat.png",
     "style": ["pixel-art"]},

    {"op": "edit",
     "input_path": "/abs/dir/fox.png",
     "instruction": "add a small knitted hat, change nothing else",
     "out_path": "/abs/dir/fox-hat.png"}
  ]
}
```

Top level: `style` (optional), `images` (required, non-empty). Nothing else — an unknown key is a
hard error, including near-misses like `styles` or `outpath`.

Per image:

| Field | Required | Notes |
| --- | --- | --- |
| `op` | no | `"generate"` (default) or `"edit"` |
| `prompt` | generate only | the description. Passing it on an `edit` is an error |
| `instruction` | edit only | what to change. Passing it on a `generate` is an error |
| `input_path` | edit only | absolute, must already exist, `.png`/`.jpg`/`.jpeg`/`.webp` |
| `out_path` | yes | absolute, ends `.png`/`.jpg`/`.jpeg`/`.webp`. Parent dirs are created for you. Must be unique within the spec |
| `size` | no | composition hint, e.g. `"1536x1024"`. Pasted into the render prompt as prose — honoured approximately, never guaranteed |
| `quality` | no | render hint, e.g. `"high"`. Also prose. Unrelated to the install's encoder quality |
| `style` | no | replaces the top-level list for this image |
| `backend` | no | only `gpt-image-2` exists and it is the default. Omit it |

Write prompts as full descriptions — subject, composition, lighting, palette, mood. The prompt goes
to the renderer verbatim (with the style block prepended); no one is going to improve it first.

## Styles

An ordered list of names. Resolution rules:

- **Last wins.** `["infographic","poster"]` is a landscape headline poster; reversed it is a
  portrait infographic. Order is precedence, not decoration.
- **Per-image `style` REPLACES the top-level list.** It never merges. To render one image with no
  styles at all inside a styled batch, give it `"style": []`.
- **Omitting `style` prepends nothing.** That is a legitimate choice for a plain photographic or
  literal render.
- **An unknown name fails the whole spec loudly and prints the available set.** So guess the name
  you want; a wrong guess self-corrects in one round trip. You never need `--list-styles` first.

Two axes, one flat namespace — pass a bare name and it resolves either way. Looks (medium, palette,
mark-making): `blueprint`, `cartoon`, `chalkboard`, `claymation`, `comic`, `embroidery`,
`hand-drawn`, `isometric`, `litho`, `neon`, `papercraft`, `pixel-art`, `ukiyo-e`, `watercolor`.
Forms (artifact kind, layout, orientation, text policy): `diagram`, `icon`, `infographic`,
`poster`, `sticker`. `--list-styles` is authoritative if this list has drifted.

## Big or quote-heavy specs — use `--stdin`

```bash
cat >/tmp/spec.json <<'JSON'
{"style":["icon"],"images":[{"prompt":"…","out_path":"/abs/a.png"}]}
JSON
bun "${GEN_IMAGE_DIR:-$HOME/.gen-image}/cli/render.ts" --stdin </tmp/spec.json
```

Write the spec with the Write tool if it is long. Do not hand-escape a paragraph of prose into a
single-quoted shell argument.

## Reading the result

The LAST line of stdout is the whole answer. Everything else on stdout and stderr is progress.

```json
{"kind":"results","results":[
  {"status":"ok","op":"generate","backend":"gpt-image-2","model":"gpt-5.6-sol",
   "out_path":"/abs/dir/fox.webp","format":"webp","requested_path":"/abs/dir/fox.png","bytes":98213},
  {"status":"failed","op":"generate","backend":"gpt-image-2","out_path":"/abs/dir/boat.png",
   "error":"codex produced no image in session … Tail: …","attempts":2}
]}
```

Rules for using it:

- **One entry per requested image, in REQUEST order.** Match by index or by `out_path`; both are
  safe. A short array cannot happen.
- **Report the returned `out_path`, never the one you asked for.** If you write
  `![](fox.png)` next to a file called `fox.webp`, the link is broken.
- **`requested_path` present means delivery rewrote the extension** to match the bytes actually
  written (the install is configured to deliver a different format). The bytes at `out_path` always
  match `out_path`'s extension. Use `out_path` everywhere and mention the rewrite once.
- **`warning` is a non-fatal degradation on a successful image.** Surface it verbatim; do not
  paraphrase it away.
- **`attempts` means it already retried in code.** Do not re-run that image because of it. It is a
  health signal worth passing on, not an action item.
- **Mixed ok/failed is normal.** Keep the successes, re-request only the failed `out_path`s, and
  report the error text for anything that failed twice.
- Other kinds: `{"kind":"plan","images":[…]}` from `--dry-run`, `{"kind":"styles","looks":[…],
  "forms":[…]}` from `--list-styles`, and `{"kind":"error","reason":"…","detail":"…"}` when nothing
  was rendered.

## Exit codes

| Code | Meaning | Your next move |
| --- | --- | --- |
| `0` | every image ok | report the paths |
| `1` | at least one image failed; the rest exist | keep the good ones, re-request the failed paths once, then report the error |
| `2` | spec / usage / config error — **nothing rendered, no image file written** | read `detail`, fix the spec, re-run the whole thing. Safe: there is no partial batch to reconcile |

`reason` on a `kind:"error"` is one of `bad_spec`, `unknown_style`, `bad_args`, `config_error`.

## Timing and the one rule you must not break

The call is **synchronous** and slow: roughly 1–2 minutes, whether you asked for one image or
twelve — a batch renders concurrently, so its wall-clock is about one render's.

- **Put every image you need into ONE call.** Fanning out N processes for N images buys nothing,
  because the concurrency is already inside the call, and it multiplies the ways the batch can go
  wrong. A spec larger than the install's `maxConcurrentRenders` does not fail — the excess queues
  for a slot — so size the batch by what you need, not by a guessed ceiling.
- **Raise the Bash tool timeout** — pass `timeout: 600000` on the call. The default 2 minutes will
  cut off a legitimate render.
- **Never poll it, never kill it, never re-run it because it feels slow.** There is no job store,
  no resume, and no way to see a partial batch. A run killed at 90 seconds has burned the quota and
  produced nothing. Waiting is the correct behaviour, always.
- Queueing is normal: a busy machine makes renders wait for a slot rather than fail, and the wait
  shows up on stderr.

## Paths

`out_path` and `input_path` must be **absolute**. The CLI's working directory is not yours, so a
relative path is rejected outright rather than resolved somewhere surprising.

If the user has not said where the images go, ask before rendering. Do not invent a destination and
do not default to a temp dir for something they will want to keep — a two-minute render landing in
the wrong place is worse than one question.
