import { join } from "node:path";
import { all, create, type BigNumber } from "mathjs";
import { parseArgs } from "node:util";
import type { appendFileSync, lstatSync, rmSync } from "node:fs";
import type { mkdir, writeFile } from "node:fs/promises";
import { runBench } from "./run-bench.js";
import type { loadArms } from "./plan-file.js";
import { cannedInvoke } from "./canned-ports.js";
import type { makeClaudeInvoker } from "./claude-cli-invoker.js";
import { effectiveDollars } from "./cli-budget.js";
import { expectedModels, summaryHeader, summaryRow, unmeteredPolicy } from "./report.js";
import type { Row, RunPlan, Totals } from "./types.js";

export interface CliIO {
  loadArms: typeof loadArms;
  mkdir: typeof mkdir;
  writeFile: typeof writeFile;
  append: typeof appendFileSync;
  stat: typeof lstatSync;
  rm: typeof rmSync;
  invoker: typeof makeClaudeInvoker;
  stdout(message: string): void;
  stderr(message: string): void;
  clock(): number;
  once(event: NodeJS.Signals | "exit", handler: () => void): void;
  off(event: NodeJS.Signals | "exit", handler: () => void): void;
  exit(code: number): void;
  exitCode(code: number): void;
}
type Arm = Awaited<ReturnType<typeof loadArms>>[number];

