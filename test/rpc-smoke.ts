#!/usr/bin/env bun
// RPC smoke test: summon pi-image over pi's native --mode rpc exactly as a real caller would,
// send ONE generate request, and verify the code-derived RESULT plus the file on disk. This is
// the "rpc way" end-to-end — no SDK shortcuts. Run from the dir you want the image saved in:
//
//   bun test/rpc-smoke.ts                       -> ./pi-image-smoke.png, default prompt
//   bun test/rpc-smoke.ts --out /abs/x.png --prompt "a red fox"
//
// Exit 0 = ok result + file present; 1 = failed/question; 2 = timeout.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../shared/config.ts";
import { PI_NAME, READY_MARK, RESULT_MARK } from "../shared/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(HERE, "..");
const EXT = join(PROJECT_DIR, "image", "index.ts");

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : def;
}

const outPath = resolve(arg("--out", join(process.cwd(), "pi-image-smoke.png")));
const prompt = arg(
  "--prompt",
  "a cute cartoon water droplet character with a happy smiling face, kawaii style, clean simple background",
);

const cfg = loadConfig();
const piArgs = ["--no-extensions", "--no-builtin-tools", "-nc", "--no-session", "--mode", "rpc", "-e", EXT, "--name", PI_NAME];
if (cfg.model) piArgs.push("--model", cfg.model);
if (cfg.thinking) piArgs.push("--thinking", cfg.thinking);

console.log(`[smoke] launching: pi ${piArgs.join(" ")}`);
console.log(`[smoke] out=${outPath}`);

const child = spawn("pi", piArgs, { cwd: PROJECT_DIR, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });

function send(obj: unknown): void {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

const reqId = `smoke-${process.pid}`;
let ready = false;
let result: Record<string, unknown> | undefined;
let done = false;

const TIMEOUT_MS = 6 * 60_000;
const timer = setTimeout(() => finish(2, "timeout waiting for a result"), TIMEOUT_MS);

function finish(code: number, note: string): void {
  if (done) return;
  done = true;
  clearTimeout(timer);
  console.log(`\n[smoke] ${note}`);
  if (result) console.log("[smoke] RESULT " + JSON.stringify(result));
  if (existsSync(outPath)) console.log(`[smoke] file OK: ${outPath} (${statSync(outPath).size} bytes)`);
  else console.log(`[smoke] file MISSING: ${outPath}`);
  try {
    send({ type: "abort" });
  } catch {
    /* pipe may be closed */
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
    process.exit(code);
  }, 1500);
}

function handle(line: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "extension_ui_request" && msg.method === "notify") {
    const text = String(msg.message ?? "");
    if (text.startsWith(READY_MARK)) {
      if (!ready) {
        ready = true;
        console.log("[smoke] spoke ready; sending request…");
        send({ type: "prompt", id: reqId, message: `Generate this image and save it to ${outPath}: ${prompt}` });
      }
      return;
    }
    if (text.startsWith(RESULT_MARK)) {
      try {
        result = JSON.parse(text.slice(RESULT_MARK.length).trim());
      } catch {
        result = { raw: text };
      }
      return;
    }
    if (msg.notifyType) console.log(`[notify:${msg.notifyType}] ${msg.message}`);
    return;
  }
  if (msg.type === "tool_execution_start") console.log(`[tool] ${msg.toolName} start`);
  if (msg.type === "tool_execution_end") console.log(`[tool] ${msg.toolName} end (error=${msg.isError})`);
  if (msg.type === "agent_end") {
    if (result) finish(result.status === "ok" ? 0 : 1, `agent finished (status ${result.status})`);
    else finish(1, "agent finished with no structured result (likely a question or error)");
  }
}

let buf = "";
child.stdout.on("data", (b: Buffer) => {
  buf += b.toString();
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    let line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim()) handle(line);
  }
});
child.stderr.on("data", (b: Buffer) => process.stderr.write(b));
child.on("exit", (code) => finish(code ?? 1, `pi exited (${code})`));
