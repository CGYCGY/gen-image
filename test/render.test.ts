// The engine: result assembly and the retry policy. A stub backend stands in for codex, so
// these run offline and cost nothing.

import { describe, expect, test } from "bun:test";

import { okBackendResult, outPath, silentLog, stubBackend } from "./helpers.ts";
import { renderImage } from "../image/render.ts";
import { terminalError } from "../shared/types.ts";

const deps = (backend: ReturnType<typeof stubBackend>) => ({
  log: silentLog,
  resolveBackend: () => backend,
});

describe("result assembly", () => {
  test("an ok render reports everything the backend derived", async () => {
    const p = outPath("a.webp");
    const backend = stubBackend((_a, out) =>
      okBackendResult(out, { format: "webp", bytes: 1234, requestedPath: outPath("a.png"), warning: "degraded" }),
    );
    const r = await renderImage({ op: "generate", prompt: "a fox", outPath: p }, deps(backend));
    expect(r).toEqual({
      status: "ok",
      op: "generate",
      backend: "stub",
      model: "stub-model",
      out_path: p,
      format: "webp",
      requested_path: outPath("a.png"),
      bytes: 1234,
      warning: "degraded",
    });
  });

  test("a first-attempt success reports no attempts count", async () => {
    const r = await renderImage({ op: "generate", prompt: "a", outPath: outPath("a.png") }, deps(stubBackend()));
    expect(r.attempts).toBeUndefined();
  });

  test("an edit passes its instruction and input through", async () => {
    const backend = stubBackend();
    const r = await renderImage(
      { op: "edit", instruction: "brighter", inputPath: outPath("src.png"), outPath: outPath("b.png") },
      deps(backend),
    );
    expect(r.op).toBe("edit");
    expect(backend.calls).toEqual([{ op: "edit", outPath: outPath("b.png"), text: "brighter" }]);
  });
});

describe("retry policy", () => {
  test("a transient failure retries and the result says so", async () => {
    const backend = stubBackend((attempt, out) => {
      if (attempt === 1) throw new Error("codex produced no image");
      return okBackendResult(out);
    });
    const r = await renderImage({ op: "generate", prompt: "a", outPath: outPath("a.png") }, deps(backend));
    expect(r.status).toBe("ok");
    // A retried image that ends up ok still says so — otherwise a backend failing half the time
    // reads as perfectly healthy.
    expect(r.attempts).toBe(2);
    expect(backend.calls).toHaveLength(2);
  });

  test("exhausting the budget returns a structured failure, never a throw", async () => {
    const backend = stubBackend(() => {
      throw new Error("codex exec timed out");
    });
    const p = outPath("a.png");
    const r = await renderImage({ op: "generate", prompt: "a", outPath: p }, deps(backend));
    expect(r).toEqual({
      status: "failed",
      op: "generate",
      backend: "stub",
      out_path: p,
      error: "codex exec timed out",
      attempts: 2, // maxRetries 1 in the test config
    });
  });

  test("a terminal failure is not retried — it is a safety verdict, not a flaky render", async () => {
    const backend = stubBackend(() => {
      throw terminalError("source was already claimed");
    });
    const r = await renderImage({ op: "generate", prompt: "a", outPath: outPath("a.png") }, deps(backend));
    expect(r.status).toBe("failed");
    expect(backend.calls).toHaveLength(1);
    expect(r.attempts).toBeUndefined();
  });
});
