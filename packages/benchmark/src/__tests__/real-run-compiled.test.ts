import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { posixTest, tempDirectory } from "./real-run-cli-harness.js";

const cli = fileURLToPath(new URL("../../dist/src/real-run/cli.js", import.meta.url));
const plan = fileURLToPath(new URL("../../real-run/plans/smoke.json", import.meta.url));

posixTest.each(["SIGTERM", "SIGHUP", "SIGQUIT"] as const)("compiled CLI handles %s sent only to its PID", async signal => {
  expect(existsSync(cli), `Run pnpm build before this test. Missing ${cli}`).toBe(true);
  const out = await tempDirectory("bench-compiled-");
  const marker = join(out, "pids");
  await writeFile(join(out, "claude"), '#!/bin/sh\n/bin/sleep 60 &\necho "$$ $!" > "$MARKER"\nwait\n', { mode: 0o700 });
  const child = spawn(process.execPath, [cli, "--i-accept-model-cost", "--plan", plan, "--out", out],
    { env: { PATH: out, MARKER: marker }, stdio: "ignore" });
  const closed = new Promise(resolve => child.once("close", (code, sig) => resolve([code, sig])));
  let pids: number[] = [];
  try {
    await expect.poll(async () => (await readFile(marker, "utf8").catch(() => "")).trim(),
      { timeout: 7000 }).toMatch(/^\d+ \d+$/);
    pids = (await readFile(marker, "utf8")).trim().split(" ").map(Number);
    child.kill(signal);
    expect(await closed).toEqual([1, null]);
    expect(JSON.parse(await readFile(join(out, "smoke/rows.jsonl"), "utf8"))).toMatchObject({
      purpose: "probe", workspace_kept: false, error: `Interrupted by ${signal}`,
    });
    expect((await readdir(join(out, "smoke"))).filter(name => name.startsWith("call-"))).toEqual([]);
    for (const pid of pids) await expect.poll(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }).toBe(true);
  } finally {
    child.kill("SIGKILL");
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await closed;
    await rm(out, { recursive: true, force: true });
  }
}, 12000);
