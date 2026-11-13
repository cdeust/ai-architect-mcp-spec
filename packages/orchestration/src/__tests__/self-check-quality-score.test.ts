/**
 * #121 — a self-check that concludes queues the quality score of its
 * document for the evidence store. Nothing called `recordQualityScore`, so
 * `get_quality_history` could never return data (audit of 2026-10-10).
 * The queue is drained by the composition root (mcp-server pipeline-tools).
 */

import { describe, it, expect } from "vitest";
import { validateDocument } from "@prd-gen/validation";
import {
  makeCannedDispatcher,
  newPipelineState,
  step,
  type ActionResult,
  type PipelineState,
  type SectionStatus,
} from "../index.js";

function section(
  section_type: SectionStatus["section_type"],
  content: string,
): SectionStatus {
  return {
    section_type,
    status: "passed",
    attempt: 1,
    violation_count: 0,
    last_violations: [],
    content,
    attempt_log: [],
  };
}

/**
 * A document with a finding and no claim to judge: self-check concludes in
 * one step. The requirements table has no Source column (rule
 * fr_traceability) and names no identifier, so nothing is sent to a judge.
 */
const SECTIONS: SectionStatus[] = [
  section("requirements", "## requirements\n\n| ID | Requirement |\n|---|---|\n| a | x |"),
  section("overview", "## overview\n\nA short overview."),
];

function selfCheckState(prd_context: PipelineState["prd_context"]): PipelineState {
  const base = newPipelineState({
    run_id: "self-check-quality-score",
    feature_description: "the score of the document is recorded",
    skip_preflight: true,
  });
  return { ...base, current_step: "self_check", prd_context, sections: SECTIONS };
}

describe("self-check queues the quality score of its document (#121)", () => {
  it("queues one score with the figures of validateDocument", () => {
    const out = step({ state: selfCheckState("feature"), result: undefined });
    expect(out.state.current_step).toBe("implementation_gate");
    expect(out.state.pending_completion).not.toBeNull();

    const report = validateDocument(SECTIONS.map((s) => ({ type: s.section_type, content: s.content! })));
    // The fixture has a finding, so the figures below are not all trivial.
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.rulesPassed.length).toBeLessThan(report.rulesChecked.length);

    expect(out.state.quality_scores).toEqual([
      {
        prd_context: "feature",
        rules_checked: report.rulesChecked.length,
        rules_passed: report.rulesPassed.length,
        critical_violations: report.violations.filter((v) => v.isCritical).length,
        total_score: report.totalScore,
      },
    ]);
  });

  it("keeps a score already queued", () => {
    const earlier = {
      prd_context: "bug" as const,
      rules_checked: 3,
      rules_passed: 3,
      critical_violations: 0,
      total_score: 1,
    };
    const state = { ...selfCheckState("feature"), quality_scores: [earlier] };
    const out = step({ state, result: undefined });
    expect(out.state.quality_scores).toHaveLength(2);
    expect(out.state.quality_scores[0]).toEqual(earlier);
  });

  it("queues nothing for a run that has no PRD context", () => {
    const out = step({ state: selfCheckState(null), result: undefined });
    expect(out.state.pending_completion).not.toBeNull();
    expect(out.state.quality_scores).toEqual([]);
  });

  it("a whole run, judges included, queues one score, of the document it ends with", () => {
    const dispatch = makeCannedDispatcher({ freeform_answer: "answer", graph_path: "/tmp/quality-score/graph" });
    let state = newPipelineState({
      run_id: "quality-score-whole-run",
      feature_description: "build a feature for OAuth login",
      skip_preflight: true,
    });
    let result: ActionResult | undefined = undefined;
    let judged = false;
    let lastKind = "";
    for (let steps = 0; steps < 300; steps++) {
      const out = step({ state, result });
      state = out.state;
      lastKind = out.action.kind;
      if (out.action.kind === "spawn_subagents" && out.action.batch_id === "self_check_verify") judged = true;
      result = dispatch(out.action);
      if (result === undefined) break;
    }
    expect(lastKind).toBe("done");
    // The canned run sends claims to judges: the score is queued by the
    // step that reads their verdicts, not by the zero-claim path above.
    expect(judged).toBe(true);

    // The document self-check validates: every section that has content,
    // did not fail and is not the JIRA tickets (gatherSections).
    const document = state.sections
      .filter((s) => s.content && s.status !== "failed" && s.section_type !== "jira_tickets")
      .map((s) => ({ type: s.section_type, content: s.content! }));
    expect(document.length).toBeGreaterThan(1);
    const report = validateDocument(document);
    expect(state.quality_scores).toEqual([
      {
        prd_context: state.prd_context,
        rules_checked: report.rulesChecked.length,
        rules_passed: report.rulesPassed.length,
        critical_violations: report.violations.filter((v) => v.isCritical).length,
        total_score: report.totalScore,
      },
    ]);
  });

  it("starts a run with an empty queue", () => {
    const fresh = newPipelineState({ run_id: "r", feature_description: "f", skip_preflight: true });
    expect(fresh.quality_scores).toEqual([]);
  });
});
