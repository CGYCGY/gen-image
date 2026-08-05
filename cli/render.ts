#!/usr/bin/env bun
/**
 * cli/render.ts — THE entrypoint. A JSON spec in, N concurrent renders, one JSON line out.
 *
 *   bun <repo>/cli/render.ts '<json spec>'     spec as argv
 *   bun <repo>/cli/render.ts --stdin           spec on stdin (use for big payloads)
 *   bun <repo>/cli/render.ts --dry-run '<json>'
 *   bun <repo>/cli/render.ts --list-styles
 *
 * There is no model anywhere in this path: the caller already knows the params, so nothing has
 * to be inferred from prose. That is what makes "N images requested, N results returned" a
 * property of the code rather than a hope.
 *
 * Two rules the rest of the file exists to keep:
 *  - The WHOLE spec is validated before ANY render starts. A bad spec renders nothing, so a
 *    caller can fix it and re-run without wondering which half already happened.
 *  - stdout carries exactly one line, the final JSON. Progress, logs and codex chatter go to
 *    stderr and the log file, because a caller parses the last stdout line.
 */

import { createLogger, type Logger } from "../shared/log.ts";
import { prepareOutPath, validateInputPath, validateOutPath } from "../shared/sandbox.ts";
import {
  listStyles,
  logResolution,
  logResolutionFailure,
  type Resolution,
  resolveStyles,
} from "../shared/styles.ts";
import type { ImageJobResult } from "../shared/types.ts";
import { resolveBackend } from "../image/backends/index.ts";
import { renderImage, type RenderDeps, type RenderRequest } from "../image/render.ts";

const USAGE =
  "usage: render.ts '<json spec>' | --stdin | --dry-run '<json spec>' | --list-styles\n" +
  'spec: {"style":["watercolor"],"images":[{"prompt":"…","out_path":"/abs/a.png"}]}';

export type ErrorReason = "bad_spec" | "unknown_style" | "bad_args" | "config_error";

export interface PlanEntry {
  op: "generate" | "edit";
  out_path: string;
  styles: string[];
  prompt_preview: string;
}

export type Out =
  | { kind: "results"; results: ImageJobResult[] }
  | { kind: "plan"; images: PlanEntry[] }
  | { kind: "styles"; looks: string[]; forms: string[] }
  | { kind: "error"; reason: ErrorReason; detail: string };

/** A verdict reached before any render — nothing was produced, so the caller gets exit 2. */
class SpecError extends Error {
  constructor(
    readonly reason: ErrorReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * `0` every image ok, `1` at least one failed, `2` nothing was rendered. The distinction that
 * matters to a script: 2 means "your spec is wrong, nothing happened", 1 means "some images
 * exist, read the results".
 */
export function exitCodeOf(out: Out): number {
  if (out.kind === "error") return 2;
  if (out.kind !== "results") return 0;
  return out.results.every((r) => r.status === "ok") ? 0 : 1;
}

// ---------------------------------------------------------------------------- spec validation

const TOP_KEYS = new Set(["style", "images"]);
const IMAGE_KEYS = new Set([
  "op",
  "prompt",
  "instruction",
  "input_path",
  "out_path",
  "size",
  "quality",
  "backend",
  "style",
]);

function asRecord(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new SpecError("bad_spec", `${where} must be a JSON object.`);
  }
  return v as Record<string, unknown>;
}

function optText(o: Record<string, unknown>, key: string, where: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new SpecError("bad_spec", `${where}.${key} must be a non-empty string.`);
  }
  return v.trim();
}

function requireText(o: Record<string, unknown>, key: string, where: string): string {
  const v = optText(o, key, where);
  if (v === undefined) throw new SpecError("bad_spec", `${where}.${key} is required.`);
  return v;
}

function rejectUnknown(o: Record<string, unknown>, allowed: Set<string>, where: string): void {
  // Strict on purpose: a mistyped key (`styles`, `outpath`) that is merely ignored produces an
  // image nobody asked for, which is exactly the silent divergence this spec exists to prevent.
  const stray = Object.keys(o).filter((k) => !allowed.has(k));
  if (stray.length > 0) {
    throw new SpecError("bad_spec", `${where}: unknown key(s) ${stray.join(", ")}. Allowed: ${[...allowed].join(", ")}.`);
  }
}

/** A style list: `["a","b"]`, or a bare `"a"` for the single-style case. Order is precedence. */
function styleNames(v: unknown, where: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v) || v.some((n) => typeof n !== "string" || n.trim().length === 0)) {
    throw new SpecError("bad_spec", `${where}.style must be a string or an array of style names.`);
  }
  return (v as string[]).map((n) => n.trim());
}

