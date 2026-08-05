#!/usr/bin/env bun
/**
 * Live end-to-end check: really spends codex renders. Not part of `bun test` (unit tests must
 * stay offline) — run it by hand, or as `bun run live`, after changing anything in the render
 * path.
 *
 *   bun test/live-render.ts                    2 images into a temp dir
 *   bun test/live-render.ts --out /abs/dir --count 3
 *   bun test/live-render.ts --style watercolor --style poster
 *
 * It drives cli/render.ts as a SUBPROCESS on purpose: what is under test includes the argv
 * handling, the single-JSON-line stdout contract and the exit code, none of which an in-process
 * call would exercise.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(resolve(HERE, ".."), "cli", "render.ts");

function flag(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : def;
}

function flags(name: string): string[] {
  return process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? [process.argv[i + 1]!] : []));
}

const outDir = resolve(flag("--out", mkdtempSync(join(tmpdir(), "gen-image-live-"))));
const count = Math.max(1, Number(flag("--count", "2")));
const styles = flags("--style");
mkdirSync(outDir, { recursive: true });

const subjects = ["a red fox curled up asleep", "a paper boat on a puddle", "a lighthouse in fog"];
const spec = {
  ...(styles.length ? { style: styles } : {}),
  images: Array.from({ length: count }, (_, i) => ({
    prompt: subjects[i % subjects.length]!,
    out_path: join(outDir, `live-${i}.png`),
  })),
};

console.error(`[live] ${count} image(s) → ${outDir}${styles.length ? ` (styles: ${styles.join(", ")})` : ""}`);
const started = Date.now();
const r = spawnSync("bun", [CLI, JSON.stringify(spec)], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const elapsed = Math.round((Date.now() - started) / 1000);

// The contract is the LAST stdout line, so parse it exactly the way a calling script would.
const lines = r.stdout.trim().split("\n");
const last = lines[lines.length - 1] ?? "";
let parsed: { kind?: string; results?: { status?: string; out_path?: string; error?: string }[] };
try {
  parsed = JSON.parse(last);
} catch {
  console.error(`[live] FAIL: last stdout line is not JSON: ${last.slice(0, 300)}`);
  process.exit(1);
}
if (lines.length !== 1) console.error(`[live] WARN: stdout had ${lines.length} lines; only the JSON line belongs there.`);

console.error(`[live] exit ${r.status} after ${elapsed}s — ${JSON.stringify(parsed)}`);
let bad = parsed.kind !== "results" || (parsed.results?.length ?? 0) !== count;
for (const res of parsed.results ?? []) {
  const path = res.out_path ?? "";
  const present = path && existsSync(path);
  // A status of ok that left no bytes on disk is the one failure a caller cannot detect itself.
  if (res.status !== "ok" || !present) bad = true;
  console.error(`[live]   ${res.status} ${path}${present ? ` (${statSync(path).size} bytes)` : " MISSING"}${res.error ? ` — ${res.error}` : ""}`);
}
console.error(bad ? "[live] FAIL" : "[live] OK");
process.exit(bad ? 1 : 0);
