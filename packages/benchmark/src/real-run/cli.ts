import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runBench } from "./run-bench.js";
import { loadArms } from "./plan-file.js";
import { cannedAnswer, cannedInvoke } from "./canned-ports.js";
import { claudeInvoke } from "./claude-cli-invoker.js";
import type { RunRecord } from "./types.js";

function summaryRow(name: string, record: RunRecord) {
  const { totals, quality } = record;
  const distribution = Object.entries(quality.distribution ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  const cells = [name, totals.input_tokens, totals.output_tokens, totals.cache_read_tokens, totals.cache_creation_tokens,
    totals.cost_usd ?? "unknown", record.wall_time_ms.toFixed(1), totals.invocations, totals.errors, totals.unmetered_calls,
    quality.outcome?.status ?? record.terminal.kind, quality.hard_output_score ?? "—", distribution || "—"];
  return `| ${cells.join(" | ")} |`;
}

async function main() {
  const { values } = parseArgs({ options: { plan: { type: "string" }, out: { type: "string" },
    "i-accept-model-cost": { type: "boolean" }, "dry-run": { type: "boolean" } } });
  const dry = values["dry-run"] === true;
  if (!dry && !values["i-accept-model-cost"]) throw new Error("Live runs require --i-accept-model-cost");
  if (!values.plan || !values.out) throw new Error("Expected --plan <file.json> --out <dir>");
  const arms = await loadArms(values.plan);
  const ports = { clock: () => performance.now(), answer: cannedAnswer, invoke: cannedInvoke };
  const estimates = [];
  for (const arm of arms) {
    const record = await runBench(arm.plan, ports);
    console.log(`${arm.name}: ${record.totals.invocations} expected invocations (canned)`);
    estimates.push({ ...arm, record });
  }
  const summary = [dry ? "# Dry run (canned responses)" : "# Model run",
    "", "Token columns sum metered calls. A call without metering makes the total cost unknown.", "",
    "| Arm | Tokens in | Tokens out | Cache read | Cache creation | USD | Wall ms | Calls | Errors | Unmetered | Outcome | Hard-output score | Verification |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|"];
  for (const arm of estimates) {
    const dir = join(values.out, arm.name);
    await mkdir(dir, { recursive: true });
    const record = dry ? arm.record : await runBench(arm.plan, { ...ports, invoke: claudeInvoke });
    await writeFile(join(dir, "record.json"), JSON.stringify({ dry_run: dry, plan: arm.plan, ...record }, null, 2) + "\n");
    summary.push(summaryRow(arm.name, record));
    if (record.totals.errors || record.terminal.kind === "failed") process.exitCode = 1;
  }
  await writeFile(join(values.out, "summary.md"), summary.join("\n") + "\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
