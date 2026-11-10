/**
 * `done.outcome` — the terminal action says whether the run's deliverables
 * can be trusted, so a failed run never reads as a plain success.
 *
 * Proves:
 *   1. computeDoneOutcome is "passed" with no reasons when nothing failed,
 *      and "needs_attention" with one reason per fact (failed sections,
 *      critical violations, score at 0) otherwise, in that order.
 *   2. Through the real step graph (self_check → implementation_gate →
 *      "PRD only" → finalize → remember → done), a run with a failed
 *      section ends on `done` with outcome "needs_attention", and its
 *      summary's first line says so; a run with nothing failed ends on
 *      outcome "passed" with the unchanged "Self-check complete." line.
 *
 * source: issue #122 — an audited run showed a 0.00 score next to `done`.
 */

import { describe, expect, it } from "vitest";
import {
  newPipelineState,
  step,
  type PipelineState,
  type SectionStatus,
} from "../index.js";
import { computeDoneOutcome } from "../handlers/self-check.js";
import { resolveImplementationGatePrdOnly } from "./helpers/resolve-completion.js";

describe("computeDoneOutcome", () => {
  it("passes when no section failed, nothing is critical and the score is above 0", () => {
    expect(computeDoneOutcome(0, 0, 0.42)).toEqual({ status: "passed", reasons: [] });
  });

  it("names every fact that needs attention, in a fixed order", () => {
    expect(computeDoneOutcome(2, 52, 0)).toEqual({
      status: "needs_attention",
      reasons: [
        "2 section(s) failed validation",
        "52 critical deterministic violation(s)",
        "hard-output score is 0.00",
      ],
    });
  });

  it("a score of 0 alone is enough", () => {
    expect(computeDoneOutcome(0, 0, 0)).toEqual({
      status: "needs_attention",
      reasons: ["hard-output score is 0.00"],
    });
  });
});

function failedSection(): SectionStatus {
  return {
    section_type: "requirements",
    status: "failed",
    attempt: 3,
    violation_count: 4,
    last_violations: [],
    attempt_log: [],
  };
}

function stateAtSelfCheck(sections: SectionStatus[]): PipelineState {
  const s = newPipelineState({
    run_id: "done_outcome_001",
    feature_description: "OAuth login for the mobile app",
  });
  // No section carries content, so the judge phase short-circuits and the
  // test isolates the outcome computed by self_check's finalize().
  return { ...s, current_step: "self_check", prd_context: "feature", sections };
}

function runToDone(sections: SectionStatus[]) {
  const issued = resolveImplementationGatePrdOnly(
    step({ state: stateAtSelfCheck(sections) }),
  );
  expect(issued.action.kind).toBe("call_cortex_tool");
  const cid =
    issued.action.kind === "call_cortex_tool" ? issued.action.correlation_id : "";
  return step({
    state: issued.state,
    result: { kind: "tool_result", correlation_id: cid, success: true, data: {} },
  });
}

describe("done.outcome through the step graph", () => {
  it("a run with a failed section ends on done marked needs_attention", () => {
    const out = runToDone([failedSection()]);
    expect(out.action.kind).toBe("done");
    if (out.action.kind !== "done") return;
    expect(out.action.outcome?.status).toBe("needs_attention");
    expect(out.action.outcome?.reasons).toContain("1 section(s) failed validation");
    expect(out.action.summary.split("\n")[0]).toBe(
      `Self-check complete: NEEDS ATTENTION (${out.action.outcome?.reasons.join("; ")}).`,
    );
  });

  it("a run with nothing failed ends on done marked passed, summary unchanged", () => {
    const out = runToDone([]);
    expect(out.action.kind).toBe("done");
    if (out.action.kind !== "done") return;
    expect(out.action.outcome).toEqual({ status: "passed", reasons: [] });
    expect(out.action.summary.split("\n")[0]).toBe("Self-check complete.");
  });
});
