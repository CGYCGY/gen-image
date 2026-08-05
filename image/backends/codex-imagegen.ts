/**
 * image/backends/codex-imagegen.ts — gpt-image-2 via the Codex CLI's built-in image_gen.
 *
 * WHY shell out to `codex exec` instead of calling the OpenAI Images API: the built-in
 * image_gen tool bills the ChatGPT/Codex SUBSCRIPTION (no OPENAI_API_KEY), whereas the
 * Images API is key-billed. The codex CLI is the only way to reach that subscription path.
 *
 * The built-in tool does NOT let us choose the output filename — it writes under
 * $CODEX_HOME/generated_images/<session>/, and the basename varies by driver model (`call_*.png`
 * on a direct tool call, `exec-*.png` via code mode). So we detect what it produced and deliver it
 * ourselves, deterministically, rather than trusting the codex agent to report or move it
 * (the agent's own `cp` would also be sandbox-bound, which an arbitrary caller out_path can
 * fall outside of).
 *
 * Detection is fail-closed at three levels, because a wrong image delivered as a success is the
 * one failure nothing downstream can catch: it is scoped to THIS run's codex session dir (whose id
 * we read off the `--json` event stream), MORE than one candidate in that dir is treated as
 * ambiguous rather than resolved by recency, and the chosen source is then claimed exactly once
 * machine-wide (claims.ts). There is deliberately NO cross-session fallback — an unidentifiable
 * session fails the run loudly, because the only alternative, newest image anywhere under
 * generated_images, hands a sibling run's image to this caller whenever two runs overlap.
 */

import { copyFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { basename, extname, join } from "node:path";

import sharp from "sharp";

import type { OutputConfig } from "../../shared/config.ts";
import { baseRules } from "../../shared/styles.ts";
import { runCommand } from "../../shared/subprocess.ts";
import { terminalError } from "../../shared/types.ts";

import { claimSource } from "./claims.ts";
import { acquireRenderSlot } from "./semaphore.ts";
import type { BackendCtx, BackendResult, EditParams, GenerateParams, ImageBackend } from "./types.ts";

const BACKEND_ID = "gpt-image-2";
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A format we can both name in a path and write bytes for. "preserve" is resolved before this. */
type DeliveredFormat = "png" | "jpeg" | "webp";

const EXT_TO_FORMAT: Record<string, DeliveredFormat> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
};
const FORMAT_TO_EXT: Record<DeliveredFormat, string> = { png: ".png", jpeg: ".jpg", webp: ".webp" };

/** A slot cannot legitimately outlive the run's own SIGKILL ceiling; past that it is abandoned. */
const SLOT_HOLD_MARGIN_MS = 60_000;

/** One `codex exec --json` JSONL event; only the fields we consume are modelled. */
interface CodexEvent {
  /** From `thread.started`. Older codex builds called the same id `session_id`. */
  thread_id?: string;
  session_id?: string;
  item?: { type?: string; text?: string };
  error?: { message?: string };
}

/** Where the built-in image_gen writes by default. */
function generatedRoot(codexHome: string): string {
  return join(codexHome, "generated_images");
}

/**
 * Images in one session dir at/after `afterMs`, newest first. The afterMs floor is what lets us
 * tell a fresh render from a stale leftover: if nothing newer exists, codex produced no image
 * (failure), so we never silently copy an old one.
 */
function candidatesInDir(dir: string, afterMs: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: { path: string; mtime: number }[] = [];
  for (const f of entries) {
    if (!IMAGE_RE.test(f)) continue;
    const fp = join(dir, f);
    let fstat;
    try {
      fstat = statSync(fp);
    } catch {
      continue;
    }
    if (fstat.mtimeMs >= afterMs) found.push({ path: fp, mtime: fstat.mtimeMs });
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.map((c) => c.path);
}

/** Parse `codex exec --json` stdout. Non-JSON lines (e.g. "Reading additional input from
 * stdin...") are interleaved on stdout, so unparseable lines are skipped rather than fatal. */
function parseEvents(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      events.push(JSON.parse(s) as CodexEvent);
    } catch {
      continue;
    }
  }
  return events;
}

/** The run's codex session id — the `generated_images` subdir is named exactly this. */
function sessionIdOf(events: CodexEvent[]): string | undefined {
  for (const e of events) {
    const id = e.thread_id ?? e.session_id;
    if (typeof id === "string" && UUID_RE.test(id)) return id;
  }
  return undefined;
}

