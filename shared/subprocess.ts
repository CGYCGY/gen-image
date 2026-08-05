/**
 * shared/subprocess.ts — the one place gen-image shells out.
 *
 * The gpt-image-2 backend drives the `codex` CLI through here. Capture stdout/stderr; a hard
 * timeout SIGKILLs the run.
 *
 * Uses only node: built-ins.
 */

import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  /** null when the process was killed (timeout) or never spawned (spawn error). */
  code: number | null;
  /**
   * True only when WE killed the run on `timeoutMs`. `code` alone cannot tell that apart from a
   * spawn error, and the two need opposite diagnoses: a timed-out render produced no image
   * because we stopped it, not because detection failed.
   */
  timedOut: boolean;
}

export interface RunOpts {
  cwd: string;
  /** Extra env merged over process.env (e.g. CODEX_HOME). */
  env?: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export function runCommand(bin: string, args: string[], opts: RunOpts): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<RunResult>((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      // stdin ignored: codex exec must not block waiting on a pipe.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout, stderr: stderr + `\n[timeout after ${timeoutMs}ms]`, code: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + "\n" + err.message, code: null, timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut: false });
    });
  });
}
