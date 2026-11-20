import type { PipelineState } from "@prd-gen/orchestration";
import { addCost, reportedDollars } from "./cli-budget.js";
import type { Row, RunRecord, Totals } from "./types.js";

export const measurementScope = "Each live call is a bare claude -p session with no tools. The reducer's requested agent type and isolation are recorded but not applied. Host session cost is not measured.";

function totals(rows: Row[]): Totals {
  const result: Omit<Totals, "cost_usd" | "unmetered_calls"> = {
    invocations: rows.length,
    errors: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: 0,
  };
  const costs = { cost_usd: reportedDollars(0), unmetered_calls: 0 };
  for (const { usage, error } of rows) {
    if (error !== null) result.errors++;
    addCost(costs, usage);
    if (!usage) continue;
    for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "duration_ms"] as const) {
      result[key] += usage[key] ?? 0;
    }
  }
  return { ...result, cost_usd: costs.cost_usd.toNumber(), unmetered_calls: costs.unmetered_calls };
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
  const contents = state.sections.map(section => section.content ?? "");
  const lengths = contents.map(content => Array.from(content).length);
  return {
    section_content: {
      count: lengths.length,
      total_characters: lengths.reduce((total, length) => total + length, 0),
      min_characters: lengths.length ? Math.min(...lengths) : null,
      has_duplicates: new Set(contents).size !== contents.length,
    },
    measurement_scope: measurementScope,
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
