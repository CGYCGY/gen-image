/**
 * shared/log.ts — append-only file logger with size-based rotation.
 *
 * pi-image writes timestamped lines to <stateDir>/logs/<role>.log. Use createLogger(role)
 * once and call .info/.warn/.error/.debug. Console echo is off by default — pi owns the TUI.
 * Analytics (one JSON object per line) go through appendJsonl instead.
 *
 * Uses only node: built-ins + shared/config. No pi runtime dependency.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { getStateDir } from "./config.ts";
import type { Role } from "./types.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  path: string;
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
  log: (level: LogLevel, message: string, data?: unknown) => void;
}

function stamp(): string {
  return new Date().toISOString();
}

function fmtData(data: unknown): string {
  if (data === undefined) return "";
  try {
    return " " + JSON.stringify(data);
  } catch {
    return " " + String(data);
  }
}

export function getLogPath(role: Role): string {
  return join(getStateDir(), "logs", `${role}.log`);
}

export function getJsonlPath(name: string): string {
  return join(getStateDir(), "logs", `${name}.jsonl`);
}

/** Operational log: recent-and-small wins, and error paths carry variable-size payloads. */
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP = 5;

/**
 * Analytics backstop, not an operating limit: legitimate growth is capped by render time
 * (~500 KB/year), so reaching 50 MB means a caller is looping without generating. Discarding
 * a file that got there is correct — but it must not happen quietly, hence the warn below.
 */
const JSONL_MAX_BYTES = 50 * 1024 * 1024;
const JSONL_KEEP = 2;

/** `<stem>.<n><ext>` — rotated names are recycled, never counted upward. */
function rotatedName(path: string, n: number): string {
  const ext = extname(path);
  return join(dirname(path), `${basename(path, ext)}.${n}${ext}`);
}

/**
 * Shift-rotate `path` when it is at or over `maxBytes`: drop `.keep`, shift each older file
 * up one, move `path` to `.1`. Returns whether it fired.
 *
 * Parallel spokes check independently, so two can race here; a rename that loses the race is
 * swallowed and the winner's rotation stands — losing one shift is cheaper than a crashed
 * generate.
 */
export function rotateBySize(path: string, maxBytes: number, keep: number): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false; // no file yet
  }
  if (size < maxBytes) return false;
  try {
    rmSync(rotatedName(path, keep), { force: true });
    for (let n = keep - 1; n >= 1; n--) {
      const from = rotatedName(path, n);
      if (existsSync(from)) renameSync(from, rotatedName(path, n + 1));
    }
    renameSync(path, rotatedName(path, 1));
    return true;
  } catch {
    return false;
  }
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Append one JSON object as a line to <stateDir>/logs/<name>.jsonl.
 *
 * Rotation is checked per write (not per open) because a single long-lived process is what a
 * runaway loop looks like — checking only at open would never fire for the case the cap exists
 * to catch. statSync per line is noise against a ~2-minute render.
 */
export function appendJsonl(name: string, entry: unknown): void {
  const path = getJsonlPath(name);
  ensureDir(path);
  if (rotateBySize(path, JSONL_MAX_BYTES, JSONL_KEEP)) {
    createLogger("image").warn(
      `${basename(path)} hit the ${Math.round(JSONL_MAX_BYTES / 1024 / 1024)} MB backstop and was rotated`,
      { path, keep: JSONL_KEEP, hint: "unreachable by normal use — look for a caller re-resolving without generating" },
    );
  }
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Analytics must never crash the caller.
  }
}

export function createLogger(role: Role, opts: { echo?: boolean } = {}): Logger {
  const path = getLogPath(role);
  ensureDir(path);
  rotateBySize(path, LOG_MAX_BYTES, LOG_KEEP);
  const echo = opts.echo ?? false;

  const write = (level: LogLevel, message: string, data?: unknown): void => {
    const line = `${stamp()} [${role}] ${level.toUpperCase()} ${message}${fmtData(data)}\n`;
    try {
      appendFileSync(path, line, "utf8");
    } catch {
      // Logging must never crash the caller; swallow write failures.
    }
    if (echo) {
      // eslint-disable-next-line no-console
      console.error(line.trimEnd());
    }
  };

  return {
    path,
    log: write,
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
  };
}
