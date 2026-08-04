/**
 * shared/types.ts — pi-image's result + protocol contracts.
 *
 * pi-image is summoned over pi RPC and conversed with in natural language, so there is no
 * bespoke wire union: the caller's request is a prompt, and the verbs take their target as
 * params. What remains is the single structured result a job concludes with (built in code,
 * never parsed from LLM prose) and the notify markers the driver greps for.
 *
 * Uses no pi runtime — importable from config/sandbox/log and the RPC driver.
 */

/** pi-image has a single session role. */
export type Role = "image";

// Notify markers emitted on the RPC event stream (ctx.ui.notify -> extension_ui_request,
// method:"notify"). READY lets the driver confirm the spoke actually booted; RESULT carries
// the code-derived ImageJobResult JSON. Plain (unmarked) assistant text is a human reply.
export const READY_MARK = "PIIMAGE_READY";
export const RESULT_MARK = "PIIMAGE_RESULT";

// pi process --name tag; distinctive enough that `pkill -f PI_NAME` targets the spoke's pi
// without matching a driver's own argv.
export const PI_NAME = "pi-image:rpc";

/**
 * The single structured result a job concludes with. BUILT IN CODE from what the backend
 * actually produced — never from the LLM's prose. Emitted on the RESULT notify channel;
 * the driver returns it verbatim to the calling agent.
 */
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
}
