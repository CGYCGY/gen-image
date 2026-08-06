# The spec

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

Top level: `style` (optional), `images` (required, non-empty). Nothing else — an unknown key is a hard error, including near-misses like `styles` or `outpath`.

## Per-image fields

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

## Big or quote-heavy specs — use `--stdin`

`--stdin` and an argv spec are mutually exclusive.

```bash
cat >/tmp/spec.json <<'JSON'
{"style":["icon"],"images":[{"prompt":"…","out_path":"/abs/a.png"}]}
JSON
bun "${GEN_IMAGE_DIR:-$HOME/.gen-image}/cli/render.ts" --stdin </tmp/spec.json
```

Write the spec with the Write tool if it is long. Do not hand-escape a paragraph of prose into a single-quoted shell argument.
