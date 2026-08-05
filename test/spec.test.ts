// Spec validation. Every case goes through --dry-run, which validates exactly what a real run
// validates but cannot render anything, so a mistake in these tests cannot spend a render.

import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { outPath, silentLog } from "./helpers.ts";
import { exitCodeOf, type Out, run } from "../cli/render.ts";

async function check(spec: unknown): Promise<Out> {
  return run(["--dry-run", JSON.stringify(spec)]);
}

function expectBadSpec(out: Out, needle: string): void {
  expect(out.kind).toBe("error");
  if (out.kind !== "error") return;
  expect(out.reason).toBe("bad_spec");
  expect(out.detail).toContain(needle);
  expect(exitCodeOf(out)).toBe(2);
}

const gen = (over: Record<string, unknown> = {}) => ({
  images: [{ prompt: "a fox", out_path: outPath("a.png"), ...over }],
});

describe("spec validation", () => {
  test("a generate needs a prompt", async () => {
    expectBadSpec(await check({ images: [{ out_path: outPath("a.png") }] }), "prompt is required");
  });

  test("out_path must be absolute", async () => {
    expectBadSpec(await check(gen({ out_path: "relative/a.png" })), "absolute");
  });

  test("out_path must be an image", async () => {
    expectBadSpec(await check(gen({ out_path: outPath("a.txt") })), ".png/.jpg/.jpeg/.webp");
  });

  test("out_path is required", async () => {
    expectBadSpec(await check({ images: [{ prompt: "a fox" }] }), "out_path is required");
  });

  test("two images may not share an out_path", async () => {
    const p = outPath("dup.png");
    const out = await check({ images: [{ prompt: "a", out_path: p }, { prompt: "b", out_path: p }] });
    expectBadSpec(out, "duplicates images[0]");
  });

  test("the duplicate guard compares resolved paths", async () => {
    const out = await check({
      images: [
        { prompt: "a", out_path: outPath("dup2.png") },
        { prompt: "b", out_path: outPath("nested/../dup2.png") },
      ],
    });
    expectBadSpec(out, "duplicates images[0]");
  });

  test("op must be generate or edit", async () => {
    expectBadSpec(await check(gen({ op: "paint" })), 'op must be "generate" or "edit"');
  });

  test("an edit needs input_path and instruction", async () => {
    expectBadSpec(
      await check({ images: [{ op: "edit", instruction: "brighter", out_path: outPath("b.png") }] }),
      "input_path is required",
    );
    expectBadSpec(
      await check({ images: [{ op: "edit", input_path: outPath("missing.png"), out_path: outPath("b.png") }] }),
      "instruction is required",
    );
  });

  test("an edit's input_path must exist", async () => {
    expectBadSpec(
      await check({
        images: [{ op: "edit", instruction: "brighter", input_path: outPath("nope.png"), out_path: outPath("b.png") }],
      }),
      "does not exist",
    );
  });

  test("fields belonging to the other op are rejected, not ignored", async () => {
    expectBadSpec(await check(gen({ instruction: "brighter" })), 'op "generate" does not take instruction');
  });

  test("unknown keys are rejected", async () => {
    expectBadSpec(await check(gen({ styles: ["watercolor"] })), "unknown key(s) styles");
    expectBadSpec(await check({ images: [], style: [], extra: 1 }), "unknown key(s) extra");
  });

  test("images must be a non-empty array", async () => {
    expectBadSpec(await check({ images: [] }), "non-empty array");
    expectBadSpec(await check({}), "non-empty array");
  });

  test("an unknown backend is caught before rendering", async () => {
    expectBadSpec(await check(gen({ backend: "dall-e-0" })), 'unknown backend "dall-e-0"');
  });

  test("malformed JSON is a spec error", async () => {
    const out = await run(["--dry-run", "{not json"]);
    expectBadSpec(out, "not valid JSON");
  });

  test("an unknown style names the available set", async () => {
    const out = await check({ style: ["nonesuch"], images: [{ prompt: "a", out_path: outPath("a.png") }] });
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.reason).toBe("unknown_style");
    expect(out.detail).toContain("Available looks:");
    expect(exitCodeOf(out)).toBe(2);
  });

  test("one bad image renders NOTHING, not the good ones", async () => {
    let rendered = 0;
    const dir = outPath("never");
    const out = await run(
      [
        JSON.stringify({
          images: [
            { prompt: "fine", out_path: `${dir}/ok.png` },
            { prompt: "broken", out_path: "not/absolute.png" },
          ],
        }),
      ],
      {
        log: silentLog,
        render: async (req) => {
          rendered += 1;
          return { status: "ok", op: req.op, out_path: req.outPath };
        },
      },
    );
    expect(out.kind).toBe("error");
    expect(rendered).toBe(0);
    // Validation is pure: a rejected spec must not even leave the destination dir behind.
    expect(existsSync(dir)).toBe(false);
  });
});
