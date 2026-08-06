# Reading the result

The LAST line of stdout is the whole answer. Everything else on stdout and stderr is progress.

```json
{"kind":"results","results":[
  {"status":"ok","op":"generate","backend":"gpt-image-2","model":"gpt-5.6-sol",
   "out_path":"/abs/dir/fox.webp","format":"webp","requested_path":"/abs/dir/fox.png","bytes":98213},
  {"status":"failed","op":"generate","backend":"gpt-image-2","out_path":"/abs/dir/boat.png",
   "error":"codex produced no image in session … Tail: …","attempts":2}
]}
```

## Rules for using it

- **One entry per requested image, in REQUEST order.** Match by index or by `out_path`; both are safe. A short array cannot happen.
- **Report the returned `out_path`, never the one you asked for.** If you write `![](fox.png)` next to a file called `fox.webp`, the link is broken.
- **`requested_path` present means delivery rewrote the extension** to match the bytes actually written (the install is configured to deliver a different format). The bytes at `out_path` always match `out_path`'s extension. Use `out_path` everywhere and mention the rewrite once.
- **`warning` is a non-fatal degradation on a successful image.** Surface it verbatim; do not paraphrase it away.
- **`attempts` means it already retried in code.** Do not re-run that image because of it. It is a health signal worth passing on, not an action item.
- **Mixed ok/failed is normal.** Keep the successes, re-request only the failed `out_path`s, and report the error text for anything that failed twice.

## Other kinds

- `{"kind":"plan","images":[…]}` from `--dry-run`
- `{"kind":"styles","looks":[…],"forms":[…]}` from `--list-styles`
- `{"kind":"error","reason":"…","detail":"…"}` when nothing was rendered. `reason` is one of `bad_spec`, `unknown_style`, `bad_args`, `config_error`.

## Exit codes

| Code | Meaning | Your next move |
| --- | --- | --- |
| `0` | every image ok | report the paths |
| `1` | at least one image failed; the rest exist | keep the good ones, re-request the failed paths once, then report the error |
| `2` | spec / usage / config error — **nothing rendered, no image file written** | read `detail`, fix the spec, re-run the whole thing. Safe: there is no partial batch to reconcile |
