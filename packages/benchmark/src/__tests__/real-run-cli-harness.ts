import { appendFileSync, lstatSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { makeClaudeInvoker } from "../real-run/claude-cli-invoker.js";
import { runCli, type CliIO } from "../real-run/cli-main.js";
import { loadArms } from "../real-run/plan-file.js";

const base = fileURLToPath(new URL("../../", import.meta.url));

// Native executable fixtures use /bin/sh and POSIX signals. Pure CLI tests use the injected host.
export const posixTest = it.skipIf(process.platform !== "darwin" && process.platform !== "linux");

export async function tempDirectory(prefix: string) {
  return realpath(await mkdtemp(resolve(tmpdir(), prefix)));
}

export function harness(env: NodeJS.ProcessEnv, overrides: Partial<CliIO> = {}) {
  const events = new EventEmitter();
  const output: string[] = [];
  const errors: string[] = [];
  const io: CliIO = {
    platform: "linux",
    loadArms: path => loadArms(resolve(base, path)),
    invoker(timeout, directory, program, track, childEnv, remove) {
      if (!env.PATH || program !== "claude") throw new Error("Unexpected live executable");
      return makeClaudeInvoker(timeout, directory, resolve(env.PATH, program), track, childEnv, remove);
    },
    rm: rmSync, mkdir, writeFile, append: appendFileSync, stat: lstatSync,
    clock: Date.now,
    stdout: line => output.push(line),
    stderr: line => errors.push(line),
    once: events.once.bind(events), off: events.off.bind(events),
    exit: () => events.emit("exit"),
    exitCode: () => {},
    ...overrides,
  };
  async function run(...argv: string[]) {
    const status = await runCli(argv, { PATH: "", ...env }, io);
    return { status, stdout: output.join("\n"), stderr: errors.join("\n") };
  }
  return { run, events, io };
}

export function localCli(env: NodeJS.ProcessEnv, ...args: string[]) {
  return harness(env).run(...args);
}
