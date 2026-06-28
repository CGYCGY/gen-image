/**
 * image/backends/types.ts — the pluggable image-backend contract (pi principle #5).
 *
 * Every backend exposes the SAME generate/edit surface behind the two verbs. Adding a
 * backend (e.g. gemini "nano-banana" via Vertex API, or the OpenAI Images API directly) =
 * drop one file implementing this interface and register it. The `subscription` flag records
 * the one thing that does NOT generalize across backends: only Codex-backed generation is
 * subscription-billed; API backends are key-billed (see DESIGN).
 */

import type { CodexConfig } from "../../shared/config.ts";
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
  outPath: string;
  bytes: number;
}

export interface BackendCtx {
  log: Logger;
  /** Codex driver settings (used by codex-backed backends; ignored by API backends). */
  codex: CodexConfig;
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
