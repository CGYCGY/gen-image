/**
 * shared/sandbox.ts — output/input path guards, enforced in code (pi principle #3).
 *
 * pi-image writes wherever the CALLER names (e.g. a plan's images dir), so the scope is not
 * a fixed allowlist like a deploy manager's. The meaningful, fail-closed guards are: the path
 * must be ABSOLUTE (no cwd ambiguity for a long-lived spoke) and a real image extension; for
 * edits the source must exist. The destination's parent dir is created (the image workflow
 * expects IMAGES_OUTPUT_DIR auto-created).
 *
 * Uses only node: built-ins, no pi runtime dependency.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/**
 * Validate + prepare an absolute output image path; creates the parent dir. Returns resolved path.
 *
 * This is a guard, NOT a format decision: the delivered format is resolved later by the backend's
 * deliver() from `output.format` (which may rewrite this extension). All this asserts is that the
 * caller named a plausible image destination.
 */
export function validateOutPath(p: string): string {
  if (typeof p !== "string" || p.length === 0) throw new Error("out_path is required.");
  if (!isAbsolute(p)) throw new Error(`out_path must be an absolute path (got "${p}").`);
  if (!IMAGE_EXT.test(p)) throw new Error(`out_path must end in .png/.jpg/.jpeg/.webp (got "${p}").`);
  const full = resolve(p);
  mkdirSync(dirname(full), { recursive: true });
  return full;
}

/** Validate an absolute, existing source image path (for edits). Returns resolved path. */
export function validateInputPath(p: string): string {
  if (typeof p !== "string" || p.length === 0) throw new Error("input_path is required.");
  if (!isAbsolute(p)) throw new Error(`input_path must be an absolute path (got "${p}").`);
  const full = resolve(p);
  if (!existsSync(full)) throw new Error(`input_path does not exist: ${full}`);
  if (!statSync(full).isFile()) throw new Error(`input_path is not a file: ${full}`);
  if (!IMAGE_EXT.test(full)) throw new Error(`input_path must be an image (.png/.jpg/.jpeg/.webp): ${full}`);
  return full;
}
