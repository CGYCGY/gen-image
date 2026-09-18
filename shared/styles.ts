/**
 * shared/styles.ts — the style vocabulary: parse, classify, merge.
 *
 * A style is one markdown file under styles/. Two axes, two directories:
 *   looks/  medium, palette, mark-making, texture
 *   forms/  artifact kind, layout, orientation, text policy, legibility
 *
 * Names are resolved across BOTH directories (the namespaces are disjoint), so a caller never
 * has to know a name's axis to use it. The merged text is prepended to the image's own
 * prompt/instruction before the render, because the backend takes prose, not parameters.
 *
 * Contested properties (orientation, text) live ONLY in form frontmatter and resolve last-wins
 * in flag order; prose bodies concatenate in the same order. Prose cannot contradict the
 * resolved properties because the resolved block is emitted last and says it overrides.
 *
 * A caller's explicit `size` is the most specific statement of aspect there is, so it takes the
 * orientation slot in that block instead of competing with the form's default from a softer
 * sentence elsewhere in the prompt. Observed before this: 1536x1024 under a 16:9 form came back
 * 16:9 on 9 of 10 renders.
 *
 * Importable on its own — a plan runner or a script can list and resolve styles without going
 * through the CLI. Uses only node: built-ins + shared/config + shared/log.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PROJECT_DIR } from "./config.ts";
import { appendJsonl } from "./log.ts";

export const STYLES_DIR = join(PROJECT_DIR, "styles");

/** Closed on purpose; grow it only when a real conflict appears (DESIGN §5). */
export const CONTESTED_KEYS = ["orientation", "text"] as const;
export type ContestedKey = (typeof CONTESTED_KEYS)[number];

export type Axis = "look" | "form";
const AXIS_DIR: Record<Axis, string> = { look: "looks", form: "forms" };

export type Props = Partial<Record<ContestedKey, string>>;

/** The `won` entry for a value that came from the caller's `size`, not from a style file. */
export const SIZE_WON = "size";

export const SIZE_RE = /^(\d+)x(\d+)$/;

/**
 * "1536x1024" → "landscape 3:2, exactly 1536x1024 pixels". Reduced ratios past 20 (1672x941 is
 * 1672:941) say nothing a reader can picture, so those get the bare dimensions.
 */
export function orientationOf(size: string): string | undefined {
  const m = SIZE_RE.exec(size.trim());
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w === 0 || h === 0) return undefined;
  const shape = w === h ? "square" : w > h ? "landscape" : "portrait";
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h);
  const ratio = Math.max(w / g, h / g) <= 20 ? ` ${w / g}:${h / g}` : "";
  return `${shape}${ratio}, exactly ${w}x${h} pixels`;
}

export interface StyleFile {
  name: string;
  axis: Axis;
  /** Path relative to styles/ — what the log records. */
  rel: string;
  path: string;
  /** sha256 prefix of the file's bytes: says whether a preset changed under you. */
  sha: string;
  props: Props;
  body: string;
}

export interface Resolution {
  /** The names as the caller ordered them; order IS precedence. */
  requested: string[];
  files: StyleFile[];
  /** Winning value per contested key. */
  props: Props;
  /** Which requested name set each winning value; SIZE_WON when the caller's `size` did. */
  won: Partial<Record<ContestedKey, string>>;
  /** Bodies in flag order, then the resolved contested block. Prepend this to the request. */
  text: string;
}

export interface ResolveOptions {
  /** The image's own `size` ("WxH" in pixels). Overrides any form's orientation. */
  size?: string;
}

