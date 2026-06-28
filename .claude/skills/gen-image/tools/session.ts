#!/usr/bin/env bun
// The gen-image RPC driver. Summons the gated pi-image spoke over pi's native --mode rpc,
// sends the caller's natural-language image request as a PROMPT, and relays the spoke's reply
// — a code-derived ImageJobResult, or a question for the caller.
//
// A long-lived, DETACHED `__spoke` process owns pi's stdin/stdout pipes; the CLI subcommands
// bridge to it through a FIFO (requests) + an .out file (results) so each separate
// send/generate invocation reaches the same live session. Keeping the spoke warm across many
// images in one run is the point — see DESIGN. Mirrors the deploy-via-manager driver.
//
// Subcommands:
//   generate "<NL request>"  one-shot: bring up if needed, send once; auto-down on a result
//   up                       start the persistent session (for many images / back-and-forth)
//   send "<message>"         send one request to the live session (next image / answer a question)
//   down                     stop the session
//   clean                    kill a stale spoke + clear session state

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import readline from "node:readline";

import {
  expandTilde,
  type ImageCfg,
  loadImageCfg,
  parseNotify,
  paths,
  type Paths,
  PI_NAME,
  piArgs,
  resolveImageDir,
  takeLines,
} from "./lib.ts";

// An image turn is spoke boot + codex exec (image gen + model reasoning). Bound it generously;
// overridable for slow networks / fast smoke tests.
const TURN_BUDGET_MS = Number(process.env.PI_IMAGE_TURN_TIMEOUT_MS) || 8 * 60_000;
const UP_READY_TIMEOUT_MS = Number(process.env.PI_IMAGE_READY_TIMEOUT_MS) || 60_000;

type Out =
  | { kind: "ok"; detail: string }
  | { kind: "result"; result: Record<string, unknown>; text?: string }
  | { kind: "reply"; text: string }
  | { kind: "error"; reason: string; detail: string };

/** Print the single result line the caller parses, and exit. Failed/error → exit 1. */
function emit(o: Out): never {
  process.stdout.write(`\n${JSON.stringify(o)}\n`);
  let code = 1;
  if (o.kind === "ok" || o.kind === "reply") code = 0;
  else if (o.kind === "result") code = o.result?.status === "ok" ? 0 : 1;
  process.exit(code);
}

function sleep(seconds: number): void {
  spawnSync("sleep", [String(seconds)]);
}

