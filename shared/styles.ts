/**
 * shared/styles.ts — the style vocabulary: parse, classify, merge.
 *
 * A style is one markdown file under styles/. Two axes, two directories:
 *   looks/  medium, palette, mark-making, texture
 *   forms/  artifact kind, layout, orientation, text policy, legibility
 *
 * Names are resolved across BOTH directories (the namespaces are disjoint), so a caller never
 * has to know a name's axis to use it. Resolution is driver-side: the merged text is prepended
 * to the request before it reaches the spoke, because the spoke takes prose, not parameters.
 *
 * Contested properties (orientation, text) live ONLY in form frontmatter and resolve last-wins
 * in flag order; prose bodies concatenate in the same order. Prose cannot contradict the
 * resolved properties because the resolved block is emitted last and says it overrides.
 *
 * This module lives outside .claude/skills/ on purpose: any caller — a plan runner, a script,
 * another agent — can import it. Uses only node: built-ins + shared/config + shared/log.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PROJECT_DIR } from "./config.ts";
import { appendJsonl } from "./log.ts";

export const STYLES_DIR = join(PROJECT_DIR, "styles");

/** Closed on purpose (§ "keep it small and closed"); grow it only when a real conflict appears. */
export const CONTESTED_KEYS = ["orientation", "text"] as const;
export type ContestedKey = (typeof CONTESTED_KEYS)[number];

export type Axis = "look" | "form";
const AXIS_DIR: Record<Axis, string> = { look: "looks", form: "forms" };

export type Props = Partial<Record<ContestedKey, string>>;

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
  /** Which requested name set each winning value. */
  won: Partial<Record<ContestedKey, string>>;
  /** Bodies in flag order, then the resolved contested block. Prepend this to the request. */
  text: string;
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
 */
export function resolveStyles(names: string[]): Resolution {
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
