import { appendFileSync, lstatSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runBench } from "./run-bench.js";
import { loadArms } from "./plan-file.js";
import { cannedAnswer, cannedInvoke } from "./canned-ports.js";
import { makeClaudeInvoker } from "./claude-cli-invoker.js";
import { expectedModels, summaryHeader, summaryRow } from "./report.js";
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
  answer: cannedAnswer,
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

const active = new Map<Row, { kill(): void; journal: string }>();
let interruption = "CLI exit";
for (const signal of ["SIGINT", "SIGTERM"] as const) {
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
    appendRow(journal, { ...row, error: `Interrupted by ${interruption}` });
  }
});

function appendRow(journal: string, row: Row) {
  appendFileSync(journal, JSON.stringify(row) + "\n", { flush: true });
}

async function runArm(dir: string, plan: RunPlan, dry: boolean) {
  await mkdir(dir);
  const journal = join(dir, "rows.jsonl");
  await writeFile(journal, "", { flag: "wx" });
  const record = await runBench(plan, {
    ...cannedPorts,
    invoke: dry ? cannedInvoke : makeClaudeInvoker(plan.call_timeout_ms, "claude", (row, kill) => {
      active.set(row, { kill, journal });
      return () => active.delete(row);
    }),
    record: row => appendRow(journal, row),
  });
  await writeJson(join(dir, "record.json"), { dry_run: dry, plan, ...record });
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
  for (const arm of arms) await printEstimate(arm.name, arm.plan);

  const summary = summaryHeader(dry);
  let baseline: Totals | undefined;
  for (const arm of arms) {
    const record = await runArm(join(out, arm.name), arm.plan, dry);
    baseline ??= record.totals;
    summary.push(summaryRow(arm.name, record, baseline));
    if (record.totals.errors || record.terminal.kind !== "done") process.exitCode = 1;
  }
  await writeFile(join(out, "summary.md"), summary.join("\n") + "\n", { flag: "wx" });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
