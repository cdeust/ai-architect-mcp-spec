import { readFile, rm } from "node:fs/promises";
import { tempDirectory } from "./real-run-cli-harness.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { runCli } from "../real-run/cli-main.js";

vi.mock("../real-run/cli-main.js", { spy: true });
vi.mock("../real-run/claude-cli-invoker.js", () => ({
  makeClaudeInvoker() { throw new Error("Entry smoke requires a dry run"); },
}));
const smoke = fileURLToPath(new URL("../../real-run/plans/smoke.json", import.meta.url));

it("uses the host streams, clock, environment and exit status at the process entry", async () => {
  const dir = await tempDirectory("bench-entry-");
  const status = process.exitCode;
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const previousArgv = process.argv;
  process.argv = [process.execPath, "bench"];
  try {
    await import("../real-run/cli.js");
    expect(stderr).toHaveBeenCalledWith("Live runs require --i-accept-model-cost");
    expect(process.exitCode).toBe(1);
    const [args, env, io] = vi.mocked(runCli).mock.calls[0];
    expect(args).toEqual([]);
    expect(env).toBe(process.env);
    io.exitCode(0);
    expect(process.exitCode).toBe(0);
    const before = performance.now();
    expect(io.clock()).toBeGreaterThanOrEqual(before);
    const code = await runCli(["--dry-run", "--plan", smoke, "--out", dir], env, io);
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith("smoke: 12 expected invocations (canned)");
    expect(await readFile(join(dir, "summary.md"), "utf8")).toContain("Arm execution order: smoke");
  } finally {
    process.argv = previousArgv;
    process.exitCode = status;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});
