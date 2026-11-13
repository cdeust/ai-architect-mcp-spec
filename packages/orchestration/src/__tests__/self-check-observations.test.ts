/**
 * #121 — a self-check that concludes on judge verdicts queues one
 * reliability observation per judge verdict.
 *
 * The verification orchestrator flushes an observation only when it is given
 * the types of the claims and a hook; the pipeline gave it neither, so a run
 * flushed nothing (0 rows after 7 runs, audit of 2026-10-10). The queue is
 * written by the composition root (mcp-server).
 */
import { describe, expect, it } from "vitest";
import type { Claim, JudgeVerdict } from "@prd-gen/core";
import { concludeDocument } from "@prd-gen/verification";
import { concludeWithObservations } from "../handlers/self-check-observations.js";
import {
  makeCannedDispatcher,
  newPipelineState,
  step,
  type ActionResult,
  type NextAction,
  type PipelineState,
} from "../index.js";

const genius = (name: "feynman" | "curie" | "popper") => ({ kind: "genius" as const, name });

function verdict(judge: JudgeVerdict["judge"], claim_id: string, value: JudgeVerdict["verdict"]): JudgeVerdict {
  return { judge, claim_id, verdict: value, rationale: "test", caveats: [], confidence: 0.9 };
}

const FR: Claim = { claim_id: "FR-001", claim_type: "fr_traceability", text: "FR-001 traces to its source", evidence: "" };
const MATH: Claim = {
  claim_id: "NFR-001",
  claim_type: "correctness",
  text: "2 + 2 = 4",
  evidence: "",
  external_grounding: { type: "math", payload: { expression: "2+2", expected_value: 4 } },
};

// Two judges pass FR-001 and one fails it; one judge passes NFR-001; a rule
// verdict stands for a claim no judge saw.
const VERDICTS: JudgeVerdict[] = [
  verdict(genius("feynman"), "FR-001", "PASS"),
  verdict(genius("curie"), "FR-001", "PASS"),
  verdict(genius("popper"), "FR-001", "FAIL"),
  verdict(genius("feynman"), "NFR-001", "PASS"),
  verdict({ kind: "rule", name: "hard_output_rules" } as JudgeVerdict["judge"], "AC-001", "PASS"),
];

describe("concludeWithObservations (#121)", () => {
  it("gives the report concludeDocument gives: the types change no consensus", () => {
    const concluded = concludeWithObservations(VERDICTS, [FR, MATH]);
    expect(concluded.report).toEqual(concludeDocument(VERDICTS));
    expect(concluded.report.results.find((r) => r.claim_id === "FR-001")!.verdict).toBe("PASS");
  });

  it("queues one observation per judge verdict on a judged claim, against the outcome retained", () => {
    const { observations } = concludeWithObservations(VERDICTS, [FR, MATH]);
    expect(observations).toEqual([
      { claim_id: "FR-001", judge: genius("feynman"), claim_type: "fr_traceability", ground_truth_is_fail: false, judge_was_correct: true },
      { claim_id: "FR-001", judge: genius("curie"), claim_type: "fr_traceability", ground_truth_is_fail: false, judge_was_correct: true },
      { claim_id: "FR-001", judge: genius("popper"), claim_type: "fr_traceability", ground_truth_is_fail: false, judge_was_correct: false },
      {
        claim_id: "NFR-001",
        judge: genius("feynman"),
        claim_type: "correctness",
        ground_truth_is_fail: false,
        judge_was_correct: true,
        external_grounding: { type: "math", payload: { expression: "2+2", expected_value: 4 } },
      },
    ]);
  });

  it("queues nothing for a judge whose answer could not be parsed", () => {
    // docs/PHASE_4_PLAN.md: parse failures "are NOT included in the
    // reliability calculation". The self-check makes such a verdict up when
    // a judge's answer is not the JSON it was asked for.
    const unparsed: JudgeVerdict = {
      ...verdict(genius("popper"), "FR-001", "INCONCLUSIVE"),
      caveats: ["parse_error"],
      confidence: 0,
    };
    const verdicts = [verdict(genius("feynman"), "FR-001", "PASS"), verdict(genius("curie"), "FR-001", "PASS"), unparsed];
    const { observations } = concludeWithObservations(verdicts, [FR]);
    expect(observations.map((o) => o.judge.name)).toEqual(["feynman", "curie"]);
  });

  it("queues nothing for a verdict on a claim that was not sent to judges", () => {
    const { observations } = concludeWithObservations(VERDICTS, [FR]);
    expect(observations.map((o) => o.claim_id)).toEqual(["FR-001", "FR-001", "FR-001"]);
  });

  it("queues nothing, and concludes as before, when no claim was sent to judges", () => {
    const concluded = concludeWithObservations(VERDICTS, []);
    expect(concluded.observations).toEqual([]);
    expect(concluded.report).toEqual(concludeDocument(VERDICTS));
  });
});

describe("the queue of a pipeline run (#121)", () => {
  it("starts empty", () => {
    const fresh = newPipelineState({ run_id: "r", feature_description: "f", skip_preflight: true });
    expect(fresh.reliability_observations).toEqual([]);
  });

  it("holds, after a whole run, one observation per judge the self-check sent a claim to", () => {
    const dispatch = makeCannedDispatcher({ freeform_answer: "answer", graph_path: "/tmp/observations/graph" });
    let state: PipelineState = newPipelineState({
      run_id: "observations-whole-run",
      feature_description: "build a feature for OAuth login",
      skip_preflight: true,
    });
    let result: ActionResult | undefined = undefined;
    let judged: Extract<NextAction, { kind: "spawn_subagents" }> | undefined;
    let lastKind = "";
    for (let steps = 0; steps < 300; steps++) {
      const out = step({ state, result });
      state = out.state;
      lastKind = out.action.kind;
      if (out.action.kind === "spawn_subagents" && out.action.batch_id === "self_check_verify") judged = out.action;
      result = dispatch(out.action);
      if (result === undefined) break;
    }
    expect(lastKind).toBe("done");
    expect(judged).toBeDefined();
    expect(judged!.invocations.length).toBeGreaterThan(1);

    expect(state.reliability_observations).toHaveLength(judged!.invocations.length);
    // Judges only: a rule-tier verdict is not an observation of a judge.
    expect(state.reliability_observations.filter((o) => o.judge.kind === "rule")).toEqual([]);
    // Every judged claim has its observations, and no other claim has any.
    const observed = new Set(state.reliability_observations.map((o) => o.claim_id));
    const sent = new Set(
      judged!.invocations.map((invocation) => /<claim>\s*id: (\S+)/.exec(invocation.prompt)![1]!),
    );
    expect([...observed].sort()).toEqual([...sent].sort());
  });

  it("holds nothing after a self-check that had no claim to judge", () => {
    const base = newPipelineState({ run_id: "no-claim", feature_description: "f", skip_preflight: true });
    const state: PipelineState = {
      ...base,
      current_step: "self_check",
      prd_context: "feature",
      sections: [
        {
          section_type: "overview",
          status: "passed",
          attempt: 1,
          violation_count: 0,
          last_violations: [],
          content: "## overview\n\nA short overview.",
          attempt_log: [],
        },
      ],
    };
    const out = step({ state, result: undefined });
    expect(out.state.current_step).toBe("implementation_gate");
    expect(out.state.reliability_observations).toEqual([]);
  });
});
