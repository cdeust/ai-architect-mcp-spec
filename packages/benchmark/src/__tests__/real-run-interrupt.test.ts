import { appendFileSync, readFileSync } from "node:fs";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { loadArms } from "../real-run/plan-file.js";
import { runBench } from "../real-run/run-bench.js";
import { cannedInvoke } from "../real-run/canned-ports.js";
import { harness, tempDirectory } from "./real-run-cli-harness.js";

const cwd = fileURLToPath(new URL("../../", import.meta.url));

it.each(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "exit"] as const)("journals the interrupted invocation and kills its group on %s", async signal => {
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
    '  /bin/mkdir locked && echo x > locked/file && /bin/chmod 000 locked',
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

it("journals the entire interrupted parallel batch when one workspace cannot be removed", async () => {
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
    const host = harness({ PATH: out, OUT: out, START: String(start) });
    run = host.run("--i-accept-model-cost", "--plan", file, "--out", out);
    interrupt = () => host.events.emit("SIGTERM");
    await expect.poll(async () => (await readFile(join(out, "ready"), "utf8").catch(() => "")).trim().split("\n").length,
      { timeout: 4000 }).toBe(batch.length);
    interrupt();
    const rows = readFileSync(join(dir, "rows.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const interrupted = rows.filter(row => row.error === "Interrupted by SIGTERM");
    expect(interrupted.map(row => row.invocation_id).sort()).toEqual(batch.map(row => row.invocation_id).sort());
    expect(interrupted.filter(row => row.workspace_kept)).toHaveLength(1);
    expect(interrupted.find(row => row.workspace_kept).workspace_removal_error).toMatch(/EACCES|EPERM|ENOTEMPTY/);
  } finally {
    interrupt?.();
    await run;
    const kept = await readFile(join(out, "kept"), "utf8").catch(() => "");
    if (kept) await chmod(join(kept.trim(), "locked"), 0o700);
    await rm(out, { recursive: true, force: true });
  }
});

it("drains a failed parallel batch before removing any process handler", async () => {
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
    const { batch, start } = await parallelStandIn(file, out, [
      'echo $$ >> "$OUT/ready"',
      'if /bin/mkdir "$OUT/claimed" 2>/dev/null; then',
      '  while [ ! -f "$OUT/release" ]; do /bin/sleep 0.05; done',
      '  exec /bin/cat "$OUT/reply-$START"', 'fi', 'exec /bin/sleep 30',
    ]);
    let writes = 0;
    const host = harness({ PATH: out, OUT: out, START: String(start) }, {
      append(path, data, options) {
        if (writes++ === start) throw new Error("journal unavailable");
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
    for (const pid of pids) {
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await run;
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
