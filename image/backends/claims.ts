/**
 * image/backends/claims.ts — claim a codex source image exactly once, machine-wide.
 *
 * The cross-assignment failure this guards against is silent by nature: two concurrent runs
 * delivering the SAME codex output to two different out_paths both look like success, and the
 * md5s differ, so nothing downstream notices. A claim registry turns that into a loud throw at
 * the moment of the second delivery — the deterministic tripwire the detection logic itself
 * cannot provide, since a run can only see its own session dir.
 *
 * O_EXCL create is the whole mechanism: the kernel arbitrates, so it holds across processes,
 * terminals and concurrent CLI invocations without a lock daemon. Uses only node: built-ins.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { terminalError } from "../../shared/types.ts";

/**
 * Claims older than this are pruned. Long enough that a claim outlives any plausible
 * investigation of a mis-delivery, short enough that the directory never becomes a scan cost.
 */
const CLAIM_TTL_MS = 7 * 24 * 60 * 60_000;

export interface ClaimMeta {
  op: string;
  sessionId: string;
  outPath: string;
}

interface ClaimRecord extends ClaimMeta {
  source: string;
  pid: number;
  at: string;
}

function claimsDir(stateDir: string): string {
  return join(stateDir, "claims");
}

/** Content-addressed by source path: the filename IS the identity being claimed. */
function claimPath(stateDir: string, source: string): string {
  return join(claimsDir(stateDir), `${createHash("sha256").update(source).digest("hex").slice(0, 32)}.json`);
}

function describe(path: string): string {
  try {
    const prior = JSON.parse(readFileSync(path, "utf8")) as Partial<ClaimRecord>;
    return `pid ${prior.pid} at ${prior.at} for ${prior.outPath} (op ${prior.op}, session ${prior.sessionId})`;
  } catch {
    return "(claim record unreadable)";
  }
}

/** Best-effort; a prune failure must never fail a render. */
function prune(dir: string): void {
  const cutoff = Date.now() - CLAIM_TTL_MS;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const fp = join(dir, f);
    try {
      if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp);
    } catch {
      // Another process pruned it, or it is being written right now. Either way, not ours to fix.
    }
  }
}

/**
 * Record that this run owns `source`. Throws if any run ever claimed it before — which means two
 * runs resolved to the same codex output, i.e. the cross-assignment bug, caught before delivery.
 */
export function claimSource(stateDir: string, source: string, meta: ClaimMeta): string {
  const dir = claimsDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const path = claimPath(stateDir, source);
  const record: ClaimRecord = { source, pid: process.pid, at: new Date().toISOString(), ...meta };
  try {
    writeFileSync(path, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    throw terminalError(
      `codex source ${source} was already claimed by ${describe(path)} — two runs resolved to the ` +
        `same image, so delivering it here would silently hand this caller another run's render.`,
    );
  }
  prune(dir);
  return path;
}