function options(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: {
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

async function printEstimate(name: string, plan: RunPlan, io: CliIO) {
  const record = await runBench(plan, { invoke: cannedInvoke, clock: io.clock, record: () => {} });
  io.stdout(`${name}: ${record.totals.invocations} expected invocations (canned)`);
  io.stdout(`  Expected by model: ${expectedModels(record)}`);
}

function writeJson(io: CliIO, path: string, value: unknown) {
  return io.writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

class Interrupted extends Error {}

function trackCalls(io: CliIO) {
  const active = new Map<Row, { kill(): void; cleanup(): void; journal: string }>();
  let interruption = "CLI exit";
  let exited = false;
  const handlers = new Map<NodeJS.Signals | "exit", () => void>();
  function once(event: NodeJS.Signals | "exit", handler: () => void) {
    handlers.set(event, handler);
    io.once(event, handler);
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    once(signal, () => {
      interruption = signal;
      io.exit(1);
    });
  }
  function killActive() {
    for (const call of active.values()) call.kill();
  }
  once("exit", () => {
    if (!active.size) return;
    exited = true;
    io.exitCode(1);
    killActive();
    for (const [row, { journal }] of active) {
      row.error = `Interrupted by ${interruption}`;
      appendRow(journal, row);
    }
  });

  function appendRow(journal: string, row: Row) {
    active.get(row)?.cleanup();
    active.delete(row);
    io.append(journal, JSON.stringify(row) + "\n", { flush: true });
  }

  return {
    active, killActive,
    record(journal: string, row: Row) {
      // A host may finish pending promises after its exit callback returns.
      // The callback already flushed all active rows synchronously.
      if (exited) throw new Interrupted();
      appendRow(journal, row);
    },
    dispose() {
      for (const [event, handler] of handlers) io.off(event, handler);
    },
  };
}

interface Context {
  io: CliIO;
  tracker: ReturnType<typeof trackCalls>;
  env: NodeJS.ProcessEnv;
}

async function runArm(dir: string, plan: RunPlan, configured_limits: RunPlan["limits"], dry: boolean, armOrder: string[], ctx: Context) {
  await ctx.io.mkdir(dir);
  const journal = join(dir, "rows.jsonl");
  await ctx.io.writeFile(journal, "", { flag: "wx" });
  const record = await runBench(plan, {
    clock: ctx.io.clock,
    invoke: dry ? cannedInvoke : ctx.io.invoker(plan.call_timeout_ms, dir, "claude", (row, kill, cleanup) => {
      ctx.tracker.active.set(row, { kill, cleanup, journal });
    }, ctx.env, ctx.io.rm),
    abortBatch: ctx.tracker.killActive,
    record: row => ctx.tracker.record(journal, row),
  });
  await writeJson(ctx.io, join(dir, "record.json"), { dry_run: dry, arm_order_so_far: armOrder, plan, configured_limits, effective_limits: plan.limits, ...record });
  await writeJson(ctx.io, join(dir, "sections.json"), record.sections);
  return record;
}

async function announce(out: string, arms: Arm[], io: CliIO) {
  await io.mkdir(out, { recursive: true });
  const existing = ["summary.md", ...arms.map(arm => arm.name)]
    .filter(name => io.stat(join(out, name), { throwIfNoEntry: false }));
  if (existing.length) throw new Error(`Output already exists in ${out}: ${existing.join(", ")}`);
  const planCap = arms[0].plan.plan_max_cost_usd;
  const combined = arms.reduce((sum, arm) => sum + arm.plan.limits.max_cost_usd, 0);
  const caps = arms.map(arm => arm.plan.limits.max_cost_usd);
  const calculation = caps.every(cap => cap === caps[0]) ? `${caps.length} × ${caps[0]}` : caps.join(" + ");
  io.stdout(`Reported-spend limits: ${calculation} = ${combined} USD across arms. Plan cap ${planCap} USD. Worst case for reported spend: plan cap plus at most one in-flight batch or call.`);
  io.stdout(unmeteredPolicy);
  for (const arm of arms) await printEstimate(arm.name, arm.plan, io);
}

function skipReason(configured: BigNumber, available: BigNumber) {
  if (configured.isZero()) return "the configured arm limit is zero";
  if (available.lte(0)) return "the plan cap is exhausted";
  const limitingBudget = available === configured ? "configured arm limit" : "remaining plan budget";
  return `the ${limitingBudget} is below 0.000001 USD`;
}

function decimalBudget() {
  // Subtract decimal reports exactly even when a small charge follows a large cap.
  // One digit for every decimal position from Number.MAX_VALUE to Number.MIN_VALUE.
  const precision = Math.floor(Math.log10(Number.MAX_VALUE)) - Math.floor(Math.log10(Number.MIN_VALUE)) + 1;
  return create(all, { precision }).bignumber;
}

async function execute(out: string, dry: boolean, arms: Arm[], ctx: Context) {
  const planCap = arms[0].plan.plan_max_cost_usd;
  const summary = summaryHeader(dry);
  const armOrder: string[] = [];
  const skipped: string[] = [];
  const kept: string[] = [];
  const bignumber = decimalBudget();
  let remaining = bignumber(String(planCap));
  let status = 0;
  let baseline: Totals | undefined;
  for (const arm of arms) {
    const configured = bignumber(String(arm.plan.limits.max_cost_usd));
    const available = remaining.lt(configured) ? remaining : configured;
    const max_cost_usd = effectiveDollars(available);
    if (max_cost_usd <= 0) {
      const message = `${arm.name}: skipped because ${skipReason(configured, available)} (effective limit 0 USD).`;
      skipped.push(message);
      ctx.io.stderr(message);
      status = 1;
      continue;
    }
    const effectivePlan = { ...arm.plan, limits: { ...arm.plan.limits, max_cost_usd } };
    armOrder.push(arm.name);
    const record = await runArm(join(out, arm.name), effectivePlan, arm.plan.limits, dry, armOrder, ctx);
    for (const row of record.rows) {
      if (row.usage?.cost_usd != null) remaining = remaining.minus(String(row.usage.cost_usd));
      if (row.workspace_kept && row.workspace_path) kept.push(row.workspace_path);
    }
    baseline ??= record.totals;
    summary.push(summaryRow(arm.name, record, baseline));
    if (record.totals.errors || record.terminal.kind !== "done") status = 1;
    if (remaining.isNegative()) {
      const reportedSpend = bignumber(String(planCap)).minus(remaining);
      const message = `Plan stopped at ${reportedSpend} reported USD (plan_max_cost_usd ${planCap}).`;
      summary.push("", message);
      ctx.io.stderr(message);
      status = 1;
    }
  }
  if (kept.length) summary.push("", "Kept workspaces", "", ...kept.map(path => `- ${path}`));
  if (skipped.length) summary.push("", ...skipped);
  summary.push("", `Arm execution order: ${armOrder.join(" → ")}`);
  await ctx.io.writeFile(join(out, "summary.md"), summary.join("\n") + "\n", { flag: "wx" });
  return status;
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIO): Promise<number> {
  const tracker = trackCalls(io);
  try {
    const { dry, plan, out } = options(argv);
    const arms = await io.loadArms(plan);
    await announce(out, arms, io);
    return await execute(out, dry, arms, { tracker, env, io });
  } catch (error) {
    if (!(error instanceof Interrupted)) io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    tracker.dispose();
  }
}
