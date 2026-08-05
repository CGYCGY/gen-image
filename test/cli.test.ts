// The CLI's output contract: one Out per invocation, results in REQUEST order, and the exit
// code a calling script branches on.

import { describe, expect, test } from "bun:test";

import { outPath, silentLog } from "./helpers.ts";
import { type CliDeps, exitCodeOf, type Out, run } from "../cli/render.ts";
import type { ImageJobResult } from "../shared/types.ts";

/** A fake engine whose per-image outcome (and delay) the test dictates. */
function engine(
  outcome: (index: number, out: string) => Partial<ImageJobResult> & { delayMs?: number } = () => ({}),
) {
  let index = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const started: string[] = [];
  const deps: CliDeps = {
    log: silentLog,
    render: async (req) => {
      const i = index++;
      started.push(req.outPath);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const { delayMs, ...over } = outcome(i, req.outPath);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      inFlight -= 1;
      return { status: "ok", op: req.op, out_path: req.outPath, bytes: 10, format: "png", ...over };
    },
  };
  return {
    deps,
    started,
    get peakInFlight() {
      return peakInFlight;
    },
  };
}

const spec = (n: number) => ({
  images: Array.from({ length: n }, (_, i) => ({ prompt: `image ${i}`, out_path: outPath(`batch-${i}.png`) })),
});

function results(out: Out): ImageJobResult[] {
  expect(out.kind).toBe("results");
  return out.kind === "results" ? out.results : [];
}

describe("batch execution", () => {
  test("every image is dispatched before any finishes", async () => {
    const rig = engine((i) => ({ delayMs: i === 0 ? 40 : 1 }));
    const out = await run([JSON.stringify(spec(5))], rig.deps);
    expect(results(out)).toHaveLength(5);
    expect(rig.peakInFlight).toBe(5);
  });

  test("results come back in REQUEST order even when completion order differs", async () => {
    // The first image finishes last: matching by index must still be safe.
    const out = await run([JSON.stringify(spec(3))], engine((i) => ({ delayMs: i === 0 ? 30 : 0 })).deps);
    expect(results(out).map((r) => r.out_path)).toEqual([
      outPath("batch-0.png"),
      outPath("batch-1.png"),
      outPath("batch-2.png"),
    ]);
  });

  test("all ok exits 0", async () => {
    const out = await run([JSON.stringify(spec(2))], engine().deps);
    expect(exitCodeOf(out)).toBe(0);
  });

  test("a partial batch is still results, and exits 1", async () => {
    const out = await run(
      [JSON.stringify(spec(3))],
      engine((i) => (i === 1 ? { status: "failed", error: "codex produced no image" } : {})).deps,
    );
    const rs = results(out);
    expect(rs.map((r) => r.status)).toEqual(["ok", "failed", "ok"]);
    expect(exitCodeOf(out)).toBe(1);
  });

  test("an engine that throws costs that image, not the batch", async () => {
    const out = await run([JSON.stringify(spec(2))], {
      log: silentLog,
      render: async (req) => {
        if (req.outPath.endsWith("batch-0.png")) throw new Error("boom");
        return { status: "ok", op: req.op, out_path: req.outPath };
      },
    });
    const rs = results(out);
    expect(rs[0]?.status).toBe("failed");
    expect(rs[0]?.error).toContain("boom");
    expect(rs[1]?.status).toBe("ok");
    expect(exitCodeOf(out)).toBe(1);
  });
});

describe("--dry-run", () => {
  test("describes each image and renders nothing", async () => {
    const rig = engine();
    const out = await run(["--dry-run", JSON.stringify({ style: ["watercolor"], ...spec(2) })], rig.deps);
    expect(out.kind).toBe("plan");
    if (out.kind !== "plan") return;
    expect(out.images).toEqual([
      { op: "generate", out_path: outPath("batch-0.png"), styles: ["watercolor"], prompt_preview: "image 0" },
      { op: "generate", out_path: outPath("batch-1.png"), styles: ["watercolor"], prompt_preview: "image 1" },
    ]);
    expect(rig.started).toHaveLength(0);
    expect(exitCodeOf(out)).toBe(0);
  });

  test("a long prompt is previewed, not echoed whole", async () => {
    const out = await run([
      "--dry-run",
      JSON.stringify({ images: [{ prompt: "x".repeat(500), out_path: outPath("a.png") }] }),
    ]);
    if (out.kind !== "plan") throw new Error("expected a plan");
    expect(out.images[0]?.prompt_preview).toHaveLength(158); // 157 + the ellipsis
  });
});

describe("--list-styles", () => {
  test("lists both axes and exits 0", async () => {
    const out = await run(["--list-styles"]);
    expect(out.kind).toBe("styles");
    if (out.kind !== "styles") return;
    expect(out.looks).toContain("watercolor");
    expect(out.forms).toContain("poster");
    expect(exitCodeOf(out)).toBe(0);
  });
});

describe("usage errors", () => {
  const bad = async (argv: string[], needle: string) => {
    const out = await run(argv);
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.reason).toBe("bad_args");
    expect(out.detail).toContain(needle);
    expect(exitCodeOf(out)).toBe(2);
  };

  test("no spec", () => bad([], "no spec given"));
  test("unknown option", () => bad(["--turbo", "{}"], 'unknown option "--turbo"'));
  test("two specs", () => bad(["{}", "{}"], "unexpected extra argument"));
  test("argv and --stdin together", () => bad(["--stdin", "{}"], "not both"));
});
