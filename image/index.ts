// pi-image: one gated pi session a caller SUMMONS over pi RPC and converses with in natural
// language. The caller sends a prompt ("generate <subject>, save to <abs path>"); the spoke
// LLM extracts intent and calls one of two verbs (generate_image / edit_image). The verb's
// CODE produces the image via a pluggable backend — the default drives the Codex CLI's
// built-in image_gen on the ChatGPT/Codex SUBSCRIPTION (no API key). pi has no native image
// tool, so the subscription path is only reachable through that wrapped CLI (pi principle #2).
//
// Transport is pi's native --mode rpc (stdin/stdout JSONL). The structured ImageJobResult is
// emitted IN CODE (concludeJob -> notify) for the driver to capture — never parsed from prose.
//
// THE GATE: the driver spawns pi with --no-builtin-tools (bash/read/write/edit/glob become
// unrepresentable) and session_start pins the active set to exactly the two verbs.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getModelConfig } from "../shared/config.ts";
import { createLogger } from "../shared/log.ts";
import { type ImageJobResult, READY_MARK, RESULT_MARK, type Role, START_MARK } from "../shared/types.ts";

import { listBackends } from "./backends/index.ts";
import { registerImageTools, VERB_NAMES } from "./tools.ts";

const ROLE: Role = "image";

// The spoke's persona, layered onto pi's base prompt each turn. Flow-level only — backend
// specifics live in the backend modules, not here.
const IMAGE_RULES = `

## pi-image
You are pi-image — a single-purpose, gated image-generation service a caller talks to over RPC. Each message is a natural-language request to CREATE or EDIT an image. Built-in tools (bash, read, write, edit, glob) are DISABLED — your ONLY tools are these two verbs, by design:

- generate_image — create a NEW image from a text prompt and save it to an ABSOLUTE out_path the caller names. Params: prompt, out_path, optional size, quality, backend.
- edit_image — transform an EXISTING image (input_path) into out_path following an instruction. Params: instruction, input_path, out_path, optional size, quality, backend.

How to work with the caller:
- Extract the description (or edit instruction) and the ABSOLUTE out_path (and input_path for edits) from the caller's message.
- If a required absolute path is missing, STOP and ASK — never invent a destination or source path.
- Call ONE verb PER IMAGE the request asks for, then stop. One image, one call.
- If the request asks for SEVERAL images, issue every call in the SAME reply. They then render concurrently, so N images take about as long as one. Never render one, wait for it, and then ask for the next — that costs N times the wall-clock for no gain.
- Every call needs its OWN absolute out_path. If two images would land on the same path, STOP and ASK — do not overwrite and do not invent a variant path.
- The structured result is emitted to the caller IN CODE from each verb you call — do NOT format, invent, or repeat it. Your final message is a one-line human summary, or a question.
- The default backend (gpt-image-2) runs on the Codex/ChatGPT subscription. Only pass a different backend if the caller explicitly names one.`;

export default function imageExtension(pi: ExtensionAPI) {
  const log = createLogger(ROLE);
  const modelCfg = getModelConfig();

  // Extension memory, NOT LLM context.
  let activeCtx: ExtensionContext | undefined;
  let cumulativeCost = 0;
  // Set by concludeJob so agent_end knows a job finished this turn (vs. the turn being a
  // question), and can shed its context for the next, unrelated image.
  let concludedThisTurn = false;

  const refreshUI = (ctx?: ExtensionContext): void => {
    const c = ctx ?? activeCtx;
    if (!c?.hasUI) return;
    const model = c.model?.id ?? "no-model";
    c.ui.setStatus("pi-image", `● image | ${model} | $${cumulativeCost.toFixed(3)}`);
  };

  /**
   * Announce a render the moment a verb commits to it. The driver needs this BEFORE the render,
   * not after: it is the only signal that separates "the spoke is working" from "the spoke never
   * called a verb", and the latter otherwise costs the caller the whole turn budget to discover.
   */
  const emitStart = (ctx: ExtensionContext, outPath: string): void => {
    try {
      ctx.ui.notify(`${START_MARK} ${JSON.stringify({ out_path: outPath })}`, "info");
    } catch {
      /* best effort — a missed START only costs the driver its early-abort signal */
    }
  };

  /** Emit the code-derived result on the RESULT notify channel for the driver to capture. */
  const concludeJob = (ctx: ExtensionContext, result: ImageJobResult): void => {
    concludedThisTurn = true;
    try {
      ctx.ui.notify(`${RESULT_MARK} ${JSON.stringify(result)}`, result.status === "ok" ? "info" : "error");
    } catch (err) {
      log.warn("result notify failed", { err: String(err) });
    }
    log.info("job concluded", { status: result.status, op: result.op, out: result.out_path });
    refreshUI(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    if (ctx.hasUI) ctx.ui.setWorkingIndicator(undefined);
    // Belt-and-braces with --no-builtin-tools: pin the active set to exactly the verbs.
    pi.setActiveTools([...VERB_NAMES]);
    refreshUI(ctx);
    // Announce readiness so the driver can confirm the session actually booted.
    try {
      ctx.ui.notify(`${READY_MARK} pi-image up`, "info");
    } catch (err) {
      log.warn("ready notify failed", { err: String(err) });
    }
    log.info("pi-image loaded", {
      model: modelCfg.model,
      backends: listBackends().map((b) => `${b.id}${b.subscription ? "(sub)" : "(api)"}`),
    });
  });

  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + IMAGE_RULES }));

  pi.on("turn_start", async (_event, ctx) => {
    activeCtx = ctx;
  });
  pi.on("message_end", async (event, ctx) => {
    activeCtx = ctx;
    if (event.message.role === "assistant") {
      const usage = (event.message as { usage?: { cost?: { total?: number } } }).usage;
      if (usage?.cost?.total != null) cumulativeCost += usage.cost.total;
    }
    refreshUI(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    activeCtx = ctx;
    refreshUI(ctx);
  });

  // A job turn ended. If it CONCLUDED (result already emitted), shed its context so the next,
  // unrelated image starts clean — this is the warm-spoke economy that makes reusing one live
  // session across many images cheap (see DESIGN). A non-concluding turn is a question, so
  // leave context intact for the caller's reply.
  pi.on("agent_end", async (_event, ctx) => {
    activeCtx = ctx;
    if (!concludedThisTurn) return;
    concludedThisTurn = false;
    try {
      const usage = ctx.getContextUsage();
      if (usage?.tokens != null && usage.tokens > 2000) {
        ctx.compact({
          customInstructions:
            "The previous image request is complete and unrelated to the next. Discard its " +
            "prompt, paths, and result. Summarize to a single line: 'ready for next image'.",
          // "Nothing to compact" is the normal outcome for a short-lived one-shot session,
          // not a failure — logging it as WARN buries real warnings in noise.
          onError: (e) =>
            /nothing to compact/i.test(e.message)
              ? log.debug("compaction skipped", { err: e.message })
              : log.warn("compaction failed", { err: e.message }),
        });
      }
    } catch (err) {
      log.warn("compact failed", { err: String(err) });
    }
    refreshUI(ctx);
  });

  registerImageTools(pi, {
    roleLog: log,
    concludeJob,
    emitStart,
    setActiveCtx: (ctx) => {
      activeCtx = ctx;
    },
  });
}
