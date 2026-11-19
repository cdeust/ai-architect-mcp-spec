import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SpawnSubagentsActionSchema } from "@prd-gen/orchestration";
import { loadArms } from "../real-run/plan-file.js";
import { runBench } from "../real-run/run-bench.js";
import { cannedAnswer, cannedInvoke } from "../real-run/canned-ports.js";
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
    const arms = ["standard-as-emitted", "tiny-as-emitted", "standard-tiered", "tiny-tiered", "tiny-tiered-parallel"];
    expect((await readdir(out)).sort()).toEqual([...arms, "summary.md"].sort());
    const summary = await readFile(join(out, "summary.md"), "utf8");
    expect(result.stdout).toMatch(/standard-as-emitted:[^\n]*\n  Expected by model: session=20, haiku=6, sonnet=1/);
    expect(result.stdout).toMatch(/standard-tiered:[^\n]*\n  Expected by model: session=0, haiku=6, sonnet=21/);
    expect(summary).toContain("Reported models");
    expect(summary).toContain("| canned |");
    for (const arm of arms) {
      const count = arm.startsWith("tiny") ? 12 : 27;
      expect(result.stdout).toContain(`${arm}: ${count} expected invocations (canned)`);
      const record = JSON.parse(await readFile(join(out, arm, "record.json"), "utf8"));
      expect(record).toMatchObject({ dry_run: true, totals: { invocations: count, cost_usd: 0, errors: 0 },
        quality: { hard_output_score: 0.85, outcome: { status: "needs_attention" } } });
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
  const dry = await runBench(plan, { invoke: cannedInvoke, answer: cannedAnswer, record: () => {}, clock: Date.now });
  expect(dry.terminal.kind).toBe("done");
  expect(dry.rows).toHaveLength(12);
});

it("requires plan limits, merges per-arm overrides, and journals a stopped CLI run", async () => {
  const out = await mkdtemp(join(tmpdir(), "bench-limits-"));
  try {
    const file = join(out, "plan.json");
    const pilot = JSON.parse(await readFile(join(cwd, "real-run/plans/pilot.json"), "utf8"));
    expect(pilot.limits).toEqual({ max_invocations: 80, max_cost_usd: 25, max_steps: 200 });
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
    plan.limits.max_cost_usd = 0;
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
    const summary = await readFile(join(out, "summary.md"), "utf8");
    expect(summary).toContain("| 3777 | 1.00× |");
    expect(summary).toContain("| claude-haiku-5-5 |");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