/** Best available explanation of a failed run: what the agent said, else raw output. */
function failureTail(events: CodexEvent[], stdout: string, stderr: string): string {
  const said: string[] = [];
  for (const e of events) {
    if (e.error?.message) said.push(e.error.message);
    if (e.item?.type === "agent_message" && e.item.text) said.push(e.item.text);
  }
  const text = said.join("\n").trim() || stderr.trim() || stdout.trim();
  return text.slice(-600) || "(empty)";
}

function formatOfPath(p: string): DeliveredFormat | undefined {
  return EXT_TO_FORMAT[extname(p).toLowerCase()];
}

/** Same path with the extension that matches `format`; a no-op when it already does. */
function pathForFormat(p: string, format: DeliveredFormat): string {
  if (formatOfPath(p) === format) return p;
  const ext = extname(p);
  return (ext ? p.slice(0, -ext.length) : p) + FORMAT_TO_EXT[format];
}

/**
 * Put `source` at `dest`. Moving is the point (§4b: codex never prunes generated_images, so a
 * copy leaves every image on disk twice forever); `keep` retains it while the source files are
 * still the evidence trail for a mis-delivery. Returns whether the source is already gone —
 * rename cannot lose bytes, whereas a copy must be verified before the source is removed.
 */
function place(source: string, dest: string, keep: boolean): boolean {
  if (!keep) {
    try {
      renameSync(source, dest);
      return true;
    } catch (err) {
      // CODEX_HOME and an arbitrary caller out_path are routinely on different filesystems.
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    }
  }
  copyFileSync(source, dest);
  return false;
}

function verifyBytes(path: string, expected?: number): number {
  const bytes = statSync(path).size;
  if (bytes === 0) throw new Error(`delivered file is empty: ${path}`);
  if (expected !== undefined && bytes !== expected) {
    throw new Error(`delivered file is ${bytes} bytes, expected ${expected}: ${path}`);
  }
  return bytes;
}

async function encodeTo(source: string, dest: string, format: DeliveredFormat, cfg: OutputConfig): Promise<void> {
  const img = sharp(source);
  if (format === "webp") await img.webp({ quality: cfg.quality, effort: cfg.effort }).toFile(dest);
  else if (format === "jpeg") await img.jpeg({ quality: cfg.quality }).toFile(dest);
  else await img.png({ compressionLevel: 9 }).toFile(dest);
  // Decode what we just wrote: a size check cannot tell a real webp from PNG bytes under a
  // .webp name, which is exactly the defect this step exists to make impossible.
  const meta = await sharp(dest).metadata();
  if (meta.format !== format) throw new Error(`encoded ${dest} decodes as ${meta.format ?? "unknown"}, not ${format}`);
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Nothing to undo.
  }
}

export interface Delivered {
  outPath: string;
  bytes: number;
  format: DeliveredFormat;
  requestedPath?: string;
  warning?: string;
}

/**
 * The whole "codex produced a file → the caller gets a file" transition.
 *
 * THE INVARIANT: the bytes at the returned outPath always match its extension — on every path,
 * including the failure ones. Where that conflicts with the caller's chosen filename, the
 * filename gives way (and the original comes back as `requestedPath`), because a `.webp` holding
 * PNG bytes is a lie that every downstream consumer inherits.
 */
export async function deliver(source: string, requested: string, ctx: BackendCtx): Promise<Delivered> {
  const sourceFormat = formatOfPath(source) ?? "png";
  const sourceBytes = statSync(source).size;
  const target = ctx.output.format === "preserve" ? (formatOfPath(requested) ?? sourceFormat) : ctx.output.format;
  const outPath = pathForFormat(requested, target);
  const requestedPath = outPath === requested ? undefined : requested;

  // Same format in and out: never re-encode. PNG→PNG would be a pointless generation loss on the
  // one path where the caller explicitly asked for what codex produced.
  if (target === sourceFormat) {
    const moved = place(source, outPath, ctx.keepSourceImages);
    const bytes = verifyBytes(outPath, sourceBytes);
    if (!ctx.keepSourceImages && !moved) removeIfPresent(source);
    return { outPath, bytes, format: target, requestedPath };
  }

  try {
    await encodeTo(source, outPath, target, ctx.output);
    const bytes = verifyBytes(outPath);
    if (!ctx.keepSourceImages) removeIfPresent(source);
    return { outPath, bytes, format: target, requestedPath };
  } catch (err) {
    // A completed render is never discarded over a failed re-encode — but it is delivered under
    // an extension that tells the truth about its bytes, which may not be the one asked for.
    removeIfPresent(outPath); // a partial encode must not survive as a plausible-looking file
    const fallbackPath = pathForFormat(requested, sourceFormat);
    const moved = place(source, fallbackPath, ctx.keepSourceImages);
    const bytes = verifyBytes(fallbackPath, sourceBytes);
    if (!ctx.keepSourceImages && !moved) removeIfPresent(source);
    return {
      outPath: fallbackPath,
      bytes,
      format: sourceFormat,
      requestedPath: fallbackPath === requested ? undefined : requested,
      warning:
        `Could not encode to ${target} (${(err as Error).message}); delivered the original ` +
        `${sourceFormat} at ${fallbackPath} instead.`,
    };
  }
}

