/**
 * image/backends/codex-imagegen.ts — gpt-image-2 via the Codex CLI's built-in image_gen.
 *
 * WHY shell out to `codex exec` instead of calling the OpenAI Images API: the built-in
 * image_gen tool bills the ChatGPT/Codex SUBSCRIPTION (no OPENAI_API_KEY), whereas the
 * Images API is key-billed. pi itself has no image tool, so the subscription path is only
 * reachable through codex. The capability lives behind this verb's CODE — the pi spoke LLM
 * never reaches codex (pi principle #2).
 *
 * The built-in tool does NOT let us choose the output filename — it writes under
 * $CODEX_HOME/generated_images/<session>/ig_*.png. So we detect what it produced and copy it
 * ourselves, deterministically, rather than trusting the codex agent to report or move it
 * (the agent's own `cp` would also be sandbox-bound, which an arbitrary caller out_path can
 * fall outside of). Detection is scoped to THIS run's codex session dir (session id parsed
 * from the exec header) so concurrent runs sharing CODEX_HOME can't pick up each other's
 * output; the newest-since-start scan over all sessions is only a fallback for a header
 * format change.
 */

import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { runCommand } from "../../shared/subprocess.ts";
import type { BackendCtx, BackendResult, EditParams, GenerateParams, ImageBackend } from "./types.ts";

const BACKEND_ID = "gpt-image-2";
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
// `codex exec` header line, e.g. "session id: 019f3dd8-7286-7ee3-aa34-72eece646428" — the
// generated_images subdir for the run is named exactly this id.
const SESSION_ID_RE = /^session id:\s*([0-9a-f][0-9a-f-]{7,})\s*$/im;

/** Where the built-in image_gen writes by default. */
function generatedRoot(codexHome: string): string {
  return join(codexHome, "generated_images");
}

/**
 * Newest image in one session dir at/after `afterMs`. The afterMs floor is what lets us tell
 * a fresh render from a stale leftover: if nothing newer exists, codex produced no image
 * (failure), so we never silently copy an old one.
 */
function newestInDir(dir: string, afterMs: number): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { path: string; mtime: number } | undefined;
  for (const f of entries) {
    if (!IMAGE_RE.test(f)) continue;
    const fp = join(dir, f);
    let fstat;
    try {
      fstat = statSync(fp);
    } catch {
      continue;
    }
    if (fstat.mtimeMs >= afterMs && (!best || fstat.mtimeMs > best.mtime)) {
      best = { path: fp, mtime: fstat.mtimeMs };
    }
  }
  return best?.path;
}

/** Fallback: newest image across ALL session dirs — races under concurrency; see runCodex. */
function newestSince(root: string, afterMs: number): string | undefined {
  if (!existsSync(root)) return undefined;
  let best: { path: string; mtime: number } | undefined;
  for (const sess of readdirSync(root)) {
    const dir = join(root, sess);
    let dstat;
    try {
      dstat = statSync(dir);
    } catch {
      continue;
    }
    if (!dstat.isDirectory()) continue;
    const p = newestInDir(dir, afterMs);
    if (!p) continue;
    const m = statSync(p).mtimeMs;
    if (!best || m > best.mtime) best = { path: p, mtime: m };
  }
  return best?.path;
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
  const a = ["exec", "--skip-git-repo-check", "--sandbox", ctx.codex.sandbox];
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
  const start = Date.now() - 2000; // small floor for clock skew between this process and file mtimes
  ctx.onProgress?.(`codex ${op} via ${BACKEND_ID} (subscription)…`);
  const r = await runCommand(ctx.codex.bin, args, {
    cwd: ctx.codex.home, // a stable, writable cwd; the real output goes to generated_images
    env: { CODEX_HOME: ctx.codex.home },
    timeoutMs: ctx.codex.timeoutMs,
  });
  // Scope detection to this run's own session dir — concurrent runs share generated_images,
  // and a global newest-since scan would happily copy a sibling run's image. Once the session
  // id is known, its dir is authoritative: empty means THIS run produced nothing, even if a
  // sibling just did.
  const sessionId = SESSION_ID_RE.exec(r.stdout)?.[1];
  if (!sessionId) ctx.log.warn("codex exec header had no session id; falling back to global newest-since scan");
  const produced = sessionId ? newestInDir(join(root, sessionId), start) : newestSince(root, start);
  if (!produced) {
    const tail = (r.stderr.trim() || r.stdout.trim()).slice(-600);
    throw new Error(`codex produced no image (exit ${r.code ?? "killed"}). Tail: ${tail || "(empty)"}`);
  }
  copyFileSync(produced, outPath);
  const bytes = statSync(outPath).size;
  ctx.log.info("image produced", { op, src: basename(produced), outPath, bytes });
  return { backend: BACKEND_ID, model: ctx.codex.model, outPath, bytes };
}

export const codexImagegenBackend: ImageBackend = {
  id: BACKEND_ID,
  label: "Codex built-in image_gen (gpt-image-2, ChatGPT/Codex subscription)",
  subscription: true,

  async generate({ prompt, outPath, size, quality }, ctx) {
    const instruction =
      `Use $imagegen (the built-in image_gen tool — NOT the CLI script, NOT OPENAI_API_KEY) ` +
      `to generate this image:\n\n${prompt}${hints(size, quality)}\n\n` +
      `This is a preview render: generate with the built-in tool and then stop. Do not write ` +
      `code, do not use the CLI fallback, and do not move or copy the file.`;
    return runCodex(ctx, [...baseArgs(ctx), instruction], outPath, "generate");
  },

  async edit({ instruction, inputPath, outPath, size, quality }, ctx) {
    const message =
      `Use $imagegen (the built-in image_gen tool — NOT the CLI script, NOT OPENAI_API_KEY) ` +
      `to edit the attached image:\n\n${instruction}${hints(size, quality)}\n\n` +
      `Preserve everything not mentioned. Generate with the built-in tool and then stop; do ` +
      `not move or copy the file.`;
    // -i attaches the source so the built-in edit flow can see it (built-in edit operates on
    // images visible in the conversation context).
    return runCodex(ctx, [...baseArgs(ctx), "-i", inputPath, message], outPath, "edit");
  },
};
