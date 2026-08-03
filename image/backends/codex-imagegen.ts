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
 * $CODEX_HOME/generated_images/<session>/, and the basename varies by driver model (`call_*.png`
 * on a direct tool call, `exec-*.png` via code mode). So we detect what it produced and copy it
 * ourselves, deterministically, rather than trusting the codex agent to report or move it
 * (the agent's own `cp` would also be sandbox-bound, which an arbitrary caller out_path can
 * fall outside of). Detection is scoped to THIS run's codex session dir, whose id we read off
 * the `--json` event stream, so concurrent runs sharing CODEX_HOME can't pick up each other's
 * output. There is deliberately NO cross-session fallback: an unidentifiable session fails the
 * run loudly, because the only alternative — newest image anywhere under generated_images —
 * hands a sibling run's image to this caller whenever two runs overlap.
 */

import { copyFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { runCommand } from "../../shared/subprocess.ts";
import type { BackendCtx, BackendResult, EditParams, GenerateParams, ImageBackend } from "./types.ts";

const BACKEND_ID = "gpt-image-2";
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const start = Date.now() - 2000; // small floor for clock skew between this process and file mtimes
  ctx.onProgress?.(`codex ${op} via ${BACKEND_ID} (subscription)…`);
  const r = await runCommand(ctx.codex.bin, args, {
    cwd: ctx.codex.home, // a stable, writable cwd; the real output goes to generated_images
    env: { CODEX_HOME: ctx.codex.home },
    timeoutMs: ctx.codex.timeoutMs,
  });
  const events = parseEvents(r.stdout);
  const tail = () => failureTail(events, r.stdout, r.stderr);
  // Without the session id every candidate image is unattributable, so failing here is the
  // whole point: concurrent runs share generated_images and picking the newest one across all
  // of them silently returns a sibling's image.
  const sessionId = sessionIdOf(events);
  if (!sessionId) {
    throw new Error(`codex exec reported no session id (exit ${r.code ?? "killed"}). Tail: ${tail()}`);
  }
  // The session dir is authoritative: empty means THIS run produced nothing, even if a sibling
  // just did.
  const produced = newestInDir(join(root, sessionId), start);
  if (!produced) {
    throw new Error(`codex produced no image in session ${sessionId} (exit ${r.code ?? "killed"}). Tail: ${tail()}`);
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
    // images visible in the conversation context). `--` is REQUIRED: codex declares
    // `-i, --image <FILE>...` as variadic, so without it the prompt is parsed as a second
    // filename and codex falls back to an empty stdin ("No prompt provided via stdin").
    return runCodex(ctx, [...baseArgs(ctx), "-i", inputPath, "--", message], outPath, "edit");
  },
};
