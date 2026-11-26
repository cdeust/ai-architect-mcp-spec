import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { loadArms } from "../real-run/plan-file.js";
import { runBench } from "../real-run/run-bench.js";
import { cannedInvoke } from "../real-run/canned-ports.js";
import { harness, posixTest, tempDirectory } from "./real-run-cli-harness.js";

const cwd = fileURLToPath(new URL("../../", import.meta.url));

posixTest.each(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "exit"] as const)("journals the interrupted invocation and kills its group on %s", async signal => {
  const out = await tempDirectory("bench-signal-");
  const marker = join(out, "pids");
  const standIn = join(out, "claude");
  let pids: number[] = [];
  await writeFile(standIn, '#!/bin/sh\n/bin/sleep 20 &\necho "$$ $!" > "$MARKER"\nwait\n', { mode: 0o700 });
  const exitCode = vi.fn();
  const host = harness({ PATH: out, MARKER: marker }, { exitCode });
  const exiting = vi.spyOn(host.io, "exit");
  const stderr = vi.spyOn(host.io, "stderr");
  const run = host.run("--i-accept-model-cost", "--plan", "real-run/plans/smoke.json", "--out", out);
  try {
    await expect.poll(async () => {
      const content = await readFile(marker, "utf8").catch(() => "");
      pids = content.trim().split(" ").map(Number);
      return pids.length;
    }, { timeout: 3000 }).toBe(2);
    host.events.emit(signal);
    expect(exitCode).toHaveBeenCalledWith(1);
    if (signal !== "exit") expect(exiting).toHaveBeenCalledWith(1);
    const row = JSON.parse(readFileSync(join(out, "smoke/rows.jsonl"), "utf8"));
    expect(row).toMatchObject({ purpose: "probe", usage: null, error: `Interrupted by ${signal === "exit" ? "CLI exit" : signal}` });
    const result = await run;
    expect(result.status).toBe(1);
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(out, "smoke/rows.jsonl"), "utf8"))).toEqual(row);
    expect(host.events.eventNames()).toEqual([]);
    for (const pid of pids) await expect.poll(() => {
      try {
        process.kill(pid, 0);
        return false;
      }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }).toBe(true);
  } finally {
    for (const pid of pids.filter(pid => pid > 0)) {
      try { process.kill(pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await run;
    await rm(out, { recursive: true, force: true });
  }
});

async function parallelStandIn(file: string, out: string, onBatch = [
    'if /bin/mkdir "$OUT/claimed" 2>/dev/null; then',
    '  pwd > "$OUT/kept"', 'fi', 'pwd >> "$OUT/ready"', 'exec /bin/sleep 10',
  ]) {
  const [{ plan }] = await loadArms(file);
  const fixture = JSON.parse(await readFile(join(cwd, "src/__tests__/fixtures/claude-cli-result.json"), "utf8"));
  let calls = 0;
  const canned = await runBench(plan, { clock: Date.now, record: () => {}, invoke: async inv => {
    const index = calls++;
    const result = await cannedInvoke(inv);
    await writeFile(join(out, "reply-" + index), JSON.stringify({ ...fixture, result: result.text }));
    return result;
  } });
  const start = canned.rows.findIndex((row, i) => row.batch_id === canned.rows[i + 1]?.batch_id);
  expect(start).toBeGreaterThanOrEqual(0);
  const batch = canned.rows.filter(row => row.batch_id === canned.rows[start].batch_id);
  await writeFile(join(out, "claude"), [
    "#!/bin/sh", "/bin/cat >/dev/null", 'count=$(/usr/bin/wc -l < "$OUT/parallel/rows.jsonl")',
    'if [ "$count" -lt "$START" ]; then exec /bin/cat "$OUT/reply-$((count))"; fi',
    ...onBatch,
  ].join("\n"), { mode: 0o700 });
  return { batch, start };
}

posixTest("journals the entire interrupted parallel batch when one workspace cannot be removed", async () => {
  const out = await tempDirectory("bench-parallel-exit-");
  const dir = join(out, "parallel");
  let run: Promise<unknown> | undefined;
  let interrupt: (() => void) | undefined;
  try {
    const file = join(out, "plan.json");
    const pilot = JSON.parse(await readFile(join(cwd, "real-run/plans/pilot.json"), "utf8"));
    pilot.arms = [{ ...pilot.arms[0], name: "parallel", mode: "parallel" }];
    await writeFile(file, JSON.stringify(pilot));
    const { batch, start } = await parallelStandIn(file, out);
    let blockedWorkspace: string | undefined;
    const host = harness({ PATH: out, OUT: out, START: String(start) }, {
      rm(path, options) {
        if (path === blockedWorkspace) {
          const denied = new Error("Workspace removal denied (EACCES)");
          throw Object.assign(denied, { code: "EACCES" });
        }
        rmSync(path, options);
      },
    });
    run = host.run("--i-accept-model-cost", "--plan", file, "--out", out);
    interrupt = () => host.events.emit("SIGTERM");
    const readyMarker = join(out, "ready");
    await expect.poll(async () => (await readFile(readyMarker, "utf8").catch(() => "")).split("\n").filter(Boolean).length,
      { timeout: 4000 }).toBe(batch.length);
    blockedWorkspace = (await readFile(join(out, "kept"), "utf8")).trim();
    expect((await readFile(readyMarker, "utf8")).split("\n")).toContain(blockedWorkspace);
    interrupt();
    const rows = readFileSync(join(dir, "rows.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const interrupted = rows.filter(row => row.error === "Interrupted by SIGTERM");
    expect(interrupted.map(row => row.invocation_id).sort()).toEqual(batch.map(row => row.invocation_id).sort());
    expect(interrupted.filter(row => row.workspace_kept)).toHaveLength(1);
    expect(interrupted.find(row => row.workspace_kept).workspace_removal_error).toMatch(/EACCES|EPERM|ENOTEMPTY/);
  } finally {
    interrupt?.();
    await run;
    await rm(out, { recursive: true, force: true });
  }
});

posixTest("drains a failed parallel batch before removing any process handler", async () => {
  const out = await tempDirectory("bench-journal-failure-");
  const journal = join(out, "parallel/rows.jsonl");
  const marker = join(out, "ready");
  let pids: number[] = [];
  let run: ReturnType<ReturnType<typeof harness>["run"]> | undefined;
  try {
    const file = join(out, "plan.json");
    const pilot = JSON.parse(await readFile(join(cwd, "real-run/plans/pilot.json"), "utf8"));
    pilot.arms = [{ ...pilot.arms[0], name: "parallel", mode: "parallel" }];
    await writeFile(file, JSON.stringify(pilot));
    // Register the wait before announcing readiness. Each peer stays alive until
    // the host kills it; only the elected child can release a complete reply.
    const child = join(cwd, "src/__tests__/fixtures/journal-failure-child.cjs");
    const { batch, start } = await parallelStandIn(file, out, ['exec "$NODE" "$BATCH_CHILD"']);
    let writes = 0;
    const host = harness({ PATH: out, OUT: out, START: String(start), NODE: process.execPath, BATCH_CHILD: child, DRIVER_PID: String(process.pid) }, {
      append(path, data, options) {
        if (writes++ === start) {
          expect(JSON.parse(String(data)).error).toBeNull();
          throw new Error("journal unavailable");
        }
        appendFileSync(path, data, options);
      },
    });
    const atDisposal: number[] = [];
    const off = host.io.off;
    host.io.off = (event, handler) => {
      atDisposal.push(writes);
      off(event, handler);
    };
    run = host.run("--i-accept-model-cost", "--plan", file, "--out", out);
    await expect.poll(async () => {
      const ready = await readFile(marker, "utf8").catch(() => "");
      pids = ready.trim().split(/\s+/).filter(Boolean).map(Number);
      return pids.length;
    }, { timeout: 4000 }).toBe(batch.length);
    expect(pids.length).toBeGreaterThan(1);
    await writeFile(join(out, "release"), "");
    expect(await run).toMatchObject({ status: 1, stderr: "journal unavailable" });
    expect(atDisposal).toEqual(Array(5).fill(start + batch.length));
    const rows = readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.slice(start).map(row => row.error)).toEqual(Array(batch.length - 1).fill("Claude CLI exited with SIGKILL: Claude CLI returned invalid or incomplete JSON"));
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  } finally {
    // Also release any fixture that has not announced its PID yet.
    await writeFile(join(out, "stop"), "");
    await run;
    await rm(out, { recursive: true, force: true });
  }
});

posixTest.each(["SIGTERM", "IPC disconnect"] as const)("the journal driver and its detached child release their pipes on %s", async interruption => {
  const out = await tempDirectory("bench-driver-exit-");
  const script = join(cwd, "src/__tests__/fixtures/journal-failure-driver.cjs");
  const driver = spawn(process.execPath, [script], { env: { OUT: out }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let pid = "";
  let stderr = "";
  const closed = () => (driver.exitCode !== null || driver.signalCode !== null)
    && driver.stdout.closed && driver.stderr.closed && !driver.connected;
  driver.stdout.setEncoding("utf8").on("data", text => { pid += text; });
  driver.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
  try {
    await expect.poll(async () => (await readFile(join(out, "ready"), "utf8").catch(() => "")).trim(),
      { timeout: 4000 }).toMatch(/^\d+$/);
    const ready = (await readFile(join(out, "ready"), "utf8")).trim();
    await expect.poll(() => pid).toBe(ready);
    if (interruption === "SIGTERM") driver.kill("SIGTERM");
    else driver.disconnect(); // Closing the worker's end is also what the OS does on worker loss.
    // The detached child inherits these pipes; the driver exiting alone cannot close them.
    await expect.poll(closed, { timeout: 4000 }).toBe(true);
    if (interruption === "SIGTERM") expect(driver.signalCode).toBe("SIGTERM");
    else expect(driver.exitCode).toBe(0);
    expect(stderr).toContain("Journal fixture driver finished");
  } finally {
    if (!closed()) {
      // Covers a failed readiness assertion, including a child yet to announce itself.
      await writeFile(join(out, "stop"), "");
      if (driver.connected) driver.disconnect();
      driver.kill("SIGTERM");
      await expect.poll(closed, { timeout: 4000 }).toBe(true);
    }
    await rm(out, { recursive: true, force: true });
  }
});

posixTest("a journal fixture starting after teardown exits while its driver is still alive", async () => {
  const out = await tempDirectory("bench-driver-stop-");
  try {
    await writeFile(join(out, "stop"), "");
    const fixture = join(cwd, "src/__tests__/fixtures/journal-failure-child.cjs");
    const child = spawnSync(process.execPath, [fixture], {
      env: { OUT: out, DRIVER_PID: String(process.pid) }, encoding: "utf8", timeout: 4000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("Journal fixture driver finished");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it("propagates the journal error for a parallel host with no child processes", async () => {
  const [{ plan }] = await loadArms(join(cwd, "real-run/plans/pilot.json"));
  const failure = new Error("unwritable");
  await expect(runBench({ ...plan, mode: "parallel" }, { clock: Date.now, invoke: cannedInvoke,
    record() { throw failure; },
  })).rejects.toBe(failure);
});
