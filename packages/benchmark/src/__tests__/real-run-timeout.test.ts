import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { makeClaudeInvoker } from "../real-run/claude-cli-invoker.js";
import { loadArms } from "../real-run/plan-file.js";
import { runBench } from "../real-run/run-bench.js";
import { fileURLToPath } from "node:url";

it("kills a hanging executable and records the timeout on its invocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-timeout-"));
  try {
    const program = join(dir, "stand-in");
    await writeFile(program, '#!/bin/sh\necho $$ > "$0.pid"\n/bin/sleep 3 &\necho $! > \"$0.descendant\"\nwait\n', { mode: 0o700 });
    const pilot = fileURLToPath(new URL("../../real-run/plans/pilot.json", import.meta.url));
    const [{ plan }] = await loadArms(pilot);
    const started = performance.now();
    const record = await runBench(plan, {
      invoke: makeClaudeInvoker(1500, dir, program),
      record: () => {},
      clock: Date.now,
    });
    expect(record.rows[0]).toMatchObject({ error: "Claude CLI timed out after 1500 ms", usage: null });
    expect(performance.now() - started).toBeLessThan(2100);
    const descendant = Number(await readFile(program + ".descendant", "utf8"));
    await expect.poll(() => {
      try { process.kill(descendant, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }).toBe(true);
    const pid = Number(await readFile(program + ".pid", "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