/**
 * The always-on rules (styles/base.md), injected HERE rather than in a style preset or the
 * caller's prompt: no preset can omit them and no calling agent can forget them. Placed after the
 * request and before the operational trailer, so they read as constraints on the content.
 */
function baseBlock(): string {
  return `\n\nRules that apply to every render:\n${baseRules()}`;
}

function hints(size?: string, quality?: string): string {
  const lines: string[] = [];
  if (size) lines.push(`Aim for a ${size} composition (the built-in tool sizes approximately).`);
  if (quality) lines.push(`Render at ${quality} quality with clean, high detail.`);
  return lines.length ? `\n${lines.join("\n")}` : "";
}

/** Base codex exec argv (without the prompt / attachments). */
function baseArgs(ctx: BackendCtx): string[] {
  // --skip-git-repo-check: codex exec otherwise refuses outside a trusted/git dir, and our
  // cwd ($CODEX_HOME) is neither. Image gen doesn't touch the repo, so the check is moot here.
  // --json: codex ≥0.146 no longer prints the human-readable "session id: <uuid>" header we
  // used to scrape, and we cannot attribute an image without that id. The JSONL event stream
  // (`thread.started` → thread_id) is the machine contract and carries the final agent message too.
  const a = ["exec", "--skip-git-repo-check", "--json", "--sandbox", ctx.codex.sandbox];
  // The built-in image_gen call reaches Codex's backend over the network; a workspace-write
  // run needs network explicitly enabled (mirrors the proven manual invocation).
  if (ctx.codex.network && ctx.codex.sandbox === "workspace-write") {
    a.push("-c", "sandbox_workspace_write.network_access=true");
  }
  // Pin the model so a change to the user's codex default can't silently swap it.
  a.push("-c", `model=${ctx.codex.model}`);
  return a;
}