/** One validated image: what to render, plus what the dry-run plan needs to describe it. */
export interface Job {
  request: RenderRequest;
  styles: string[];
  /** The caller's own text, before the style block was prepended. */
  preview: string;
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

/**
 * Resolve style names once per distinct list. Many images in a batch share the top-level list,
 * and re-reading + re-logging the same files N times says nothing the first resolution didn't.
 */
function styleResolver(): (names: string[]) => Resolution | undefined {
  const cache = new Map<string, Resolution>();
  return (names) => {
    if (names.length === 0) return undefined;
    const key = JSON.stringify(names);
    const hit = cache.get(key);
    if (hit) return hit;
    let res: Resolution;
    try {
      res = resolveStyles(names);
    } catch (err) {
      const detail = (err as Error).message;
      // A failed lookup is a record of a preset someone wanted and we don't have.
      logResolutionFailure(names, detail);
      throw new SpecError(detail.startsWith("unknown style") ? "unknown_style" : "bad_spec", detail);
    }
    logResolution(res);
    cache.set(key, res);
    return res;
  };
}

/**
 * Validate the whole spec and build the render jobs. Throws SpecError on the first problem —
 * every check here is pure (path guards included), so a rejected spec leaves no trace on disk.
 */
export function buildJobs(spec: unknown): Job[] {
  const root = asRecord(spec, "spec");
  rejectUnknown(root, TOP_KEYS, "spec");
  const topStyles = styleNames(root.style, "spec") ?? [];
  const images = root.images;
  if (!Array.isArray(images) || images.length === 0) {
    throw new SpecError("bad_spec", "spec.images must be a non-empty array.");
  }

  const styleFor = styleResolver();
  const seen = new Map<string, number>();
  return images.map((raw, i) => {
    const where = `images[${i}]`;
    const img = asRecord(raw, where);
    rejectUnknown(img, IMAGE_KEYS, where);

    const op = optText(img, "op", where) ?? "generate";
    if (op !== "generate" && op !== "edit") {
      throw new SpecError("bad_spec", `${where}.op must be "generate" or "edit" (got "${op}").`);
    }
    // Fields belonging to the OTHER op are rejected rather than ignored: silently dropping the
    // caller's text is how an image comes back rendered from something it never asked for.
    const wrongField = op === "generate" ? (["instruction", "input_path"] as const) : (["prompt"] as const);
    for (const k of wrongField) {
      if (img[k] !== undefined) {
        throw new SpecError("bad_spec", `${where}: op "${op}" does not take ${k}.`);
      }
    }

    let outPath: string;
    try {
      outPath = validateOutPath(img.out_path as string);
    } catch (err) {
      throw new SpecError("bad_spec", `${where}: ${(err as Error).message}`);
    }
    const dup = seen.get(outPath);
    if (dup !== undefined) {
      // Two images landing on one path means one of them is lost, and which one depends on
      // render order — so the batch is wrong before it starts, not after.
      throw new SpecError("bad_spec", `${where}.out_path duplicates images[${dup}]: ${outPath}`);
    }
    seen.set(outPath, i);

    const names = styleNames(img.style, where) ?? topStyles; // per-image REPLACES, never merges
    const styleText = styleFor(names)?.text ?? "";
    const prefix = styleText ? `${styleText}\n\n` : "";

    const size = optText(img, "size", where);
    const quality = optText(img, "quality", where);
    const backend = optText(img, "backend", where);
    if (backend !== undefined) {
      try {
        resolveBackend(backend);
      } catch (err) {
        throw new SpecError("bad_spec", `${where}: ${(err as Error).message}`);
      }
    }

    if (op === "generate") {
      const prompt = requireText(img, "prompt", where);
      return {
        request: { op, prompt: prefix + prompt, outPath, size, quality, backend },
        styles: names,
        preview: preview(prompt),
      };
    }
    const instruction = requireText(img, "instruction", where);
    let inputPath: string;
    try {
      inputPath = validateInputPath(img.input_path as string);
    } catch (err) {
      throw new SpecError("bad_spec", `${where}: ${(err as Error).message}`);
    }
    return {
      request: { op, instruction: prefix + instruction, inputPath, outPath, size, quality, backend },
      styles: names,
      preview: preview(instruction),
    };
  });
}

function parseSpecText(text: string): unknown {
  const t = text.trim();
  if (!t) throw new SpecError("bad_spec", "the spec is empty.");
  try {
    return JSON.parse(t);
  } catch (err) {
    throw new SpecError("bad_spec", `the spec is not valid JSON: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------- execution

export interface CliDeps {
  log?: Logger;
  /** Human-facing progress; the real entrypoint sends it to stderr. */
  note?: (message: string) => void;
  /** Test seam: stands in for the real engine so a unit test never spends a render. */
  render?: (req: RenderRequest, deps: RenderDeps) => Promise<ImageJobResult>;
}

/**
 * Dispatch every image at once and collect results in REQUEST order.
 *
 * No second concurrency cap here on purpose: the backend's machine-wide semaphore
 * (`maxConcurrentRenders`) is the one ceiling, and it queues rather than fails. A cap in the CLI
 * too would throttle against a limit it cannot see the other holders of.
 */
async function renderAll(jobs: Job[], deps: CliDeps): Promise<ImageJobResult[]> {
  const log = deps.log ?? createLogger("image");
  const note = deps.note ?? (() => {});
  const engine = deps.render ?? renderImage;
  const n = jobs.length;
  log.info("batch started", { images: n });

  return Promise.all(
    jobs.map(async (job, i) => {
      const tag = `[${i + 1}/${n}]`;
      const renderDeps: RenderDeps = { log, onProgress: (m) => note(`${tag} ${m}`) };
      note(`${tag} ${job.request.op} → ${job.request.outPath}`);
      let result: ImageJobResult;
      try {
        result = await engine(job.request, renderDeps);
      } catch (err) {
        // renderImage resolves rather than throws for a failed render, so reaching here means an
        // unexpected defect. It still must not cost the caller the batch's other images.
        result = {
          status: "failed",
          op: job.request.op,
          out_path: job.request.outPath,
          error: `unexpected render error: ${(err as Error).message}`,
        };
        log.error("render threw", { outPath: job.request.outPath, error: (err as Error).message });
      }
      note(
        result.status === "ok"
          ? `${tag} ok ${result.out_path} (${result.bytes} bytes)`
          : `${tag} FAILED ${result.out_path}: ${result.error}`,
      );
      return result;
    }),
  );
}

interface Args {
  mode: "render" | "dry-run" | "list-styles";
  fromStdin: boolean;
  specText?: string;
}

export function parseArgs(argv: string[]): Args {
  let mode: Args["mode"] = "render";
  let fromStdin = false;
  let specText: string | undefined;
  for (const arg of argv) {
    if (arg === "--dry-run") mode = "dry-run";
    else if (arg === "--list-styles") mode = "list-styles";
    else if (arg === "--stdin") fromStdin = true;
    else if (arg.startsWith("-")) throw new SpecError("bad_args", `unknown option "${arg}".\n${USAGE}`);
    else if (specText !== undefined) throw new SpecError("bad_args", `unexpected extra argument "${arg}".\n${USAGE}`);
    else specText = arg;
  }
  if (mode === "list-styles") return { mode, fromStdin: false };
  if (fromStdin && specText !== undefined) {
    throw new SpecError("bad_args", `pass the spec as an argument OR on --stdin, not both.\n${USAGE}`);
  }
  if (!fromStdin && specText === undefined) throw new SpecError("bad_args", `no spec given.\n${USAGE}`);
  return { mode, fromStdin, specText };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The whole run as a value: one Out, no process exit, so it is directly testable. */
export async function run(argv: string[], deps: CliDeps = {}): Promise<Out> {
  try {
    const args = parseArgs(argv);
    if (args.mode === "list-styles") {
      const { looks, forms } = listStyles();
      return { kind: "styles", looks, forms };
    }
    const jobs = buildJobs(parseSpecText(args.fromStdin ? await readStdin() : args.specText!));
    if (args.mode === "dry-run") {
      return {
        kind: "plan",
        images: jobs.map((j) => ({
          op: j.request.op,
          out_path: j.request.outPath,
          styles: j.styles,
          prompt_preview: j.preview,
        })),
      };
    }
    // The one disk side effect that validation deliberately skipped, done only now that the
    // entire spec has passed: a rejected spec must not leave empty directories behind.
    for (const job of jobs) {
      try {
        prepareOutPath(job.request.outPath);
      } catch (err) {
        return { kind: "error", reason: "bad_spec", detail: `cannot create the parent dir for ${job.request.outPath}: ${(err as Error).message}` };
      }
    }
    return { kind: "results", results: await renderAll(jobs, deps) };
  } catch (err) {
    if (err instanceof SpecError) return { kind: "error", reason: err.reason, detail: err.message };
    return { kind: "error", reason: "config_error", detail: (err as Error).message };
  }
}

if (import.meta.main) {
  const out = await run(process.argv.slice(2), { note: (m) => process.stderr.write(`${m}\n`) });
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(exitCodeOf(out));
}
