import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runBench } from "./run-bench.js";
import { loadArms } from "./plan-file.js";
import { cannedAnswer, cannedInvoke } from "./canned-ports.js";
import { makeClaudeInvoker } from "./claude-cli-invoker.js";
import { expectedModels, summaryRow } from "./report.js";
import type { Row } from "./types.js";

async function main() {
  const { values } = parseArgs({ options: { plan: { type: "string" }, out: { type: "string" },
    "i-accept-model-cost": { type: "boolean" }, "dry-run": { type: "boolean" } } });
  const dry = values["dry-run"] === true;
  if (!dry && !values["i-accept-model-cost"]) throw new Error("Live runs require --i-accept-model-cost");
  if (!values.plan || !values.out) throw new Error("Expected --plan <file.json> --out <dir>");
  const arms = await loadArms(values.plan);
  const ports = { record: () => {}, clock: () => performance.now(), answer: cannedAnswer, invoke: cannedInvoke };
  const estimates = [];
  for (const arm of arms) {
    const record = await runBench(arm.plan, ports);
    console.log(`${arm.name}: ${record.totals.invocations} expected invocations (canned)`);
    console.log(`  Expected by model: ${expectedModels(record)}`);
    estimates.push(arm);
  }
  const summary = [dry ? "# Dry run (canned responses)" : "# Model run",
    "", "Token columns sum metered calls. A call without metering makes the total cost unknown.", "",
    "| Arm | Tokens in | Tokens out | Cache read | Cache creation | USD | Wall ms | Calls | Errors | Unmetered | Outcome | Hard-output score | Verification | Reported models |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|---|"];
  for (const arm of estimates) {
    const dir = join(values.out, arm.name);
    await mkdir(dir, { recursive: true });
    const journal = join(dir, "rows.jsonl");
    await writeFile(journal, "", { flag: "wx" });
    const record = await runBench(arm.plan, {
      ...ports,
      invoke: dry ? cannedInvoke : makeClaudeInvoker(arm.plan.call_timeout_ms),
      record: (row: Row) => appendFileSync(journal, JSON.stringify(row) + "\n", { flush: true }),
    });
    await writeFile(join(dir, "record.json"), JSON.stringify({ dry_run: dry, plan: arm.plan, ...record }, null, 2) + "\n");
    await writeFile(join(dir, "sections.json"), JSON.stringify(record.sections, null, 2) + "\n");
    summary.push(summaryRow(arm.name, record));
    if (record.totals.errors || record.terminal.kind !== "done") process.exitCode = 1;
  }
  await writeFile(join(values.out, "summary.md"), summary.join("\n") + "\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