async function runCodex(ctx: BackendCtx, args: string[], outPath: string, op: string): Promise<BackendResult> {
  const root = generatedRoot(ctx.codex.home);
  // Held across delivery too: the extra ~400 ms is nothing against a ~120 s render, and releasing
  // early would let a queued run start before this one has claimed its source.
  const slot = await acquireRenderSlot({
    stateDir: ctx.stateDir,
    max: ctx.maxConcurrentRenders,
    maxHoldMs: ctx.codex.timeoutMs + SLOT_HOLD_MARGIN_MS,
    log: ctx.log,
    onWait: (m) => ctx.onProgress?.(m),
  });
  try {
    const start = Date.now() - 2000; // small floor for clock skew between this process and file mtimes
    ctx.onProgress?.(`codex ${op} via ${BACKEND_ID} (subscription)…`);
    const startedAt = Date.now();
    const r = await runCommand(ctx.codex.bin, args, {
      cwd: ctx.codex.home, // a stable, writable cwd; the real output goes to generated_images
      env: { CODEX_HOME: ctx.codex.home },
      timeoutMs: ctx.codex.timeoutMs,
    });
    // Logged for every run, not just slow ones: the timeout is a judgement call with one data
    // point behind it, and only a duration distribution can replace that with a number.
    const durationMs = Date.now() - startedAt;
    ctx.log.info("codex run finished", { op, durationMs, waitedMs: slot.waitedMs, exit: r.code, timedOut: r.timedOut });

    const events = parseEvents(r.stdout);
    const tail = () => failureTail(events, r.stdout, r.stderr);
    // Checked BEFORE detection: a killed run has no image because we stopped it, and reporting
    // that as "produced no image" sends the reader hunting a detection bug that isn't there.
    if (r.timedOut) {
      throw new Error(
        `codex ${op} timed out after ${Math.round(ctx.codex.timeoutMs / 1000)}s and was killed ` +
          `(codex.timeoutMs). Tail: ${tail()}`,
      );
    }
    // Without the session id every candidate image is unattributable, so failing here is the
    // whole point: concurrent runs share generated_images and picking the newest one across all
    // of them silently returns a sibling's image.
    const sessionId = sessionIdOf(events);
    if (!sessionId) {
      throw new Error(`codex exec reported no session id (exit ${r.code ?? "none"}). Tail: ${tail()}`);
    }
    // The session dir is authoritative: empty means THIS run produced nothing, even if a sibling
    // just did.
    const sessionDir = join(root, sessionId);
    const candidates = candidatesInDir(sessionDir, start);
    const produced = candidates[0];
    ctx.log.info("codex render detected", { op, sessionId, candidates: candidates.length, src: produced ?? null, outPath });
    if (!produced) {
      throw new Error(`codex produced no image in session ${sessionId} (exit ${r.code ?? "none"}). Tail: ${tail()}`);
    }
    // Recency is not evidence of ownership. Two images in one session dir means the run rendered
    // twice (or something else wrote there), and picking one would be a coin flip presented as a
    // fact — the same shape of mistake as the cross-session fallback that used to live here.
    if (candidates.length > 1) {
      throw terminalError(
        `codex session ${sessionId} holds ${candidates.length} images since the run started ` +
          `(${candidates.map((c) => basename(c)).join(", ")}); which one belongs to this request is ` +
          `ambiguous, so nothing was delivered.`,
      );
    }
    claimSource(ctx.stateDir, produced, { op, sessionId, outPath });

    const d = await deliver(produced, outPath, ctx);
    if (!ctx.keepSourceImages) {
      try {
        // Non-recursive on purpose: other codex usage writes here, and a dir that is not empty
        // must survive untouched rather than be swept.
        rmdirSync(sessionDir);
      } catch {
        // Not empty, or already gone.
      }
    }
    ctx.log.info("image produced", {
      op,
      src: basename(produced),
      outPath: d.outPath,
      format: d.format,
      bytes: d.bytes,
      durationMs,
      ...(d.warning ? { warning: d.warning } : {}),
    });
    return {
      backend: BACKEND_ID,
      model: ctx.codex.model,
      outPath: d.outPath,
      bytes: d.bytes,
      format: d.format,
      requestedPath: d.requestedPath,
      warning: d.warning,
    };
  } finally {
    slot.release();
  }
}

export const codexImagegenBackend: ImageBackend = {
  id: BACKEND_ID,
  label: "Codex built-in image_gen (gpt-image-2, ChatGPT/Codex subscription)",
  subscription: true,

  async generate({ prompt, outPath, size, quality }, ctx) {
    const instruction =
      `Use $imagegen (the built-in image_gen tool — NOT the CLI script, NOT OPENAI_API_KEY) ` +
      `to generate this image:\n\n${prompt}${hints(size, quality)}${baseBlock()}\n\n` +
      `This is a preview render: generate with the built-in tool and then stop. Do not write ` +
      `code, do not use the CLI fallback, and do not move or copy the file.`;
    return runCodex(ctx, [...baseArgs(ctx), instruction], outPath, "generate");
  },

  async edit({ instruction, inputPath, outPath, size, quality }, ctx) {
    const message =
      `Use $imagegen (the built-in image_gen tool — NOT the CLI script, NOT OPENAI_API_KEY) ` +
      `to edit the attached image:\n\n${instruction}${hints(size, quality)}${baseBlock()}\n\n` +
      `Preserve everything not mentioned. Generate with the built-in tool and then stop; do ` +
      `not move or copy the file.`;
    // -i attaches the source so the built-in edit flow can see it (built-in edit operates on
    // images visible in the conversation context). `--` is REQUIRED: codex declares
    // `-i, --image <FILE>...` as variadic, so without it the prompt is parsed as a second
    // filename and codex falls back to an empty stdin ("No prompt provided via stdin").
    return runCodex(ctx, [...baseArgs(ctx), "-i", inputPath, "--", message], outPath, "edit");
  },
};
