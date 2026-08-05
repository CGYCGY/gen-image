/**
 * image/backends/semaphore.ts — a machine-wide ceiling on concurrent codex renders.
 *
 * The resource being protected is shared by every process on the host (the provider's rate limit,
 * and N codex subprocesses' worth of RAM), so an in-process counter would be useless: a second
 * CLI invocation, agent or terminal would not see it. Slots are therefore files in the state dir,
 * arbitrated by O_EXCL create — the same mechanism claims.ts uses, for the same reason.
 *
 * Waiting callers QUEUE and never fail: asking for 30 images must yield 30 images, just later.
 * Uses only node: built-ins.
 */

import { hostname } from "node:os";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "../../shared/log.ts";

const POLL_BASE_MS = 400;
const POLL_JITTER_MS = 600;
/** How often a still-waiting caller says so, so a slow batch is explainable rather than mysterious. */
const WAIT_LOG_EVERY_MS = 30_000;

export interface RenderSlot {
  /** Idempotent, never throws — a failed release must not fail an otherwise good render. */
  release(): void;
  /** 0 when the slot was free immediately. */
  waitedMs: number;
}

export interface SlotOpts {
  stateDir: string;
  max: number;
  /**
   * Age past which a slot is presumed abandoned even if its pid looks alive (pids get reused).
   * Callers pass the render timeout plus a margin: a run that cannot outlive its own SIGKILL
   * ceiling cannot legitimately hold a slot longer than that.
   */
  maxHoldMs: number;
  log: Logger;
  onWait?: (message: string) => void;
}

interface SlotRecord {
  pid: number;
  host: string;
  token: string;
  at: number;
}

function slotsDir(stateDir: string): string {
  return join(stateDir, "render-slots");
}

function slotPath(stateDir: string, i: number): string {
  return join(slotsDir(stateDir), `slot-${i}.json`);
}

function readSlot(path: string): SlotRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as Partial<SlotRecord>;
    if (typeof r.token !== "string" || typeof r.pid !== "number") return undefined;
    return { pid: r.pid, host: String(r.host), token: r.token, at: Number(r.at) || 0 };
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — alive for our purposes.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A holder that died mid-render would otherwise burn a slot forever. Liveness is only meaningful
 * for our own host, hence the host check before trusting the pid.
 */
function isStale(rec: SlotRecord | undefined, maxHoldMs: number): boolean {
  if (!rec) return true; // unparseable/truncated: a half-written slot is not a live holder
  if (Date.now() - rec.at > maxHoldMs) return true;
  return rec.host === hostname() && !pidAlive(rec.pid);
}

/**
 * Reclaim a slot we just observed as stale. Renaming is the atomic step: only one process can
 * move that path away, so exactly one reclaimer wins the race to free it. The token re-check
 * covers the window between reading and renaming, where a third process may have released and
 * re-acquired the slot legitimately.
 */
function steal(path: string, observed: SlotRecord | undefined): void {
  const tmp = `${path}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(path, tmp);
  } catch {
    return; // someone else reclaimed or released it first
  }
  const moved = readSlot(tmp);
  if (observed && moved && moved.token !== observed.token) {
    try {
      renameSync(tmp, path); // it was re-acquired under us; put the live holder's slot back
      return;
    } catch {
      // Fall through to unlink: leaving a stray .stale file would leak the slot permanently.
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    // Already gone.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Take a slot, waiting as long as necessary. Slots are freed with the returned release(). */
export async function acquireRenderSlot(opts: SlotOpts): Promise<RenderSlot> {
  const dir = slotsDir(opts.stateDir);
  mkdirSync(dir, { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const startedAt = Date.now();
  let announced = false;
  let lastLog = 0;

  for (;;) {
    for (let i = 0; i < opts.max; i++) {
      const path = slotPath(opts.stateDir, i);
      let taken = false;
      // Two attempts: the second is the retry after reclaiming an abandoned slot, so a crashed
      // holder costs the next caller nothing rather than a full poll interval.
      for (let attempt = 0; attempt < 2 && !taken; attempt++) {
        const record: SlotRecord = { pid: process.pid, host: hostname(), token, at: Date.now() };
        try {
          writeFileSync(path, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
          taken = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          const held = readSlot(path);
          if (!isStale(held, opts.maxHoldMs)) break;
          opts.log.warn("reclaiming abandoned render slot", { slot: i, heldBy: held?.pid ?? null, at: held?.at ?? null });
          steal(path, held);
        }
      }
      if (!taken) continue;
      const waitedMs = Date.now() - startedAt;
      if (announced) opts.log.info("render slot acquired after waiting", { slot: i, waitedMs, max: opts.max });
      return {
        waitedMs,
        release: () => {
          // Only unlink a slot still stamped with OUR token: if this run was declared stale and
          // reclaimed, the file now belongs to someone else's live render.
          try {
            if (readSlot(path)?.token === token) unlinkSync(path);
          } catch {
            // Releasing must never fail a completed render.
          }
        },
      };
    }
    if (!announced) {
      announced = true;
      lastLog = Date.now();
      opts.log.info("all render slots busy, queueing", { max: opts.max });
      opts.onWait?.(`all ${opts.max} render slots busy — queueing…`);
    } else if (Date.now() - lastLog >= WAIT_LOG_EVERY_MS) {
      lastLog = Date.now();
      opts.log.info("still waiting for a render slot", { max: opts.max, waitedMs: Date.now() - startedAt });
    }
    // Jittered so a batch released together does not stampede the same slot file.
    await sleep(POLL_BASE_MS + Math.random() * POLL_JITTER_MS);
  }
}
