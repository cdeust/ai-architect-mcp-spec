import { newPipelineState } from "@prd-gen/orchestration";
import { expect, it } from "vitest";
import { finishRecord, measurementScope } from "../real-run/run-record.js";

it.each([
  ["Hard-output score: 0.75 / 1.00", 0.75],
  ["header\nHard-output score: 0.75 / 1.00\nfooter", 0.75],
  ["xHard-output score: 0.75 / 1.00", null],
  ["Hard-output score: 0.75 / 1.00x", null],
])("extracts scores only on a complete line: %s", (summary, score) => {
  const terminal = { kind: "done" as const, summary: String(summary), artifacts: [] };
  const state = newPipelineState({ run_id: "record", feature_description: "scope" });
  const section = { section_type: "overview", status: "pending", attempt: 1, violation_count: 2 } as const;
  const stored = { ...section, last_violations: [], attempt_log: [] };
  state.sections = [stored, { ...stored, content: "" }, { ...stored, content: "draft" }];
  const record = finishRecord(state, terminal, [], 3, 1, 12);
  expect(record).toEqual({
    section_content: { count: 3, total_characters: 5, min_characters: 0, has_duplicates: true },
    measurement_scope: measurementScope, terminal, rows: [], batches: 1, steps: 3, wall_time_ms: 12,
    sections: [{ ...section, content: null }, { ...section, content: "" }, { ...section, content: "draft" }],
    totals: { invocations: 0, errors: 0, unmetered_calls: 0, input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0, duration_ms: 0, cost_usd: 0 },
    per_purpose: {}, quality: { outcome: null, hard_output_score: score, distribution: null },
  });
});

it("records a null minimum when a run stops before creating any sections", () => {
  const state = newPipelineState({ run_id: "record", feature_description: "scope" });
  const record = finishRecord(state, { kind: "stopped", reason: "max_steps" }, [], 1, 0, 0);
  expect(record.section_content).toEqual({ count: 0, min_characters: null, total_characters: 0, has_duplicates: false });
});
