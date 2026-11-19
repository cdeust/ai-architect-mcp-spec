import type { RunRecord, Totals } from "./types.js";

export function expectedModels(record: RunRecord): string {
  const counts = new Map([["session", 0]]);
  for (const { used } of record.rows) {
    counts.set(used.model, (counts.get(used.model) ?? 0) + 1);
  }
  return [...counts].map(([model, count]) => `${model}=${count}`).join(", ");
}

function reportedModels(record: RunRecord): string {
  const models = new Set<string>();
  for (const { usage } of record.rows) {
    for (const model of usage?.model_reported.split(", ") ?? []) models.add(model);
  }
  return [...models].join(", ") || "—";
}

function totalTokens(totals: Totals): number {
  return totals.input_tokens + totals.output_tokens + totals.cache_read_tokens + totals.cache_creation_tokens;
}

function ratio(value: number | null, baseline: number | null): string {
  if (value === null || baseline === null || baseline === 0) return "—";
  return `${(value / baseline).toFixed(2)}×`;
}

export function summaryRow(name: string, record: RunRecord, baseline: Totals): string {
  const { totals, quality } = record;
  const distribution = Object.entries(quality.distribution ?? {})
    .map(([label, count]) => `${label} ${count}`).join(", ");
  const tokenRatio = totals.unmetered_calls || baseline.unmetered_calls
    ? "—" : ratio(totalTokens(totals), totalTokens(baseline));
  const cells = [
    name, totals.input_tokens, totals.output_tokens, totals.cache_read_tokens, totals.cache_creation_tokens,
    totalTokens(totals), tokenRatio, totals.cost_usd ?? "unknown", ratio(totals.cost_usd, baseline.cost_usd),
    record.wall_time_ms.toFixed(1), totals.invocations, totals.errors, totals.unmetered_calls,
    quality.outcome?.status ?? record.terminal.kind, quality.hard_output_score ?? "—", distribution || "—",
    reportedModels(record),
  ];
  return `| ${cells.join(" | ")} |`;
}

export function summaryHeader(dry: boolean): string[] {
  return [dry ? "# Dry run (canned responses)" : "# Model run",
    "", "Token columns sum metered calls. A call without metering makes the total cost unknown.", "",
    "| Arm | Tokens in | Tokens out | Cache read | Cache creation | Total tokens | Tokens / first | USD | USD / first | Wall ms | Calls | Errors | Unmetered | Outcome | Hard-output score | Verification | Reported models |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|---|"];
}