function readState(p: Paths): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(p.state, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sessionLive(p: Paths): boolean {
  const st = readState(p);
  return Boolean(st && pidAlive(st.pid) && existsSync(p.fifo));
}

/** SIGTERM the detached spoke, fall back to pkill-by-tag, then SIGKILL survivors; reap files. */
function tearDown(p: Paths): void {
  const st = readState(p);
  const pid = st?.pid;
  const piPid = st?.piPid;
  if (typeof pid === "number") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  spawnSync("pkill", ["-TERM", "-f", PI_NAME]);
  const deadline = Date.now() + 12_000;
  while (pidAlive(pid) && Date.now() < deadline) sleep(0.5);
  if (pidAlive(pid)) {
    for (const x of [pid, piPid])
      if (typeof x === "number")
        try {
          process.kill(x, "SIGKILL");
        } catch {
          /* gone */
        }
    sleep(1);
  }
  rmSync(p.fifo, { force: true });
  rmSync(p.out, { force: true });
  rmSync(p.state, { force: true });
}

interface BringUp {
  ok: boolean;
  reused: boolean;
  err?: Out;
}

/** Ensure a live, READY spoke session (reuse if up); spawn the detached __spoke otherwise. */
function bringUp(imageDir: string, _cfg: ImageCfg, p: Paths): BringUp {
  if (sessionLive(p)) return { ok: true, reused: true };
  mkdirSync(p.dir, { recursive: true });
  rmSync(p.fifo, { force: true });
  rmSync(p.out, { force: true });
  rmSync(p.state, { force: true });

  const spoke = spawn(process.execPath, [import.meta.path, "__spoke"], {
    cwd: imageDir,
    env: { ...process.env, PI_IMAGE_DIR: imageDir },
    detached: true,
    stdio: "ignore",
  });
  spoke.unref();

  const spawnDeadline = Date.now() + 15_000;
  while (!existsSync(p.state)) {
    if (Date.now() > spawnDeadline) {
      return {
        ok: false,
        reused: false,
        err: {
          kind: "error",
          reason: "spawn_failed",
          detail: "spoke did not start within 15s; check <stateDir>/logs/image.log and that `pi` is on PATH.",
        },
      };
    }
    sleep(0.3);
  }

  const readyDeadline = Date.now() + UP_READY_TIMEOUT_MS;
  for (;;) {
    const st = readState(p);
    if (st && !pidAlive(st.pid)) {
      tearDown(p);
      return {
        ok: false,
        reused: false,
        err: {
          kind: "error",
          reason: "spoke_down",
          detail: st.error ? String(st.error) : "spoke exited during startup; see <stateDir>/logs/image.log.",
        },
      };
    }
    if (st?.ready) return { ok: true, reused: false };
    if (Date.now() > readyDeadline) {
      tearDown(p);
      return {
        ok: false,
        reused: false,
        err: {
          kind: "error",
          reason: "ready_timeout",
          detail: `spoke did not become ready within ${Math.round(UP_READY_TIMEOUT_MS / 1000)}s; see <stateDir>/logs/image.log.`,
        },
      };
    }
    sleep(0.5);
  }
}

/** Send one prompt to the live session and block for its tagged result/reply/error. */
function sendOnce(p: Paths, message: string): Out {
  if (!sessionLive(p)) {
    return { kind: "error", reason: "no_session", detail: "no live spoke session; run `up` (or `generate`) first." };
  }
  const id = `req-${process.pid}-${Date.now()}`;
  let offset = existsSync(p.out) ? statSync(p.out).size : 0;
  appendFileSync(p.fifo, `${JSON.stringify({ id, message })}\n`);

  const deadline = Date.now() + TURN_BUDGET_MS;
  let acc = "";
  while (Date.now() < deadline) {
    const st = readState(p);
    if (st && !pidAlive(st.pid)) {
      return { kind: "error", reason: "spoke_down", detail: "spoke exited mid-request; see <stateDir>/logs/image.log." };
    }
    const size = existsSync(p.out) ? statSync(p.out).size : 0;
    if (size > offset) {
      const fd = openSync(p.out, "r");
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      offset = size;
      acc += buf.toString("utf8");
      const { lines, rest } = takeLines(acc);
      acc = rest;
      for (const line of lines) {
        let msg: {
          id?: string;
          kind?: string;
          result?: Record<string, unknown>;
          text?: string;
          reason?: string;
          detail?: string;
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== id) continue; // a stale/aborted prior turn — ignore
        if (msg.kind === "result") return { kind: "result", result: msg.result ?? {}, text: msg.text };
        if (msg.kind === "reply") return { kind: "reply", text: msg.text ?? "" };
        if (msg.kind === "error") return { kind: "error", reason: msg.reason ?? "error", detail: msg.detail ?? "" };
      }
    }
    sleep(0.5);
  }
  appendFileSync(p.fifo, `${JSON.stringify({ control: "abort" })}\n`);
  return { kind: "error", reason: "timeout", detail: `no result within ${Math.round(TURN_BUDGET_MS / 60_000)} min.` };
}

// ── CLI subcommands ──────────────────────────────────────────────────────────

function cmdGenerate(message: string): never {
  if (!message) emit({ kind: "error", reason: "bad_args", detail: "generate requires a natural-language image request." });
  const imageDir = resolveImageDir();
  const cfg = loadImageCfg(imageDir);
  const p = paths(cfg.stateDir);
  const up = bringUp(imageDir, cfg, p);
  if (up.err) emit(up.err);
  const out = sendOnce(p, message);
  // Auto-down when the image CONCLUDED in one shot; leave it up on a question so the caller
  // can answer with `send` (and `down` when finished).
  if (out.kind === "result") tearDown(p);
  emit(out);
}

function cmdUp(): never {
  const imageDir = resolveImageDir();
  const cfg = loadImageCfg(imageDir);
  const p = paths(cfg.stateDir);
  const up = bringUp(imageDir, cfg, p);
  if (up.err) emit(up.err);
  emit({ kind: "ok", detail: up.reused ? "spoke already up" : "spoke up and ready" });
}

function cmdSend(message: string): never {
  if (!message) emit({ kind: "error", reason: "bad_args", detail: "send requires a message." });
  const imageDir = resolveImageDir();
  const cfg = loadImageCfg(imageDir);
  const p = paths(cfg.stateDir);
  emit(sendOnce(p, message)); // never auto-downs — the caller controls the session lifecycle
}

function cmdDown(): never {
  const imageDir = resolveImageDir();
  const cfg = loadImageCfg(imageDir);
  const p = paths(cfg.stateDir);
  const had = sessionLive(p) || existsSync(p.state);
  tearDown(p);
  emit({ kind: "ok", detail: had ? "spoke session ended" : "no live session" });
}

function cmdClean(): never {
  let stateDir = "~/.pi-image";
  try {
    stateDir = loadImageCfg(resolveImageDir()).stateDir;
  } catch {
    /* fall back to default state dir for cleanup */
  }
  const p = paths(expandTilde(stateDir));
  const r = spawnSync("pkill", ["-TERM", "-f", PI_NAME], { encoding: "utf8" });
  sleep(1);
  rmSync(p.fifo, { force: true });
  rmSync(p.out, { force: true });
  rmSync(p.state, { force: true });
  emit({
    kind: "ok",
    detail: r.status === 0 ? "killed stale spoke + cleared session state" : "no stale spoke found; session state cleared",
  });
}

// ── The detached spoke: owns the pi RPC pipes, bridges FIFO ↔ .out ─────────────

function runSpoke(): never {
  const imageDir = resolveImageDir();
  const cfg = loadImageCfg(imageDir);
  const p = paths(cfg.stateDir);
  mkdirSync(p.dir, { recursive: true });
  if (!existsSync(p.fifo)) spawnSync("mkfifo", [p.fifo]);

  const child = spawn("pi", piArgs(imageDir, cfg), {
    cwd: imageDir,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const state: Record<string, unknown> = { pid: process.pid, piPid: child.pid, ready: false, startedAt: Date.now() };
  const writeState = (): void => {
    try {
      writeFileSync(p.state, JSON.stringify(state));
    } catch {
      /* best effort */
    }
  };
  writeState();

  const send = (obj: unknown): void => {
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* pipe closed */
    }
  };
  const append = (obj: unknown): void => {
    try {
      appendFileSync(p.out, `${JSON.stringify(obj)}\n`);
    } catch {
      /* best effort */
    }
  };

  let current: { id: string; result?: Record<string, unknown> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearCurrent = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    current = null;
  };

  const shutdown = (): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* gone */
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      process.exit(0);
    }, 8_000);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  child.on("exit", (code) => {
    state.error = `spoke pi exited (code ${code ?? "killed"})`;
    writeState();
    if (current) {
      append({ id: current.id, kind: "error", reason: "spoke_down", detail: state.error });
      clearCurrent();
    }
    process.exit(0);
  });

  let buf = "";
  child.stdout.on("data", (b: Buffer) => {
    buf += b.toString();
    const { lines, rest } = takeLines(buf);
    buf = rest;
    for (const line of lines) handle(line);
  });

  function handle(line: string): void {
    let msg: { type?: string; id?: string; data?: { text?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const note = parseNotify(msg);
    if (note.ready) {
      if (!state.ready) {
        state.ready = true;
        writeState();
      }
      return;
    }
    if (note.result !== undefined) {
      if (current) current.result = note.result as Record<string, unknown>;
      return;
    }
    if (msg.type === "agent_end") {
      if (!current) return; // a stray end between requests
      send({ type: "get_last_assistant_text", id: `verdict:${current.id}` });
      return;
    }
    if (msg.type === "response" && current && msg.id === `verdict:${current.id}`) {
      const text = (msg.data?.text ?? "").trim();
      // An image CONCLUDED iff the spoke emitted its code-derived result this turn; otherwise
      // the assistant text is a question/status to relay back to the caller.
      if (current.result !== undefined) append({ id: current.id, kind: "result", result: current.result, text });
      else append({ id: current.id, kind: "reply", text });
      clearCurrent();
    }
  }

  // Block-read the FIFO line by line, reopening after each writer closes (one request per
  // send/generate). Requests are serialized by the caller (one in flight at a time).
  async function loop(): Promise<void> {
    for (;;) {
      const stream = createReadStream(p.fifo);
      const rl = readline.createInterface({ input: stream });
      for await (const raw of rl) {
        const line = raw.trim();
        if (!line) continue;
        let req: { id?: string; message?: string; control?: string };
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        if (req.control === "abort") {
          send({ type: "abort" });
          if (current) {
            append({ id: current.id, kind: "error", reason: "timeout", detail: "aborted by client (turn budget exceeded)." });
            clearCurrent();
          }
          continue;
        }
        if (req.id && typeof req.message === "string") {
          current = { id: req.id };
          const reqId = req.id;
          timer = setTimeout(() => {
            send({ type: "abort" });
            if (current?.id === reqId) {
              append({ id: reqId, kind: "error", reason: "timeout", detail: "spoke produced no turn end in time." });
            }
            clearCurrent();
          }, TURN_BUDGET_MS + 60_000);
          send({ type: "prompt", message: req.message, id: req.id });
        }
      }
      // writer closed; reopen for the next request.
    }
  }
  void loop();
  return undefined as never;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const sub = process.argv[2];
const message = process.argv.slice(3).join(" ").trim();
try {
  if (sub === "generate") cmdGenerate(message);
  else if (sub === "up") cmdUp();
  else if (sub === "send") cmdSend(message);
  else if (sub === "down") cmdDown();
  else if (sub === "clean") cmdClean();
  else if (sub === "__spoke") runSpoke();
  else {
    process.stdout.write("usage: session.ts <generate|up|send|down|clean> [message]\n");
    process.exit(2);
  }
} catch (err) {
  emit({ kind: "error", reason: "driver_error", detail: (err as Error).message });
}
