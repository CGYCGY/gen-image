# Styles

An ordered list of names. Resolution rules:

- **Last wins.** `["infographic","poster"]` is a landscape headline poster; reversed it is a portrait infographic. Order is precedence, not decoration.
- **Per-image `style` REPLACES the top-level list.** It never merges. To render one image with no styles at all inside a styled batch, give it `"style": []`.
- **Omitting `style` prepends nothing.** That is a legitimate choice for a plain photographic or literal render.
- **An unknown name fails the whole spec loudly and prints the available set.** So guess the name you want; a wrong guess self-corrects in one round trip. You never need `--list-styles` first.

## Available names

Two axes, one flat namespace — pass a bare name and it resolves either way.

- **Looks** (medium, palette, mark-making): `blueprint`, `cartoon`, `chalkboard`, `claymation`, `comic`, `embroidery`, `hand-drawn`, `isometric`, `litho`, `neon`, `papercraft`, `pixel-art`, `ukiyo-e`, `watercolor`
- **Forms** (artifact kind, layout, orientation, text policy): `diagram`, `icon`, `infographic`, `poster`, `sticker`

`--list-styles` is authoritative if this list has drifted.
