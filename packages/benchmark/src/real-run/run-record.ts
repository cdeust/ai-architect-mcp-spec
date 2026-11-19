import type { PipelineState } from "@prd-gen/orchestration";
import type { Row, RunRecord, Totals } from "./types.js";

export function addCost(total: Pick<Totals, "cost_usd" | "unmetered_calls">, usage: Row["usage"]) {
  if (usage?.cost_usd == null) total.unmetered_calls++;
  else total.cost_usd += usage.cost_usd;
}

function totals(rows: Row[]): Totals {
  const result: Totals = {
    invocations: rows.length,
    errors: 0,
    unmetered_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: 0,
    cost_usd: 0,
  };
  for (const { usage, error } of rows) {
    if (error !== null) result.errors++;
    addCost(result, usage);
    if (!usage) continue;
    for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "duration_ms"] as const) {
      result[key] += usage[key] ?? 0;
    }
  }
  return result;
}

function quality(terminal: RunRecord["terminal"]): RunRecord["quality"] {
  const done = terminal.kind === "done" ? terminal : undefined;
  const score = done?.summary.match(/^Hard-output score: ([\d.]+) \/ 1\.00$/m);
  return {
    outcome: done?.outcome ?? null,
    hard_output_score: score ? Number(score[1]) : null,
    distribution: done?.verification?.distribution ?? null,
  };
}

function perPurpose(rows: Row[]): RunRecord["per_purpose"] {
  const grouped: RunRecord["per_purpose"] = {};
  for (const purpose of new Set(rows.map(row => row.purpose))) {
    grouped[purpose] = totals(rows.filter(row => row.purpose === purpose));
  }
  return grouped;
}

export function finishRecord(
  state: PipelineState,
  terminal: RunRecord["terminal"],
  rows: Row[],
  steps: number,
  batches: number,
  wall_time_ms: number,
): RunRecord {
  return {
    terminal, rows, batches, steps,
    sections: state.sections.map(({ section_type, status, attempt, violation_count, content }) => ({
      section_type, status, attempt, violation_count, content: content ?? null,
    })),
    totals: totals(rows),
    per_purpose: perPurpose(rows),
    quality: quality(terminal),
    wall_time_ms,
  };
}
