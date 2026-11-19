import { appendFileSync, lstatSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runBench } from "./run-bench.js";
import { loadArms } from "./plan-file.js";
import { cannedInvoke } from "./canned-ports.js";
import { makeClaudeInvoker } from "./claude-cli-invoker.js";
import { expectedModels, summaryHeader, summaryRow, unmeteredPolicy } from "./report.js";
import type { Ports, Row, RunPlan, Totals } from "./types.js";

function options() {
  const { values } = parseArgs({ options: {
    plan: { type: "string" },
    out: { type: "string" },
    "i-accept-model-cost": { type: "boolean" },
    "dry-run": { type: "boolean" },
  } });
  const dry = values["dry-run"] === true;
  if (!dry && !values["i-accept-model-cost"]) throw new Error("Live runs require --i-accept-model-cost");
  if (!values.plan || !values.out) throw new Error("Expected --plan <file.json> --out <dir>");
  return { dry, plan: values.plan, out: values.out };
}

const cannedPorts: Ports = {
  clock: () => performance.now(),
  invoke: cannedInvoke,
  record: () => {},
};

async function printEstimate(name: string, plan: RunPlan) {
  const record = await runBench(plan, cannedPorts);
  console.log(`${name}: ${record.totals.invocations} expected invocations (canned)`);
  console.log(`  Expected by model: ${expectedModels(record)}`);
}

function writeJson(path: string, value: unknown) {
  return writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

const active = new Map<Row, { kill(): void; cleanup(): void; journal: string }>();
let interruption = "CLI exit";
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
  process.once(signal, () => {
    interruption = signal;
    process.exit(1);
  });
}
process.once("exit", () => {
  if (!active.size) return;
  process.exitCode = 1;
  for (const call of active.values()) call.kill();
  for (const [row, { journal }] of active) {
    row.error = `Interrupted by ${interruption}`;
    appendRow(journal, row);
  }
});

function appendRow(journal: string, row: Row) {
  active.get(row)?.cleanup();
  appendFileSync(journal, JSON.stringify(row) + "\n", { flush: true });
  active.delete(row);
}

async function runArm(dir: string, plan: RunPlan, dry: boolean, armOrder: string[]) {
  await mkdir(dir);
  const journal = join(dir, "rows.jsonl");
  await writeFile(journal, "", { flag: "wx" });
  const record = await runBench(plan, {
    ...cannedPorts,
    invoke: dry ? cannedInvoke : makeClaudeInvoker(plan.call_timeout_ms, dir, "claude", (row, kill, cleanup) => {
      active.set(row, { kill, cleanup, journal });
    }),
    record: row => appendRow(journal, row),
  });
  await writeJson(join(dir, "record.json"), { dry_run: dry, arm_order_so_far: armOrder, plan, ...record });
  await writeJson(join(dir, "sections.json"), record.sections);
  return record;
}

async function main() {
  const { dry, plan, out } = options();
  const arms = await loadArms(plan);
  await mkdir(out, { recursive: true });
  const existing = ["summary.md", ...arms.map(arm => arm.name)]
    .filter(name => lstatSync(join(out, name), { throwIfNoEntry: false }));
  if (existing.length) throw new Error(`Output already exists in ${out}: ${existing.join(", ")}`);
  const planCap = arms[0].plan.plan_max_cost_usd;
  const combined = arms.reduce((sum, arm) => sum + arm.plan.limits.max_cost_usd, 0);
  const caps = arms.map(arm => arm.plan.limits.max_cost_usd);
  const calculation = caps.every(cap => cap === caps[0]) ? `${caps.length} × ${caps[0]}` : caps.join(" + ");
  console.log(`Reported-spend limits: ${calculation} = ${combined} USD across arms. Plan cap ${planCap} USD. Worst case for reported spend: plan cap plus at most one in-flight batch or call.`);
  console.log(unmeteredPolicy);
  for (const arm of arms) await printEstimate(arm.name, arm.plan);

  const summary = summaryHeader(dry);
  const armOrder: string[] = [];
  const skipped: string[] = [];
  const kept: string[] = [];
  let reportedSpend = 0;
  let baseline: Totals | undefined;
  for (const arm of arms) {
    const max_cost_usd = Math.min(arm.plan.limits.max_cost_usd, planCap - reportedSpend);
    if (max_cost_usd <= 0) {
      const message = `${arm.name}: skipped by the plan cap (effective limit ${Math.max(0, max_cost_usd)} USD).`;
      skipped.push(message);
      console.error(message);
      process.exitCode = 1;
      continue;
    }
    const effectivePlan = { ...arm.plan, limits: { ...arm.plan.limits, max_cost_usd } };
    armOrder.push(arm.name);
    const record = await runArm(join(out, arm.name), effectivePlan, dry, armOrder);
    for (const row of record.rows) {
      if (row.workspace_kept && row.workspace_path) kept.push(row.workspace_path);
    }
    reportedSpend += record.totals.cost_usd;
    baseline ??= record.totals;
    summary.push(summaryRow(arm.name, record, baseline));
    if (record.totals.errors || record.terminal.kind !== "done") process.exitCode = 1;
    if (reportedSpend > planCap) {
      const message = `Plan stopped at ${reportedSpend} reported USD (plan_max_cost_usd ${planCap}).`;
      summary.push("", message);
      console.error(message);
      process.exitCode = 1;
    }
  }
  if (kept.length) summary.push("", "Kept workspaces", "", ...kept.map(path => `- ${path}`));
  if (skipped.length) summary.push("", ...skipped);
  summary.push("", `Arm execution order: ${armOrder.join(" → ")}`);
  await writeFile(join(out, "summary.md"), summary.join("\n") + "\n", { flag: "wx" });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
