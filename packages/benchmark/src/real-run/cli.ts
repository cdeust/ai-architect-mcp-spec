import { appendFileSync, lstatSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { loadArms } from "./plan-file.js";
import { makeClaudeInvoker } from "./claude-cli-invoker.js";
import { runCli } from "./cli-main.js";

process.exitCode = await runCli(process.argv.slice(2), process.env, {
  rm: rmSync, loadArms, mkdir, writeFile, append: appendFileSync, stat: lstatSync, invoker: makeClaudeInvoker,
  stdout: console.log, stderr: console.error, clock: performance.now.bind(performance),
  once: process.once.bind(process), off: process.off.bind(process), exit: process.exit,
  exitCode(code) {
    process.exitCode = code;
  },
});
