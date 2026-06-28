// Shared helpers for the gen-image RPC driver. The driver summons the gated pi-image spoke
// over pi's native --mode rpc (stdin/stdout JSONL, no HTTP/port) and converses with it. This
// file owns: locating the pi-image checkout, loading its config, the pi spawn argv, JSONL
// framing, and the notify-marker contract the spoke emits.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The skill root (parent of tools/), self-located so config resolution is independent of cwd.
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = resolve(TOOLS_DIR, "..");

// Notify markers the spoke emits on the RPC event stream (extension_ui_request /
// method:"notify"). READY = session booted; RESULT = a code-derived ImageJobResult JSON.
export const READY_MARK = "PIIMAGE_READY";
export const RESULT_MARK = "PIIMAGE_RESULT";

// pi process --name tag; distinctive enough that `pkill -f PI_NAME` targets the spoke's pi
// without matching this driver's own argv.
export const PI_NAME = "pi-image:rpc";

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isImageCheckout(dir: string): boolean {
  return existsSync(join(dir, "image", "index.ts"));
}

/**
 * Resolve the pi-image checkout. Order: PI_IMAGE_DIR env var, then the skill-local
 * config.json {imageDir}, then a self-locating guess (this skill ships INSIDE pi-image at
 * .claude/skills/gen-image, so the project root is three levels up). The guess makes the
 * in-place skill zero-config; env/config are only needed when the skill is copied elsewhere.
 */
export function resolveImageDir(): string {
  const fromEnv = process.env.PI_IMAGE_DIR?.trim();
  let dir = fromEnv || readSkillConfig().imageDir?.trim();
  if (!dir) {
    const guess = resolve(SKILL_DIR, "..", "..", "..");
    if (isImageCheckout(guess)) dir = guess;
  }
  if (!dir) {
    throw new Error(
      "pi-image location not configured. Set PI_IMAGE_DIR, or add " +
        `{"imageDir": "/abs/path/to/pi-image"} to ${join(SKILL_DIR, "config.json")} ` +
        "(see config.json.example).",
    );
  }
  dir = expandTilde(dir);
  if (!isImageCheckout(dir)) {
    throw new Error(`imageDir "${dir}" is not a pi-image checkout (no image/index.ts).`);
  }
  return dir;
}

interface SkillConfig {
  imageDir?: string;
}

function readSkillConfig(): SkillConfig {
  const file = join(SKILL_DIR, "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SkillConfig;
  } catch {
    return {};
  }
}

export interface ImageCfg {
  /** Where the spoke (and this driver) keep state/logs. */
  stateDir: string;
  /** pi model + thinking the spoke runs on (passed to the spawned pi). */
  model?: string;
  thinking?: string;
}

/** Read pi-image's own config.json for stateDir + model/thinking. */
export function loadImageCfg(imageDir: string): ImageCfg {
  const file = join(imageDir, "config.json");
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`pi-image config.json is not valid JSON: ${file}`);
    }
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    stateDir: expandTilde(str(raw.stateDir) ?? "~/.pi-image"),
    model: str(raw.model),
    thinking: str(raw.thinking),
  };
}

export interface Paths {
  dir: string;
  /** FIFO the CLI writes requests to; the detached __spoke reads them. */
  fifo: string;
  /** JSONL the __spoke appends per-request results to; the CLI tails it. */
  out: string;
  /** Session record: {pid, piPid, ready, ...}. */
  state: string;
}

export function paths(stateDir: string): Paths {
  return {
    dir: stateDir,
    fifo: join(stateDir, "geni.in"),
    out: join(stateDir, "geni.out"),
    state: join(stateDir, "geni.json"),
  };
}

/**
 * The pi argv that summons the spoke in RPC mode. THE GATE: --no-builtin-tools makes
 * bash/read/write/edit/glob unrepresentable; --no-extensions blocks other extensions from
 * re-adding tools; -nc drops ambient AGENTS.md/CLAUDE.md. --mode rpc = stdin/stdout JSONL.
 */
export function piArgs(imageDir: string, cfg: ImageCfg): string[] {
  const args = [
    "--no-extensions",
    "--no-builtin-tools",
    "-nc",
    "--mode",
    "rpc",
    "-e",
    join(imageDir, "image", "index.ts"),
    // Distinctive tag so teardown's `pkill -f` matches ONLY this pi, never the driver itself.
    "--name",
    PI_NAME,
  ];
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.thinking) args.push("--thinking", cfg.thinking);
  return args;
}

/**
 * Inspect one parsed RPC event for the spoke's notify markers. RPC mode surfaces
 * ctx.ui.notify as {type:"extension_ui_request", method:"notify", message}. READY/RESULT are
 * the spoke's two structured signals; everything else (plain assistant text) is a human reply.
 */
export function parseNotify(msg: unknown): { ready?: boolean; result?: unknown } {
  const m = msg as { type?: string; method?: string; message?: unknown };
  if (m?.type !== "extension_ui_request" || m?.method !== "notify") return {};
  const text = String(m.message ?? "");
  if (text.startsWith(READY_MARK)) return { ready: true };
  if (text.startsWith(RESULT_MARK)) {
    const json = text.slice(RESULT_MARK.length).trim();
    try {
      return { result: JSON.parse(json) };
    } catch {
      return { result: { status: "failed", op: "generate", error: `unparseable result: ${json.slice(0, 200)}` } };
    }
  }
  return {};
}

/** Split a growing buffer into complete LF-delimited lines (RPC is LF-only; strip a stray \r). */
export function takeLines(buf: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buf;
  for (;;) {
    const nl = rest.indexOf("\n");
    if (nl < 0) break;
    let line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line) lines.push(line);
  }
  return { lines, rest };
}
