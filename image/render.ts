/**
 * image/render.ts — render ONE image and report a structured verdict.
 *
 * The whole engine surface: plain params in, exactly one ImageJobResult out, never a throw.
 * The backend (which drives the codex CLI) does the work; this module owns the retry policy and
 * turns whatever came back — including a failure — into the result the caller receives.
 *
 * Concurrency is the CALLER's business: N of these run at once and the machine-wide render
 * semaphore inside the backend does the throttling, so nothing here counts or queues.
 */

import { loadConfig } from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";
import { type ImageJobResult, isTerminal } from "../shared/types.ts";

import { resolveBackend as defaultResolveBackend } from "./backends/index.ts";
import type { BackendCtx, BackendResult, ImageBackend } from "./backends/types.ts";

/** One image to render. Paths are already validated+prepared; text already carries any style block. */
export type RenderRequest = {
  outPath: string;
  size?: string;
  quality?: string;
  /** Backend id; the registry default when unset. */
  backend?: string;
} & (
  | { op: "generate"; prompt: string }
  | { op: "edit"; instruction: string; inputPath: string }
);

export interface RenderDeps {
  log: Logger;
  /** Human-facing progress (the CLI writes it to stderr). NEVER the result channel. */
  onProgress?: (message: string) => void;
  /** Injection seam for tests, so a unit test never spends a real render. */
  resolveBackend?: (id?: string) => ImageBackend;
}

function backendCtx(deps: RenderDeps): BackendCtx {
  const cfg = loadConfig();
  return {
    log: deps.log,
    codex: cfg.codex,
    output: cfg.output,
    stateDir: cfg.stateDir,
    maxConcurrentRenders: cfg.maxConcurrentRenders,
    keepSourceImages: cfg.keepSourceImages,
    onProgress: (m) => {
      deps.log.debug(m);
      deps.onProgress?.(m);
    },
  };
}

/** Everything the backend derived in code. `bytes` and `format` always describe out_path. */
function resultOf(op: ImageJobResult["op"], r: BackendResult): ImageJobResult {
  return {
    status: "ok",
    op,
    backend: r.backend,
    model: r.model,
    out_path: r.outPath,
    format: r.format,
    requested_path: r.requestedPath,
    bytes: r.bytes,
    warning: r.warning,
  };
}

/**
 * Render, retrying a TRANSIENT failure up to `maxRetries` times, and return exactly one result
 * either way — one entry per requested image, whatever happens inside.
 *
 * Retrying lives HERE rather than with the caller because the caller's unit of work is a whole
 * batch: re-running it to rescue one flaky image would pay for every image in it again.
 * A terminal failure exits the loop immediately (see `terminalError`) — those are safety
 * verdicts, and a retry that happens to succeed mutes the alarm without fixing what tripped it.
 *
 * Every attempt is a fresh backend call with its own timeout, never a continuation: the failures
 * worth retrying (a hung codex we killed, a run that produced nothing) leave nothing to resume.
 */
async function renderWithRetry(
  deps: RenderDeps,
  op: ImageJobResult["op"],
  backendId: string,
  outPath: string,
  run: () => Promise<BackendResult>,
): Promise<ImageJobResult> {
  const maxRetries = loadConfig().maxRetries;
  let attempt = 0;
  let lastError = "";
  while (attempt < maxRetries + 1) {
    attempt += 1;
    try {
      const r = await run();
      return { ...resultOf(op, r), ...(attempt > 1 ? { attempts: attempt } : {}) };
    } catch (err) {
      lastError = (err as Error).message;
      if (isTerminal(err) || attempt > maxRetries) break;
      deps.log.info("render failed, retrying", { op, outPath, attempt, error: lastError });
    }
  }
  // A generation failure is TERMINAL for this image — return a structured failed result rather
  // than throwing, so a batch always gets a verdict per image and one bad render never costs
  // the caller the good ones.
  return {
    status: "failed",
    op,
    backend: backendId,
    out_path: outPath,
    error: lastError,
    ...(attempt > 1 ? { attempts: attempt } : {}),
  };
}

/** Render one request. Resolves to a result; rejects only if the backend id itself is unknown. */
export async function renderImage(req: RenderRequest, deps: RenderDeps): Promise<ImageJobResult> {
  const backend = (deps.resolveBackend ?? defaultResolveBackend)(req.backend);
  const ctx = backendCtx(deps);
  const { outPath, size, quality } = req;
  const run =
    req.op === "generate"
      ? () => backend.generate({ prompt: req.prompt, outPath, size, quality }, ctx)
      : () => backend.edit({ instruction: req.instruction, inputPath: req.inputPath, outPath, size, quality }, ctx);

  deps.log.info("render started", { op: req.op, backend: backend.id, outPath });
  const result = await renderWithRetry(deps, req.op, backend.id, outPath, run);
  deps.log.info("render concluded", {
    status: result.status,
    op: result.op,
    out: result.out_path,
    ...(result.attempts ? { attempts: result.attempts } : {}),
    ...(result.error ? { error: result.error } : {}),
  });
  return result;
}
