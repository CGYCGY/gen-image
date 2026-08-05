/**
 * Shared unit-test rig. Importing this points the config loader at a throwaway state dir, so a
 * test never scribbles into the checkout's state/ — and never at the machine-wide claims and
 * render-slots a real render arbitrates through.
 *
 * The side effect runs at import: config is loaded lazily, so every later loadConfig() in the
 * process sees this file regardless of which test module got there first.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearConfigCache } from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";
import type { BackendResult, ImageBackend } from "../image/backends/types.ts";

export const TEST_ROOT = mkdtempSync(join(tmpdir(), "gen-image-test-"));

writeFileSync(
  join(TEST_ROOT, "config.json"),
  JSON.stringify({ stateDir: join(TEST_ROOT, "state"), maxRetries: 1 }),
);
process.env.GEN_IMAGE_CONFIG = join(TEST_ROOT, "config.json");
clearConfigCache();

/** An absolute out_path under the test root — nothing writes there unless a test says so. */
export function outPath(name: string): string {
  return join(TEST_ROOT, "out", name);
}

/**
 * A file an edit's input_path can point at. The bytes are irrelevant — the guard checks that the
 * path is absolute, exists, is a file and looks like an image; nothing decodes it.
 */
export function existingImage(name = "source.png"): string {
  const path = join(TEST_ROOT, "in", name);
  mkdirSync(join(TEST_ROOT, "in"), { recursive: true });
  writeFileSync(path, "not really png");
  return path;
}

export const silentLog: Logger = {
  path: join(TEST_ROOT, "silent.log"),
  log: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function okBackendResult(outPath: string, over: Partial<BackendResult> = {}): BackendResult {
  return { backend: "stub", model: "stub-model", outPath, bytes: 4096, format: "png", ...over };
}

export interface StubBackend extends ImageBackend {
  calls: { op: "generate" | "edit"; outPath: string; text: string }[];
}

/**
 * A backend whose behaviour a test dictates per attempt. `run` receives the 1-based attempt
 * number for THIS stub, so a test can fail the first attempt and succeed on the retry.
 */
export function stubBackend(
  run: (attempt: number, outPath: string) => BackendResult = (_a, p) => okBackendResult(p),
): StubBackend {
  const calls: StubBackend["calls"] = [];
  const stub: StubBackend = {
    id: "stub",
    label: "stub backend",
    subscription: false,
    calls,
    async generate({ prompt, outPath }) {
      calls.push({ op: "generate", outPath, text: prompt });
      return run(calls.length, outPath);
    },
    async edit({ instruction, outPath }) {
      calls.push({ op: "edit", outPath, text: instruction });
      return run(calls.length, outPath);
    },
  };
  return stub;
}
