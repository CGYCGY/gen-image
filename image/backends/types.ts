/**
 * image/backends/types.ts — the pluggable image-backend contract.
 *
 * Every backend exposes the SAME generate/edit surface behind the two ops. Adding a
 * backend (e.g. gemini "nano-banana" via Vertex API, or the OpenAI Images API directly) =
 * drop one file implementing this interface and register it. The `subscription` flag records
 * the one thing that does NOT generalize across backends: only Codex-backed generation is
 * subscription-billed; API backends are key-billed (see DESIGN).
 */

import type { CodexConfig, OutputConfig } from "../../shared/config.ts";
import type { Logger } from "../../shared/log.ts";

export interface GenerateParams {
  prompt: string;
  /** Absolute, validated destination (parent dir already created). */
  outPath: string;
  /** Optional composition hint, e.g. "1536x1024" (honored approximately by built-in tools). */
  size?: string;
  /** Optional quality hint, e.g. "high". */
  quality?: string;
}

export interface EditParams {
  instruction: string;
  /** Absolute, validated, existing source image. */
  inputPath: string;
  outPath: string;
  size?: string;
  quality?: string;
}

export interface BackendResult {
  backend: string;
  model: string;
  /** Where the bytes actually landed — not necessarily the requested path (see requestedPath). */
  outPath: string;
  bytes: number;
  /** Format of the delivered bytes. Always matches outPath's extension. */
  format: string;
  /** The caller's original out_path; set ONLY when the configured format rewrote the extension. */
  requestedPath?: string;
  /** Non-fatal degradation, e.g. an encode failure that fell back to the original PNG. */
  warning?: string;
}

export interface BackendCtx {
  log: Logger;
  /** Codex driver settings (used by codex-backed backends; ignored by API backends). */
  codex: CodexConfig;
  /** How the finished render is delivered (format/quality); backend-agnostic. */
  output: OutputConfig;
  /** Machine-wide coordination lives here: render slots and source claims. */
  stateDir: string;
  /** Ceiling on concurrent renders across every process on the host. */
  maxConcurrentRenders: number;
  /** Leave the backend's own copy of the render in place after delivering it. */
  keepSourceImages: boolean;
  /** Optional progress sink for human-facing status; never the result channel. */
  onProgress?: (message: string) => void;
}

export interface ImageBackend {
  /** Stable id callers pass as `backend` (e.g. "gpt-image-2"). */
  id: string;
  label: string;
  /** True if this backend bills the Codex/ChatGPT subscription rather than an API key. */
  subscription: boolean;
  generate(params: GenerateParams, ctx: BackendCtx): Promise<BackendResult>;
  edit(params: EditParams, ctx: BackendCtx): Promise<BackendResult>;
}
