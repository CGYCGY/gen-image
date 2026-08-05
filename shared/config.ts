/**
 * shared/config.ts — load and parse config.json (the render service's settings).
 *
 * There are NO cloud creds here: image generation runs through the local `codex` CLI on the
 * Codex/ChatGPT subscription. Config covers the state dir, how to drive codex, output delivery,
 * the retry budget and the render ceiling. Every field has a default, so a missing config.json
 * still yields a working service.
 *
 * Uses only node: built-ins.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory containing this module (shared/), resolved at runtime. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute project root (shared/ lives directly under it). Self-locating: survives moves. */
export const PROJECT_DIR = resolve(HERE, "..");

/**
 * Which config.json to read: GEN_IMAGE_CONFIG if set, else the one beside this checkout.
 * Resolved per call rather than at import, so an embedder (container entrypoint, test harness)
 * can point us at a different file before the first loadConfig() without import-order games.
 */
export function configPath(): string {
  const override = process.env.GEN_IMAGE_CONFIG?.trim();
  return override ? resolve(expandTilde(override)) : resolve(PROJECT_DIR, "config.json");
}

/** How the gpt-image-2 backend drives the Codex CLI's built-in image_gen (subscription). */
export interface CodexConfig {
  /** The codex executable (on PATH, or an absolute path). */
  bin: string;
  /**
   * Model that DRIVES image_gen, not the renderer (gpt-image-2 renders whatever this is).
   * Pinned so a changed codex default can't swap it. Keep to a `code_mode` model: `code_mode_only`
   * ones (terra/luna) can't emit a direct tool call and shell out to re-read the imagegen skill
   * doc first — ~50% more tokens for an identical image.
   */
  model: string;
  /** CODEX_HOME — also where built-in image_gen writes (generated_images/). */
  home: string;
  /** codex --sandbox mode for the exec run. */
  sandbox: string;
  /** Enable network for a workspace-write run (the built-in tool reaches Codex's backend). */
  network: boolean;
  /**
   * Hard cap for a single codex exec (image gen + model reasoning). A backstop against a hung
   * codex, NOT an operating limit — generates land at 1-2 min, but an edit was killed mid-render
   * at the previous 5 min ceiling. Concurrent renders also queue provider-side, so a cap that is
   * comfortable at N=1 can false-trip under a full parallel batch and look like a render bug.
   */
  timeoutMs: number;
}

/** Delivery format for the finished render. Codex always emits PNG; this is a post-render step. */
export type OutputFormat = "preserve" | "png" | "jpeg" | "webp";

/**
 * How a finished render is delivered to the caller's out_path.
 *
 * `quality` is the ENCODER setting, unrelated to an image's `quality` render hint (which is prose
 * pasted into the codex prompt). Merging the two would cross-wire an encoder knob with a prompt.
 */
export interface OutputConfig {
  /** "preserve" honours the out_path extension; anything else rewrites it (see deliver()). */
  format: OutputFormat;
  /** 1-100, lossy formats only. 80 measured at 11.6x smaller than PNG with no visible loss. */
  quality: number;
  /** 0-6 libwebp method. 6 is 5.6% smaller than 4 for ~240 ms against a ~120 s render. */
  effort: number;
}

export interface Config {
  /** Self-located project root (not from JSON). */
  projectDir: string;
  /**
   * Where logs/, claims/ and render-slots/ live (~ expanded). Defaults INSIDE the checkout, which
   * means one checkout per machine: claims and slots are machine-wide arbitration, so two
   * checkouts would each arbitrate against themselves only. Accepted constraint — a container
   * overrides this to a mounted volume.
   */
  stateDir: string;
  /**
   * Ceiling on concurrent codex renders, enforced machine-wide through a state-dir semaphore.
   * A TUNING limit (provider throttling + local RAM: each render is a full codex subprocess),
   * never a correctness mechanism — excess callers queue rather than fail. The right number is
   * unknown and provider-dependent; 20 is a judgement call expected to move with evidence.
   */
  maxConcurrentRenders: number;
  /**
   * Keep codex's own copy of the render under CODEX_HOME/generated_images after delivery.
   * False by default: delivery is a move, which is what stops generated_images growing
   * ~2 MB per image forever. Set true to keep the sources as an evidence trail when
   * investigating a suspected mis-delivery.
   */
  keepSourceImages: boolean;
  /**
   * Extra renders allowed for ONE image after a failed attempt (0 disables retrying). Each retry
   * is a fresh `codex exec` with its own timeout, never a continuation of the failed one. Applies
   * only to transient failures; a terminal one (claim collision, ambiguous session) never retries
   * however high this is, because those are safety verdicts rather than flaky renders.
   */
  maxRetries: number;
  output: OutputConfig;
  codex: CodexConfig;
}

/** Expand a leading "~" or "~/" to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function asObj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function str(o: Record<string, unknown>, key: string, def: string): string {
  const v = o[key];
  return typeof v === "string" && v.length > 0 ? v : def;
}
function num(o: Record<string, unknown>, key: string, def: number): number {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}
function bool(o: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = o[key];
  return typeof v === "boolean" ? v : def;
}

const OUTPUT_FORMATS: readonly OutputFormat[] = ["preserve", "png", "jpeg", "webp"];

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/**
 * An unknown format falls back to "preserve" rather than throwing: honouring the caller's
 * extension is the one behaviour that is always correct. Any format added here must first be
 * verified as readable by `codex exec -i`, since today's output is tomorrow's edit input.
 */
function outputFormat(o: Record<string, unknown>): OutputFormat {
  const v = o.format;
  return OUTPUT_FORMATS.includes(v as OutputFormat) ? (v as OutputFormat) : "preserve";
}

function parseConfig(raw: unknown): Config {
  const r = asObj(raw);
  const codex = asObj(r.codex);
  const output = asObj(r.output);
  return {
    projectDir: PROJECT_DIR,
    stateDir: expandTilde(str(r, "stateDir", join(PROJECT_DIR, "state"))),
    maxConcurrentRenders: clampInt(num(r, "maxConcurrentRenders", 20), 1, 200),
    keepSourceImages: bool(r, "keepSourceImages", false),
    maxRetries: clampInt(num(r, "maxRetries", 1), 0, 5),
    output: {
      format: outputFormat(output),
      quality: clampInt(num(output, "quality", 80), 1, 100),
      effort: clampInt(num(output, "effort", 6), 0, 6),
    },
    codex: {
      bin: str(codex, "bin", "codex"),
      model: str(codex, "model", "gpt-5.6-sol"),
      home: expandTilde(str(codex, "home", join(homedir(), ".codex"))),
      sandbox: str(codex, "sandbox", "workspace-write"),
      network: bool(codex, "network", true),
      timeoutMs: num(codex, "timeoutMs", 900_000),
    },
  };
}

let cached: Config | null = null;

/** Load (and cache) the parsed config. A missing/invalid file falls back to all-defaults. */
export function loadConfig(): Config {
  if (cached) return cached;
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    raw = {};
  }
  cached = parseConfig(raw);
  return cached;
}

export function clearConfigCache(): void {
  cached = null;
}

export function getStateDir(): string {
  return loadConfig().stateDir;
}
export function getCodex(): CodexConfig {
  return loadConfig().codex;
}
export function getOutput(): OutputConfig {
  return loadConfig().output;
}