function listAxis(axis: Axis): string[] {
  const dir = join(STYLES_DIR, AXIS_DIR[axis]);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

export function listStyles(): { looks: string[]; forms: string[] } {
  return { looks: listAxis("look"), forms: listAxis("form") };
}

function availableSet(): string {
  const { looks, forms } = listStyles();
  return `Available looks: ${looks.join(", ") || "(none)"}. Available forms: ${forms.join(", ") || "(none)"}.`;
}

function isContested(key: string): key is ContestedKey {
  return (CONTESTED_KEYS as readonly string[]).includes(key);
}

function parseFrontmatter(raw: string, rel: string): { props: Props; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { props: {}, body: raw.trim() };
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error(`${rel}: frontmatter opened with --- but never closed.`);

  const props: Props = {};
  for (const line of lines.slice(1, end)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const colon = t.indexOf(":");
    if (colon < 0) throw new Error(`${rel}: frontmatter line is not "key: value": ${t}`);
    const key = t.slice(0, colon).trim();
    // A trailing " # …" is a comment (the documented file format shows one); a bare '#'
    // inside a value is not.
    const value = t.slice(colon + 1).replace(/\s+#.*$/, "").trim();
    if (!isContested(key)) {
      throw new Error(`${rel}: unknown frontmatter key "${key}". Contested properties: ${CONTESTED_KEYS.join(", ")}.`);
    }
    if (!value) throw new Error(`${rel}: frontmatter key "${key}" has no value.`);
    props[key] = value;
  }
  return { props, body: lines.slice(end + 1).join("\n").trim() };
}

function loadStyle(name: string): StyleFile {
  const hits = (["look", "form"] as const)
    .map((axis) => ({ axis, path: join(STYLES_DIR, AXIS_DIR[axis], `${name}.md`) }))
    .filter((h) => existsSync(h.path));

  if (hits.length === 0) throw new Error(`unknown style "${name}". ${availableSet()}`);
  if (hits.length > 1) {
    // Disjoint namespaces are what let the caller pass a bare name; a collision would make
    // resolution depend on lookup order instead of on the file.
    throw new Error(`style "${name}" exists as both a look and a form; names must be unique across styles/.`);
  }

  const hit = hits[0]!;
  const rel = `${AXIS_DIR[hit.axis]}/${name}.md`;
  const raw = readFileSync(hit.path, "utf8");
  const { props, body } = parseFrontmatter(raw, rel);
  if (hit.axis === "look" && Object.keys(props).length > 0) {
    throw new Error(`${rel}: a look must not set ${Object.keys(props).join(", ")} — contested properties belong to forms.`);
  }
  return {
    name,
    axis: hit.axis,
    rel,
    path: hit.path,
    sha: createHash("sha256").update(raw).digest("hex").slice(0, 12),
    props,
    body,
  };
}

/**
 * Resolve style names in caller order. Throws on an unknown name, listing the available set —
 * a wrong guess self-corrects in one round trip, so no caller needs to preload an index.
 *
 * With no names and no size the text is empty; with a size alone it is just the override block,
 * so an unstyled image still states its aspect in the strongest voice the prompt has.
 */
export function resolveStyles(names: string[], opts: ResolveOptions = {}): Resolution {
  const files = names.map(loadStyle);
  const props: Props = {};
  const won: Partial<Record<ContestedKey, string>> = {};
  for (const f of files) {
    for (const key of CONTESTED_KEYS) {
      const v = f.props[key];
      if (v === undefined) continue;
      props[key] = v;
      won[key] = f.name;
    }
  }
  if (opts.size !== undefined) {
    const o = orientationOf(opts.size);
    if (o === undefined) throw new Error(`size must be "WxH" in pixels, e.g. "1536x1024" (got "${opts.size}").`);
    props.orientation = o;
    won.orientation = SIZE_WON;
  }

  const parts = files.map((f) => f.body).filter(Boolean);
  const settled = CONTESTED_KEYS.filter((k) => props[k] !== undefined);
  if (settled.length > 0) {
    parts.push(
      ["These override anything above:", ...settled.map((k) => `- ${k}: ${props[k]}`)].join("\n"),
    );
  }
  return { requested: [...names], files, props, won, text: parts.join("\n\n") };
}

/**
 * The rules true of every image, appended by the backend so no preset can omit them and no
 * calling agent can forget them. Missing file throws: silently rendering without them is the
 * failure this placement exists to prevent.
 */
export function baseRules(): string {
  const path = join(STYLES_DIR, "base.md");
  if (!existsSync(path)) throw new Error(`missing ${path} — base rules apply to every image.`);
  return readFileSync(path, "utf8").trim();
}

/**
 * One line per resolution in <stateDir>/logs/styles.jsonl. Deliberately carries NO prompt or
 * request text: the caller already has the request, and a permanent local record of every
 * prompt has no use that justifies it.
 */
export function logResolution(res: Resolution): void {
  appendJsonl("styles", {
    ts: new Date().toISOString(),
    requested: res.requested,
    resolved: res.files.map((f) => ({ f: f.rel, sha: f.sha })),
    won: res.won,
  });
}

/** A failed lookup is a record of a preset someone wanted and we don't have — the best input to what to write next. */
export function logResolutionFailure(requested: string[], error: string): void {
  appendJsonl("styles", { ts: new Date().toISOString(), requested, error });
}
