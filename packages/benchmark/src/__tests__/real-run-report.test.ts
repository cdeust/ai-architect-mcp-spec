import { expect, it } from "vitest";
import { expectedModels, summaryHeader, summaryRow } from "../real-run/report.js";
import type { Row, RunRecord, Totals } from "../real-run/types.js";

const totals: Totals = { invocations: 3, errors: 1, unmetered_calls: 0,
  input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_creation_tokens: 4,
  duration_ms: 17, cost_usd: 0.33 };
const baseline = { ...totals, output_tokens: 4, cost_usd: 2 };
function call(id: string, model: string, reported: string, mixed: boolean): Row {
  return { batch_id: "batch", invocation_id: id, used: { model, effort: "low" },
    purpose: "probe", agent_type: "engineer", isolation: "none", prompt_characters: 0,
    workspace_kept: false, requested: { model: null, effort: null }, error: null,
    usage: { ...totals, model_reported: reported, ...(mixed && { per_model: {} }) } };
}
const record: RunRecord = {
  section_content: { count: 0, total_characters: 0, min_characters: null, has_duplicates: false },
  measurement_scope: "", rows: [call("i", "a", "one, two", true), call("j", "a", "two, three", true),
    call("k", "session", "", false)], sections: [], totals, per_purpose: {}, batches: 1, steps: 1, wall_time_ms: 1.26,
  terminal: { kind: "stopped", reason: "max_steps" }, quality: { outcome: null, hard_output_score: 0, distribution: null },
};

it("prints every column and rounds time, cost and token ratios independently", () => {
  expect(expectedModels(record)).toBe("session=1, a=2");
  expect(summaryRow("arm", record, baseline)).toBe(
    "| arm | 1 | 2 | 3 | 4 | 10 | 0.83× | 0.33 | 0.17× | 1.3 | 3 | 1 | 0 | stopped (max_steps) | 0 | — | one, two, three | batch/i, batch/j | 0 | 0 | — |");
});

it.each(["current", "baseline", "zero baseline"])("prints unavailable cells for %s", source => {
  const first = source === "zero baseline" ? { ...baseline, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0 } : { ...baseline, unmetered_calls: Number(source === "baseline") };
  const current = { ...totals, unmetered_calls: Number(source === "current") };
  const row = summaryRow("arm", { ...record, rows: [], totals: current,
    quality: { outcome: null, hard_output_score: null, distribution: null } }, first);
  expect(row).toBe(`| arm | 1 | 2 | 3 | 4 | 10 | — | 0.33 | — | 1.3 | 3 | 1 | ${current.unmetered_calls} | stopped (max_steps) | — | — | — | — | 0 | 0 | — |`);
});

it.each([true, false])("pins the entire report preamble, dry=%s", dry => {
  expect(summaryHeader(dry)).toEqual([
    dry ? "# Dry run (canned responses)" : "# Model run", "",
    "Each live call is a bare claude -p session with no tools. The reducer's requested agent type and isolation are recorded but not applied. Host session cost is not measured.", "",
    "Later arms can read the prompt cache earlier arms wrote.", "",
    "Token columns sum reported usage. USD sums reported costs. Unmetered counts calls without a reported cost.",
    "Unmetered calls count as zero toward arm dollar limits and the plan cap. Each arm checks max_unmetered_calls after each call or parallel batch.", "",
    "| Arm | Tokens in | Tokens out | Cache read | Cache creation | Total tokens | Tokens / first | Reported USD | USD / first | Wall ms | Calls | Errors | Unmetered | Outcome | Hard-output score | Verification | Reported models | Mixed-model rows (batch/invocation) | Sections | Total section characters | Minimum section characters |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|---|---|---:|---:|---:|",
  ]);
});

it("prints the verification distribution and distinguishes terminal outcomes", () => {
  const unmetered = { ...call("i", "session", "", false), usage: null };
  const current: RunRecord = { ...record, rows: [unmetered],
    terminal: { kind: "done", artifacts: [], summary: "finished" },
    quality: { hard_output_score: 0.75, outcome: null,
      distribution: { PASS: 2, "SPEC-COMPLETE": 0, "NEEDS-RUNTIME": 1, INCONCLUSIVE: 0, FAIL: 1 } } };
  const summary = summaryRow("arm", current, baseline);
  expect(summary).toContain("| done | 0.75 | PASS 2, SPEC-COMPLETE 0, NEEDS-RUNTIME 1, INCONCLUSIVE 0, FAIL 1 | — | — |");
  current.terminal = { kind: "failed", reason: "missing", step: "verify" };
  expect(summaryRow("arm", current, baseline)).toContain("| failed | 0.75 |");
});
