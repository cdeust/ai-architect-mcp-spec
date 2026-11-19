import { appendFileSync, lstatSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { loadArms } from "./plan-file.js";
import { makeClaudeInvoker } from "./claude-cli-invoker.js";
import type { CliIO } from "./cli-main.js";

type ProcessIo = Pick<CliIO, "once" | "off" | "exit"> & Pick<NodeJS.Process, "exitCode">;

export function productionIo(proc: ProcessIo, rm = rmSync, append = appendFileSync, invoker = makeClaudeInvoker): CliIO {
  return {
    rm, append, invoker, loadArms, mkdir, writeFile, stat: lstatSync,
    stdout: console.log, stderr: console.error, clock: performance.now.bind(performance),
    once: proc.once.bind(proc), off: proc.off.bind(proc), exit: proc.exit.bind(proc),
    exitCode(code) {
      proc.exitCode = code;
    },
  };
}
