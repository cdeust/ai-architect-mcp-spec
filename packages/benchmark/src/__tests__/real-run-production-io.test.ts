import { appendFileSync, lstatSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { productionIo } from "../real-run/production-io.js";
import { makeClaudeInvoker } from "../real-run/claude-cli-invoker.js";
import { loadArms } from "../real-run/plan-file.js";

it("binds process operations and supplies production adapters", () => {
  const proc = { once: vi.fn(), off: vi.fn(), exit: vi.fn(), exitCode: 0, platform: "win32" as const };
  const io = productionIo(proc);
  expect(io).toMatchObject({ append: appendFileSync, rm: rmSync, stat: lstatSync, mkdir,
    writeFile, loadArms, invoker: makeClaudeInvoker, stdout: console.log, stderr: console.error, platform: "win32" });
  const handler = vi.fn();
  io.once("SIGTERM", handler);
  io.off("exit", handler);
  io.exit(3);
  io.exitCode(4);
  expect(proc.once).toHaveBeenCalledExactlyOnceWith("SIGTERM", handler);
  expect(proc.off).toHaveBeenCalledExactlyOnceWith("exit", handler);
  expect(proc.exit).toHaveBeenCalledExactlyOnceWith(3);
  for (const method of [proc.once, proc.off, proc.exit]) expect(method.mock.contexts).toEqual([proc]);
  expect(proc.exitCode).toBe(4);
});

it("passes the supplied filesystem and invoker functions through", () => {
  const rm = vi.fn(), append = vi.fn(), invoker = vi.fn();
  expect(productionIo(process, rm, append, invoker)).toMatchObject({ rm, append, invoker });
});
