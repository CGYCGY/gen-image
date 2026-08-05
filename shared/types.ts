/**
 * shared/types.ts — the result contract.
 *
 * One ImageJobResult per requested image, built in code from what the backend actually
 * produced, and handed back verbatim in the CLI's single JSON line.
 *
 * Uses no runtime dependency at all — importable from anywhere in the tree.
 */

/** Single log role; the log file is <stateDir>/logs/<role>.log. */
export type Role = "image";

/** The single structured result a render concludes with, whatever happened inside it. */
export interface ImageJobResult {
  status: "ok" | "failed";
  op: "generate" | "edit";
  /** Backend id that ran (e.g. "gpt-image-2"). */
  backend?: string;
  /** Underlying model (e.g. "gpt-5.6-sol" driving the built-in image_gen). */
  model?: string;
  /** Absolute path the image was written to. May differ from what the caller asked for. */
  out_path?: string;
  /** Format of the bytes actually written — always matches out_path's extension. */
  format?: string;
  /** The caller's original out_path; present ONLY when the configured format rewrote it. */
  requested_path?: string;
  /** Size of the written file in bytes (a positive value is the proof it landed). */
  bytes?: number;
  /** Non-fatal degradation, e.g. the encode failed and the original PNG was delivered instead. */
  warning?: string;
  /** Failure reason; presence accompanies status:"failed". */
  error?: string;
  /**
   * Renders spent on this image, present only when it took more than one. A retried image that
   * ends up ok still says so — otherwise a backend failing half the time reads as perfectly
   * healthy and the degradation is invisible until it fails outright.
   */
  attempts?: number;
}

/**
 * A failure that must NOT be retried, because retrying re-rolls a SAFETY verdict rather than a
 * flaky render: the claim-once collision and the ambiguous multi-candidate session. Those two
 * exist to make cross-assignment loud, and a retry that happens to succeed mutes the alarm
 * without fixing what tripped it.
 *
 * Flagged on the error object rather than by class, so it survives the module boundary between
 * the backends and the retry loop that catches them.
 */
export function terminalError(message: string): Error {
  const e = new Error(message);
  (e as Error & { terminal?: boolean }).terminal = true;
  return e;
}

export function isTerminal(err: unknown): boolean {
  return Boolean((err as { terminal?: boolean } | null | undefined)?.terminal);
}
