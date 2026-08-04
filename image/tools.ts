// The two image verbs registered as pi tools — the COMPLETE tool surface the spoke LLM
// sees. Built-in tools are gated off (--no-builtin-tools + setActiveTools), so these verbs
// are the only things representable. The verbs' CODE drives the backend (which drives the
// codex CLI); the LLM never reaches a subprocess. Verbs report their outcome by calling
// concludeJob with a code-derived result — never prose to parse.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadConfig } from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";
import { validateInputPath, validateOutPath } from "../shared/sandbox.ts";
import type { ImageJobResult } from "../shared/types.ts";

import { DEFAULT_BACKEND_ID, resolveBackend } from "./backends/index.ts";
import type { BackendCtx, BackendResult } from "./backends/types.ts";

/** The complete verb set. Passed to pi.setActiveTools as the gate's allowlist. */
export const VERB_NAMES = ["generate_image", "edit_image"] as const;

export interface ImageToolDeps {
  roleLog: Logger;
  /** Emit the code-derived ImageJobResult to the caller on the RESULT notify channel. */
  concludeJob: (ctx: ExtensionContext, result: ImageJobResult) => void;
  setActiveCtx: (ctx: ExtensionContext) => void;
}

function ok(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function backendCtx(roleLog: Logger): BackendCtx {
  const cfg = loadConfig();
  return {
    log: roleLog,
    codex: cfg.codex,
    output: cfg.output,
    stateDir: cfg.stateDir,
    maxConcurrentRenders: cfg.maxConcurrentRenders,
    keepSourceImages: cfg.keepSourceImages,
    onProgress: (m) => roleLog.debug(m),
  };
}

/** Everything the backend derived in code. `bytes` and `format` always describe out_path. */
function resultOf(op: ImageJobResult["op"], r: BackendResult): ImageJobResult {
  return {
    status: "ok",
    op,
    backend: r.backend,
    model: r.model,
    out_path: r.outPath,
    format: r.format,
    requested_path: r.requestedPath,
    bytes: r.bytes,
    warning: r.warning,
  };
}

function okText(verb: string, r: BackendResult): string {
  const moved = r.requestedPath ? ` (requested ${r.requestedPath})` : "";
  const warned = r.warning ? ` WARNING: ${r.warning}` : "";
  return `${verb} via ${r.backend} → ${r.outPath}${moved} (${r.format}, ${r.bytes} bytes).${warned}`;
}

export function registerImageTools(pi: ExtensionAPI, deps: ImageToolDeps): void {
  const { roleLog, concludeJob, setActiveCtx } = deps;

  pi.registerTool({
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate a NEW image from a text prompt and save it to an ABSOLUTE out_path the caller " +
      "names (parent dirs are created). The default backend gpt-image-2 runs on the Codex/ChatGPT " +
      "subscription (no API key). The structured result is reported to the caller in code.",
    promptSnippet: "Generate a new image from a prompt and save it to the caller's out_path.",
    promptGuidelines: [
      "Extract the image description and the absolute out_path from the caller's request.",
      "If no absolute out_path is given, ask for one — never invent a destination.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Full description of the image to generate." }),
      out_path: Type.String({ description: "Absolute path to write the image (.png/.jpg/.jpeg/.webp)." }),
      size: Type.Optional(Type.String({ description: "Optional composition hint, e.g. 1536x1024 (approximate)." })),
      quality: Type.Optional(Type.String({ description: "Optional quality hint, e.g. high." })),
      backend: Type.Optional(Type.String({ description: `Backend id (default ${DEFAULT_BACKEND_ID}).` })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const p = params as { prompt: string; out_path: string; size?: string; quality?: string; backend?: string };
      if (!p.prompt?.trim()) throw new Error("generate_image: prompt is required.");
      // A bad/relative path throws (recoverable) BEFORE any work — the agent relays it and asks
      // the caller for a valid absolute path, rather than concluding a failed job.
      const outPath = validateOutPath(p.out_path);
      const backend = resolveBackend(p.backend);
      try {
        const r = await backend.generate({ prompt: p.prompt, outPath, size: p.size, quality: p.quality }, backendCtx(roleLog));
        concludeJob(ctx, resultOf("generate", r));
        return ok(okText("Generated image", r), { ...r });
      } catch (err) {
        // A generation failure is TERMINAL for this job — conclude with a structured failed
        // result so the caller always gets a verdict, never a prose error to parse.
        const error = (err as Error).message;
        concludeJob(ctx, { status: "failed", op: "generate", backend: backend.id, out_path: outPath, error });
        return ok(`Image generation FAILED (${backend.id}): ${error}. Reported to caller.`, { failed: true });
      }
    },
  });

  pi.registerTool({
    name: "edit_image",
    label: "Edit image",
    description:
      "Edit an EXISTING image at an absolute input_path following an instruction, writing the " +
      "result to an absolute out_path. Preserves everything not mentioned. Same backends as " +
      "generate_image; default gpt-image-2 on the Codex/ChatGPT subscription.",
    promptSnippet: "Edit an existing image per an instruction and save it to out_path.",
    promptGuidelines: [
      "Extract input_path (existing image), the edit instruction, and out_path — all absolute.",
      "If input_path or out_path is missing, ask — never guess a path.",
    ],
    parameters: Type.Object({
      instruction: Type.String({ description: "What to change; keep everything else unchanged." }),
      input_path: Type.String({ description: "Absolute path to the existing source image." }),
      out_path: Type.String({ description: "Absolute path to write the edited image (.png/.jpg/.jpeg/.webp)." }),
      size: Type.Optional(Type.String({ description: "Optional composition hint." })),
      quality: Type.Optional(Type.String({ description: "Optional quality hint." })),
      backend: Type.Optional(Type.String({ description: `Backend id (default ${DEFAULT_BACKEND_ID}).` })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const p = params as {
        instruction: string;
        input_path: string;
        out_path: string;
        size?: string;
        quality?: string;
        backend?: string;
      };
      if (!p.instruction?.trim()) throw new Error("edit_image: instruction is required.");
      const inputPath = validateInputPath(p.input_path);
      const outPath = validateOutPath(p.out_path);
      const backend = resolveBackend(p.backend);
      try {
        const r = await backend.edit(
          { instruction: p.instruction, inputPath, outPath, size: p.size, quality: p.quality },
          backendCtx(roleLog),
        );
        concludeJob(ctx, resultOf("edit", r));
        return ok(okText("Edited image", r), { ...r });
      } catch (err) {
        const error = (err as Error).message;
        concludeJob(ctx, { status: "failed", op: "edit", backend: backend.id, out_path: outPath, error });
        return ok(`Image edit FAILED (${backend.id}): ${error}. Reported to caller.`, { failed: true });
      }
    },
  });
}
