import type { RunRecord } from "./types.js";

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

export function summaryRow(name: string, record: RunRecord) {
  const { totals, quality } = record;
  const distribution = Object.entries(quality.distribution ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  const cells = [name, totals.input_tokens, totals.output_tokens, totals.cache_read_tokens, totals.cache_creation_tokens,
    totals.cost_usd ?? "unknown", record.wall_time_ms.toFixed(1), totals.invocations, totals.errors, totals.unmetered_calls,
    quality.outcome?.status ?? record.terminal.kind, quality.hard_output_score ?? "—", distribution || "—", reportedModels(record)];
  return `| ${cells.join(" | ")} |`;
}
