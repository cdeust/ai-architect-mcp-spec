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
    for (const model of usage?.model_reported.split(", ") ?? []) if (model) models.add(model);
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
    totalTokens(totals), tokenRatio, totals.cost_usd, totals.unmetered_calls || baseline.unmetered_calls ? "—" : ratio(totals.cost_usd, baseline.cost_usd),
    record.wall_time_ms.toFixed(1), totals.invocations, totals.errors, totals.unmetered_calls,
    quality.outcome?.status ?? record.terminal.kind, quality.hard_output_score ?? "—", distribution || "—",
    reportedModels(record),
    record.rows.filter(row => row.usage?.per_model).map(row => `${row.batch_id}/${row.invocation_id}`).join(", ") || "—",
  ];
  return `| ${cells.join(" | ")} |`;
}

export function summaryHeader(dry: boolean): string[] {
  return [dry ? "# Dry run (canned responses)" : "# Model run",
    "", "Token columns sum reported usage. USD sums reported costs. Unmetered counts calls without a reported cost.", "",
    "| Arm | Tokens in | Tokens out | Cache read | Cache creation | Total tokens | Tokens / first | Reported USD | USD / first | Wall ms | Calls | Errors | Unmetered | Outcome | Hard-output score | Verification | Reported models | Mixed-model rows (batch/invocation) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|---|---|"];
}
