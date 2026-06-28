/**
 * image/backends/index.ts — the pluggable backend registry (pi principle #5).
 *
 * Both verbs resolve their engine here. Adding a backend = drop a file + one line below,
 * never touching the verbs. Future siblings: a gemini "nano-banana" backend (Vertex API)
 * and a direct OpenAI Images API backend — both KEY-billed, unlike the Codex subscription
 * default (the one thing that does not generalize; see DESIGN).
 */

import { codexImagegenBackend } from "./codex-imagegen.ts";
import type { ImageBackend } from "./types.ts";

export const DEFAULT_BACKEND_ID = "gpt-image-2";

const REGISTRY: Record<string, ImageBackend> = {
  [codexImagegenBackend.id]: codexImagegenBackend,
};

/** Fail-loud lookup: an unknown backend id throws with the available set (never a silent default). */
export function resolveBackend(id?: string): ImageBackend {
  const key = id?.trim() || DEFAULT_BACKEND_ID;
  const backend = REGISTRY[key];
  if (!backend) {
    throw new Error(`unknown backend "${key}". Available: ${Object.keys(REGISTRY).join(", ")}.`);
  }
  return backend;
}

export function listBackends(): ImageBackend[] {
  return Object.values(REGISTRY);
}
