import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import "./helpers.ts";
import { clearConfigCache, configPath, loadConfig } from "../shared/config.ts";

// Assigning undefined to process.env stores the string "undefined".
function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// helpers.ts pins GEN_IMAGE_CONFIG for the whole process; these tests lift it, so they must put
// it back or every later test file would load the defaults under a deleted temp HOME.
describe("default locations", () => {
  let saved: { home?: string; config?: string };
  let home: string;

  beforeEach(() => {
    saved = { home: process.env.HOME, config: process.env.GEN_IMAGE_CONFIG };
    home = mkdtempSync(join(tmpdir(), "gen-image-home-"));
    process.env.HOME = home;
    delete process.env.GEN_IMAGE_CONFIG;
    clearConfigCache();
  });

  afterEach(() => {
    restore("HOME", saved.home);
    restore("GEN_IMAGE_CONFIG", saved.config);
    clearConfigCache();
  });

  test("a missing config means ~/.gylab/gen-image defaults", () => {
    expect(configPath()).toBe(join(home, ".gylab", "gen-image", "config.json"));
    const cfg = loadConfig();
    expect(cfg.stateDir).toBe(join(home, ".gylab", "gen-image", "state"));
    expect(cfg.codex.home).toBe(join(home, ".codex"));
  });

  test("an empty stateDir is the default; ~ expands against HOME", () => {
    const dir = join(home, ".gylab", "gen-image");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir: "" }));
    expect(loadConfig().stateDir).toBe(join(dir, "state"));

    writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir: "~/elsewhere" }));
    clearConfigCache();
    expect(loadConfig().stateDir).toBe(join(home, "elsewhere"));
  });

  test("GEN_IMAGE_CONFIG still overrides the location", () => {
    const file = join(home, "custom.json");
    writeFileSync(file, JSON.stringify({ stateDir: "/srv/state" }));
    process.env.GEN_IMAGE_CONFIG = file;
    expect(configPath()).toBe(file);
    expect(loadConfig().stateDir).toBe("/srv/state");
  });
});
