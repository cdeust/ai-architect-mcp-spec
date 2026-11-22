/**
 * #122 — a failed section's draft is not a deliverable (file_export withholds
 * it), so self-check must not judge its claims either: otherwise the
 * verification report counts claims of a draft that is not in the PRD.
 * The failure stays visible through done.outcome ("needs_attention").
 */

import { describe, it, expect } from "vitest";
import {
  newPipelineState,
  step,
  type PipelineState,
  type SectionStatus,
} from "../index.js";

const MECHANICAL_AC_CONTENT = [
  "## acceptance_criteria",
  "",
  "AC-010 : Étant donné le code source, quand on l'inspecte, alors aucune fonction n'est présente.",
  "",
  "AC-011 : Étant donné le module, quand on grep les constantes, alors aucune référence n'est trouvée.",
].join("\n");

function section(
  section_type: SectionStatus["section_type"],
  status: SectionStatus["status"],
  content: string,
): SectionStatus {
  return {
    section_type,
    status,
    attempt: 1,
    violation_count: status === "failed" ? 1 : 0,
    last_violations: [],
    content,
    attempt_log: [],
  };
}

function selfCheckState(sections: SectionStatus[]): PipelineState {
  const base = newPipelineState({
    run_id: "self-check-failed-sections",
    feature_description: "failed sections are not judged",
    skip_preflight: true,
  });
  return { ...base, current_step: "self_check", sections };
}

describe("self-check skips failed section drafts (#122)", () => {
  it("a failed draft's claims are not evaluated", () => {
    const out = step({
      state: selfCheckState([
        section("acceptance_criteria", "failed", MECHANICAL_AC_CONTENT),
      ]),
      result: undefined,
    });

    expect(out.action.kind).not.toBe("spawn_subagents");
    const done = out.state.pending_completion;
    expect(done).toBeDefined();
    expect(done!.verification?.claims_evaluated ?? 0).toBe(0);
    expect(done!.verification?.judge_verdicts ?? []).toHaveLength(0);
    expect(done!.outcome?.status).toBe("needs_attention");
  });

  it("the same draft, passed, is evaluated", () => {
    const out = step({
      state: selfCheckState([
        section("acceptance_criteria", "passed", MECHANICAL_AC_CONTENT),
      ]),
      result: undefined,
    });

    expect(out.state.pending_completion?.verification?.claims_evaluated).toBe(2);
  });
});

it("dispatches and requires semantic evidence before a self-check can pass", () => {
  const state = {
    ...selfCheckState([
      section("requirements", "passed", "Export a local copy."),
      section("acceptance_criteria", "passed", MECHANICAL_AC_CONTENT),
    ]),
    semantic_review_requested: true as const,
  };
  const first = step({ state, result: undefined });
  expect(first.action).toMatchObject({
    kind: "spawn_subagents", purpose: "judge", batch_id: expect.stringMatching(/^self_check_scope_coverage_/),
  });
  expect(first.state.pending_completion).toBeNull();
  const batch = first.action;
  if (batch.kind !== "spawn_subagents") throw new Error("Expected a semantic review");
  const rejected = step({
    state: first.state, result: {
      kind: "subagent_batch_result", batch_id: batch.batch_id, responses: [{
        invocation_id: batch.invocations[0]!.invocation_id, raw_text: "Unavailable",
      }],
    },
  });
  expect(rejected.state.pending_completion?.outcome).toMatchObject({
    status: "needs_attention",
    reasons: expect.arrayContaining(["semantic_review: current, complete scope and edge-case evidence is required"]),
  });
});
