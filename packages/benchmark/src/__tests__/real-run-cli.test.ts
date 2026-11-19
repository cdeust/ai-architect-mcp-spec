import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SpawnSubagentsActionSchema } from "@prd-gen/orchestration";
import { loadArms } from "../real-run/plan-file.js";
import { runBench } from "../real-run/run-bench.js";
import { cannedInvoke } from "../real-run/canned-ports.js";
import { expect, it } from "vitest";

const cwd = fileURLToPath(new URL("../../", import.meta.url));
function cli(...args: string[]) {
  return spawnSync(process.execPath, ["dist/src/real-run/cli.js", ...args], {
    cwd, encoding: "utf8", env: { PATH: "" },
  });
}

it("requires explicit cost acceptance before opening a live plan", () => {
  const result = cli("--plan", "absent.json", "--out", ".");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Live runs require --i-accept-model-cost");
  expect(result.stdout).toBe("");
});

it("writes five dry-run records and the comparison without an installed model CLI", async () => {
  const out = await mkdtemp(join(tmpdir(), "real-run-test-"));
  try {
    const result = cli("--dry-run", "--plan", "real-run/plans/pilot.json", "--out", out);
    expect(result.status, result.stderr).toBe(0);
    const arms = ["standard-as-emitted", "tiny-as-emitted", "standard-tiered", "tiny-tiered", "standard-tiered-parallel"];
    expect((await readdir(out)).sort()).toEqual([...arms, "summary.md"].sort());
    const summary = await readFile(join(out, "summary.md"), "utf8");
    expect(result.stdout).toMatch(/standard-as-emitted:[^\n]*\n  Expected by model: session=20, haiku=6, sonnet=1/);
    expect(result.stdout).toMatch(/standard-tiered:[^\n]*\n  Expected by model: session=0, haiku=6, sonnet=21/);
    for (const output of [result.stdout, summary]) {
      expect(output).toContain("Unmetered calls count as zero toward arm dollar limits and the plan cap");
      expect(output).toContain("max_unmetered_calls");
    }
    expect(summary).toContain("Reported models");
    expect(summary).toContain("Later arms can read the prompt cache earlier arms wrote.");
    expect(summary).toContain(`Arm execution order: ${arms.join(" → ")}`);
    expect(summary).toContain("| canned |");
    for (const arm of arms) {
      const count = arm.startsWith("tiny") ? 12 : 27;
      expect(result.stdout).toContain(`${arm}: ${count} expected invocations (canned)`);
      const record = JSON.parse(await readFile(join(out, arm, "record.json"), "utf8"));
      expect(record).toMatchObject({ dry_run: true, totals: { invocations: count, cost_usd: 0, errors: 0 },
        quality: { hard_output_score: 0.85, outcome: { status: "needs_attention" } } });
      expect(record.measurement_scope).toContain("Host session cost is not measured");
      expect(summary).toContain(record.measurement_scope);
      expect(record.arm_order_so_far).toEqual(arms.slice(0, arms.indexOf(arm) + 1));
      expect(record.rows[0]).toMatchObject({ isolation: "none", agent_type: expect.any(String) });
      const sections = JSON.parse(await readFile(join(out, arm, "sections.json"), "utf8"));
      expect(sections).toEqual(record.sections);
      expect(sections).toContainEqual({
        section_type: "overview",
        status: expect.any(String),
        attempt: expect.any(Number),
        violation_count: expect.any(Number),
        content: expect.stringMatching(/\S/),
      });
      const journal = await readFile(join(out, arm, "rows.jsonl"), "utf8");
      expect(journal.trimEnd().split("\n").map(line => JSON.parse(line))).toEqual(expect.arrayContaining(record.rows));
      expect(journal.trimEnd().split("\n")).toHaveLength(count);
      const draft = record.rows.find((r: { purpose: string }) => r.purpose === "draft");
      expect(draft.used.model).toBe(arm.includes("tiered") ? "sonnet" : "session");
      expect(summary).toContain(`| ${arm} | 0 | 0 |`);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it("loads a bounded smoke arm with Haiku at low effort for every reducer purpose", async () => {
  const arms = await loadArms(join(cwd, "real-run/plans/smoke.json"));
  expect(arms).toHaveLength(1);
  const { plan } = arms[0];
  expect(plan).toMatchObject({
    prd_context: "feature",
    request_size: "tiny",
    mode: "sequential",
    limits: { max_invocations: 30, max_cost_usd: 1, max_steps: 120 },
    call_timeout_ms: 180000,
  });
  for (const purpose of SpawnSubagentsActionSchema.shape.purpose.options) {
    expect(plan.policy).toHaveProperty(purpose, { model: "haiku", effort: "low" });
  }
  const dry = await runBench(plan, { invoke: cannedInvoke, record: () => {}, clock: Date.now });
  expect(dry.terminal.kind).toBe("done");
  expect(dry.rows).toHaveLength(12);
});

it("requires plan limits, merges per-arm overrides, and journals a stopped CLI run", async () => {
  const out = await mkdtemp(join(tmpdir(), "bench-limits-"));
  try {
    const file = join(out, "plan.json");
    const pilot = JSON.parse(await readFile(join(cwd, "real-run/plans/pilot.json"), "utf8"));
    expect(pilot.limits).toEqual({ max_invocations: 60, max_cost_usd: 6, max_unmetered_calls: 2, max_steps: 200 });
    expect(pilot.call_timeout_ms).toBe(600000);
    pilot.arms = [{ ...pilot.arms[0], limits: { max_invocations: 1 } }];
    await writeFile(file, JSON.stringify({ ...pilot, limits: undefined }));
    await expect(loadArms(file)).rejects.toThrow(/limits/);
    await writeFile(file, JSON.stringify(pilot));
    const result = cli("--dry-run", "--plan", file, "--out", out);
    expect(result.status).toBe(1);
    const dir = join(out, pilot.arms[0].name);
    const record = JSON.parse(await readFile(join(dir, "record.json"), "utf8"));
    expect(record.plan.limits).toEqual({ ...pilot.limits, max_invocations: 1 });
    expect(record.terminal).toEqual({ kind: "stopped", reason: "max_invocations" });
    expect(record.rows).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, "rows.jsonl"), "utf8"))).toEqual(record.rows[0]);
    expect(JSON.parse(await readFile(join(dir, "sections.json"), "utf8"))).toEqual(record.sections);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it("journals a metered stand-in response through the compiled CLI before the cost stop", async () => {
  const out = await mkdtemp(join(tmpdir(), "bench-stand-in-"));
  try {
    const plan = JSON.parse(await readFile(join(cwd, "real-run/plans/smoke.json"), "utf8"));
    plan.limits.max_cost_usd = 0.0001;
    const file = join(out, "plan.json");
    await writeFile(file, JSON.stringify(plan));
    const fixture = join(cwd, "src/__tests__/fixtures/claude-cli-result.json");
    const executable = join(out, "claude");
    await writeFile(executable, '#!/bin/sh\n/bin/cat >/dev/null\nexec /bin/cat "$FIXTURE"\n', { mode: 0o700 });
    const result = spawnSync(process.execPath, [
      "dist/src/real-run/cli.js", "--plan", file, "--out", out, "--i-accept-model-cost",
    ], { cwd, encoding: "utf8", env: { PATH: out, FIXTURE: fixture } });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("session=0, haiku=12");
    const dir = join(out, "smoke");
    const row = JSON.parse(await readFile(join(dir, "rows.jsonl"), "utf8"));
    expect(row).toMatchObject({ purpose: "probe", used: { model: "haiku", effort: "low" },
      usage: { model_reported: "claude-haiku-5-5", input_tokens: 2, output_tokens: 4 } });
    const record = JSON.parse(await readFile(join(dir, "record.json"), "utf8"));
    expect(record.terminal).toEqual({ kind: "stopped", reason: "max_cost_usd" });
    expect(record.rows).toEqual([row]);
    expect((await readdir(dir)).filter(name => name.startsWith("call-"))).toEqual([]);
    const summary = await readFile(join(out, "summary.md"), "utf8");
    expect(summary).toContain("| 3777 | 1.00× |");
    expect(summary).toContain("| claude-haiku-5-5 |");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it.each(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "exit"] as const)("journals the interrupted invocation and kills its group on %s", async signal => {
  const out = await mkdtemp(join(tmpdir(), "bench-signal-"));
  const marker = join(out, "pids");
  const standIn = join(out, "claude");
  let pids: number[] = [];
  await writeFile(standIn, '#!/bin/sh\n/bin/sleep 20 &\necho "$$ $!" > "$MARKER"\nwait\n', { mode: 0o700 });
  const preload = join(out, "exit.cjs");
  await writeFile(preload, 'setInterval(() => { if (require("node:fs").existsSync(process.env.EXIT_FILE)) process.exit(0); }, 10).unref();');
  const flags = signal === "exit" ? ["--require", preload] : [];
  const cliProcess = spawn(process.execPath, [...flags, "dist/src/real-run/cli.js", "--i-accept-model-cost",
    "--plan", "real-run/plans/smoke.json", "--out", out], { cwd, env: { PATH: out, MARKER: marker, EXIT_FILE: join(out, "exit-now") } });
  const exited = new Promise(resolve => cliProcess.once("exit", (code, signal) => resolve(code ?? signal)));
  try {
    await expect.poll(async () => {
      const content = await readFile(marker, "utf8").catch(() => "");
      pids = content.trim().split(" ").map(Number);
      return pids.length;
    }, { timeout: 3000 }).toBe(2);
    if (signal === "exit") await writeFile(join(out, "exit-now"), "");
    else cliProcess.kill(signal);
    expect(await exited).toEqual(expect.any(Number));
    expect(cliProcess.exitCode).not.toBe(0);
    const row = JSON.parse(await readFile(join(out, "smoke/rows.jsonl"), "utf8"));
    expect(row).toMatchObject({ purpose: "probe", usage: null, error: `Interrupted by ${signal === "exit" ? "CLI exit" : signal}` });
    expect(await readdir(join(out, "smoke"))).toEqual(["rows.jsonl"]);
    for (const pid of pids) await expect.poll(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }).toBe(true);
  } finally {
    cliProcess.kill("SIGKILL");
    for (const pid of pids.filter(pid => pid > 0)) {
      try { process.kill(pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await rm(out, { recursive: true, force: true });
  }
});

it.each([["tiny-as-emitted"], ["summary.md"], ["tiny-as-emitted", "summary.md"]])(
  "refuses existing outputs before the first arm (%s)", async (...names) => {
    const out = await mkdtemp(join(tmpdir(), "bench-conflict-"));
    try {
      for (const name of names) {
        if (name === "summary.md") await writeFile(join(out, name), "original");
        else await mkdir(join(out, name));
      }
      const result = cli("--dry-run", "--plan", "real-run/plans/pilot.json", "--out", out);
      expect(result.status).toBe(1);
      for (const name of names) expect(result.stderr).toContain(name);
      expect(await readdir(out)).toEqual([...names].sort());
      expect(result.stdout).toBe("");
      if (names.includes("summary.md")) expect(await readFile(join(out, "summary.md"), "utf8")).toBe("original");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  },
);

it("journals mixed-model billing and bounded stderr from an unsuccessful CLI", async () => {
  const out = await mkdtemp(join(tmpdir(), "bench-cli-error-"));
  try {
    const fixture = JSON.parse(await readFile(join(cwd, "src/__tests__/fixtures/claude-cli-result.json"), "utf8"));
    fixture.is_error = true;
    fixture.subtype = "error_during_execution";
    fixture.errors = ["provider message"];
    delete fixture.result;
    fixture.modelUsage.other = { inputTokens: 3, costUSD: 0.25 };
    await writeFile(join(out, "response"), JSON.stringify(fixture));
    await writeFile(join(out, "diagnostic"), "retry detail " + "x".repeat(12000) + "end-marker");
    await writeFile(join(out, "claude"), '#!/bin/sh\n/bin/cat "$DATA/diagnostic" >&2\n/bin/cat "$DATA/response"\nexit 1\n', { mode: 0o700 });
    const result = spawnSync(process.execPath, ["dist/src/real-run/cli.js", "--i-accept-model-cost",
      "--plan", "real-run/plans/smoke.json", "--out", out], { cwd, env: { PATH: out, DATA: out } });
    expect(result.status).toBe(1);
    const row = JSON.parse(await readFile(join(out, "smoke/rows.jsonl"), "utf8"));
    expect((await readdir(join(out, "smoke"))).filter(name => name.startsWith("call-"))).toEqual([]);
    for (const message of ["error_during_execution", "provider message", "retry detail"]) expect(row.error).toContain(message);
    expect(row.error).not.toContain("end-marker");
    expect(row.usage.per_model.other).toEqual(fixture.modelUsage.other);
    expect(row.usage.cost_usd).toBe(fixture.total_cost_usd);
    const summary = await readFile(join(out, "summary.md"), "utf8");
    expect(summary).toContain(`${row.batch_id}/${row.invocation_id}`);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it("checks the summed reported spend between arms in execution order and uses fresh call directories", async () => {
  const out = await mkdtemp(join(tmpdir(), "bench-plan-cap-"));
  try {
    const plan = JSON.parse(await readFile(join(cwd, "real-run/plans/smoke.json"), "utf8"));
    plan.arms = ["a", "b", "c"].map(name => ({ ...plan.arms[0], name }));
    plan.order = "reversed";
    plan.plan_max_cost_usd = 0.5;
    const file = join(out, "plan.json");
    await writeFile(file, JSON.stringify(plan));
    const fixture = JSON.parse(await readFile(join(cwd, "src/__tests__/fixtures/claude-cli-result.json"), "utf8"));
    fixture.is_error = true;
    fixture.total_cost_usd = 0.5;
    await writeFile(join(out, "response"), JSON.stringify(fixture));
    const script = ['#!/bin/sh', 'pwd >> "$DATA/cwds"', '/bin/ls -A >> "$DATA/contents"', '/bin/cat "$DATA/response"'].join("\n");
    await writeFile(join(out, "claude"), script, { mode: 0o700 });
    const result = spawnSync(process.execPath, ["dist/src/real-run/cli.js", "--i-accept-model-cost",
      "--plan", file, "--out", out], { cwd, encoding: "utf8", env: { PATH: out, DATA: out } });
    expect(result.status).toBe(1);
    expect(result.stdout.split("\n")[0]).toContain("3 × 1 = 3 USD across arms. Plan cap 0.5 USD");
    const dirs = (await readFile(join(out, "cwds"), "utf8")).trim().split("\n");
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/\/c\/call-[^/]+$/);
    expect(await readdir(out)).not.toContain("b");
    expect(await readFile(join(out, "contents"), "utf8")).toBe("");
    expect(await readdir(out)).not.toContain("a");
    const summary = await readFile(join(out, "summary.md"), "utf8");
    for (const name of ["b", "a"]) expect(summary).toContain(`${name}: skipped because the plan cap is exhausted`);
    expect(summary).toContain("Arm execution order: c");
    for (const missing of ["max_unmetered_calls", "plan_max_cost_usd"]) {
      const invalid = structuredClone(plan);
      delete (missing === "max_unmetered_calls" ? invalid.limits : invalid)[missing];
      await writeFile(file, JSON.stringify(invalid));
      await expect(loadArms(file)).rejects.toThrow(missing);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it.each([[0.9, 0.2], [0.90000005, 0.199999]])("floors the remaining plan budget after two $%s calls", async (cost, remainder) => {
  const out = await mkdtemp(join(tmpdir(), "bench-remainder-"));
  try {
    const plan = JSON.parse(await readFile(join(cwd, "real-run/plans/smoke.json"), "utf8"));
    plan.arms = ["first", "second"].map(name => ({ ...plan.arms[0], name }));
    const file = join(out, "plan.json");
    await writeFile(file, JSON.stringify(plan));
    const fixture = JSON.parse(await readFile(join(cwd, "src/__tests__/fixtures/claude-cli-result.json"), "utf8"));
    await writeFile(join(out, "response"), JSON.stringify({ ...fixture, total_cost_usd: cost }));
    await writeFile(join(out, "claude"), '#!/bin/sh\n/bin/cat >/dev/null\n/bin/cat "$DATA/response"\n', { mode: 0o700 });
    const result = spawnSync(process.execPath, ["dist/src/real-run/cli.js", "--i-accept-model-cost",
      "--plan", file, "--out", out], { cwd, encoding: "utf8", env: { PATH: out, DATA: out } });
    expect(result.status).toBe(1);
    const [first, second] = await Promise.all(plan.arms.map(async ({ name }: { name: string }) =>
      JSON.parse(await readFile(join(out, name, "record.json"), "utf8"))));
    expect(first.totals.cost_usd).toBe(2 * cost);
    expect(first.configured_limits).toEqual(plan.limits);
    expect(first.effective_limits).toEqual(plan.limits);
    expect(second.configured_limits).toEqual(plan.limits);
    expect(second.effective_limits).toEqual({ ...plan.limits, max_cost_usd: remainder });
    expect(second.plan.limits).toEqual(second.effective_limits);
    expect(second.rows).toHaveLength(1);
    expect(first.totals.cost_usd + second.totals.cost_usd).toBeLessThanOrEqual(2 + cost);
    expect(result.stdout.split("\n")[0]).toContain("plus at most one in-flight batch or call");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it("journals a timeout and removes its call directory", async () => {
  const out = await mkdtemp(join(tmpdir(), "bench-cli-timeout-"));
  try {
    const plan = JSON.parse(await readFile(join(cwd, "real-run/plans/smoke.json"), "utf8"));
    const file = join(out, "plan.json");
    await writeFile(file, JSON.stringify({ ...plan, call_timeout_ms: 200 }));
    await writeFile(join(out, "claude"), "#!/bin/sh\nexec /bin/sleep 10\n", { mode: 0o700 });
    const result = spawnSync(process.execPath, ["dist/src/real-run/cli.js", "--i-accept-model-cost",
      "--plan", file, "--out", out], { cwd, env: { PATH: out } });
    expect(result.status).toBe(1);
    const dir = join(out, "smoke");
    expect(JSON.parse(await readFile(join(dir, "rows.jsonl"), "utf8")).error).toBe("Claude CLI timed out after 200 ms");
    expect((await readdir(dir)).filter(name => name.startsWith("call-"))).toEqual([]);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
it("journals a failed workspace removal and runs the next arm", async () => {
  const out = await mkdtemp(join(tmpdir(), "bench-kept-"));
  const marker = join(out, "locked");
  try {
    const plan = JSON.parse(await readFile(join(cwd, "real-run/plans/smoke.json"), "utf8"));
    plan.arms = ["first", "second"].map(name => ({ ...plan.arms[0], name, limits: { max_invocations: 1 } }));
    const file = join(out, "plan.json");
    await writeFile(file, JSON.stringify(plan));
    await writeFile(join(out, "claude"), [
      "#!/bin/sh", '/bin/cat >/dev/null', 'if [ ! -f "$MARKER" ]; then',
      '  /bin/mkdir locked && echo x > locked/file && /bin/chmod 000 locked',
      '  pwd > "$MARKER"', 'fi', 'exec /bin/cat "$FIXTURE"',
    ].join("\n"), { mode: 0o700 });
    const fixture = join(cwd, "src/__tests__/fixtures/claude-cli-result.json");
    const result = spawnSync(process.execPath, ["dist/src/real-run/cli.js", "--i-accept-model-cost",
      "--plan", file, "--out", out], { cwd, encoding: "utf8", env: { PATH: out, MARKER: marker, FIXTURE: fixture } });
    const kept = (await readFile(marker, "utf8")).trim();
    for (const name of ["first", "second"]) {
      const dir = join(out, name);
      const row = JSON.parse(await readFile(join(dir, "rows.jsonl"), "utf8"));
      expect(row).toMatchObject({ error: null, workspace_kept: name === "first" });
      if (name === "first") expect(row.workspace_removal_error).toMatch(/EACCES|EPERM|ENOTEMPTY/);
      const record = JSON.parse(await readFile(join(dir, "record.json"), "utf8"));
      expect(record.rows).toEqual([row]);
      expect(JSON.parse(await readFile(join(dir, "sections.json"), "utf8"))).toEqual(record.sections);
    }
    expect(result.status).toBe(1); // Both arms stop at one invocation.
    expect(await readFile(join(out, "summary.md"), "utf8")).toContain(kept);
  } finally {
    const kept = await readFile(marker, "utf8").catch(() => "");
    if (kept) await chmod(join(kept.trim(), "locked"), 0o700);
    await rm(out, { recursive: true, force: true });
  }
});
it("reports a configured zero arm limit while the plan still has budget", async () => {
  const out = await mkdtemp(join(tmpdir(), "bench-zero-arm-"));
  try {
    const plan = JSON.parse(await readFile(join(cwd, "real-run/plans/smoke.json"), "utf8"));
    plan.arms[0].limits = { max_cost_usd: 0 };
    await writeFile(join(out, "plan.json"), JSON.stringify(plan));
    const result = cli("--dry-run", "--plan", join(out, "plan.json"), "--out", out);
    const reason = "smoke: skipped because the configured arm limit is zero";
    expect(result.stderr).toContain(reason);
    expect(await readFile(join(out, "summary.md"), "utf8")).toContain(reason);
    expect(await readdir(out)).not.toContain("smoke");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
it("journals the entire interrupted parallel batch when one workspace cannot be removed", async () => {
  const out = await mkdtemp(join(tmpdir(), "bench-parallel-exit-"));
  const dir = join(out, "parallel");
  let cliProcess: ReturnType<typeof spawn> | undefined;
  try {
    const file = join(out, "plan.json");
    const pilot = JSON.parse(await readFile(join(cwd, "real-run/plans/pilot.json"), "utf8"));
    pilot.arms = [{ ...pilot.arms[0], name: "parallel", mode: "parallel" }];
    await writeFile(file, JSON.stringify(pilot));
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
      'if /bin/mkdir "$OUT/claimed" 2>/dev/null; then',
      '  /bin/mkdir locked && echo x > locked/file && /bin/chmod 000 locked',
      '  pwd > "$OUT/kept"', 'fi', 'pwd >> "$OUT/ready"', 'exec /bin/sleep 10',
    ].join("\n"), { mode: 0o700 });
    cliProcess = spawn(process.execPath, ["dist/src/real-run/cli.js", "--i-accept-model-cost",
      "--plan", file, "--out", out], { cwd, env: { PATH: out, OUT: out, START: String(start) } });
    const exited = new Promise(resolve => cliProcess!.once("exit", resolve));
    await expect.poll(async () => (await readFile(join(out, "ready"), "utf8").catch(() => "")).trim().split("\n").length,
      { timeout: 4000 }).toBe(batch.length);
    cliProcess.kill("SIGTERM");
    expect(await exited).toBe(1);
    const rows = (await readFile(join(dir, "rows.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const interrupted = rows.filter(row => row.error === "Interrupted by SIGTERM");
    expect(interrupted.map(row => row.invocation_id).sort()).toEqual(batch.map(row => row.invocation_id).sort());
    expect(interrupted.filter(row => row.workspace_kept)).toHaveLength(1);
    expect(interrupted.find(row => row.workspace_kept).workspace_removal_error).toMatch(/EACCES|EPERM|ENOTEMPTY/);
  } finally {
    cliProcess?.kill("SIGTERM");
    const kept = await readFile(join(out, "kept"), "utf8").catch(() => "");
    if (kept) await chmod(join(kept.trim(), "locked"), 0o700);
    await rm(out, { recursive: true, force: true });
  }
});
it("keeps the numeric limit below the decimal remainder when adjacent numbers are dollars apart", async () => {
  const out = await mkdtemp(join(tmpdir(), "bench-large-cap-"));
  try {
    const plan = JSON.parse(await readFile(join(cwd, "real-run/plans/smoke.json"), "utf8"));
    plan.plan_max_cost_usd = 1e16;
    plan.limits = { ...plan.limits, max_cost_usd: 1e16, max_invocations: 1 };
    plan.arms = ["first", "second"].map(name => ({ ...plan.arms[0], name }));
    await writeFile(join(out, "plan.json"), JSON.stringify(plan));
    const fixture = join(cwd, "src/__tests__/fixtures/claude-cli-result.json");
    await writeFile(join(out, "claude"), '#!/bin/sh\n/bin/cat >/dev/null\nexec /bin/cat "$FIXTURE"\n', { mode: 0o700 });
    const result = spawnSync(process.execPath, ["dist/src/real-run/cli.js", "--i-accept-model-cost",
      "--plan", join(out, "plan.json"), "--out", out], { cwd, env: { PATH: out, FIXTURE: fixture } });
    expect(result.status).toBe(1);
    const second = JSON.parse(await readFile(join(out, "second/record.json"), "utf8"));
    expect(second.effective_limits.max_cost_usd).toBe(9999999999999998);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
