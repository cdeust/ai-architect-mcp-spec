import { newPipelineState, type PipelineState } from "@prd-gen/orchestration";
import { selectStrategy } from "@prd-gen/strategy";
import { beforeEach, expect, it, vi } from "vitest";
import { writeObservation } from "../observation-writer.js";

const repositories = vi.hoisted(() => ({
  evidence: vi.fn(),
  reliability: vi.fn(),
}));

vi.mock("../evidence-db-path.js", () => ({ getEvidenceRepo: repositories.evidence }));
vi.mock("../reliability-wiring.js", () => ({ getReliabilityRepo: repositories.reliability }));
vi.mock("../observation-writer.js", () => ({ writeObservation: vi.fn() }));

const runId = "run_evidence_contract";

function pendingStrategyEvidence(): PipelineState {
  const claim = "Copying an example does not change the original.";
  const state = newPipelineState({ run_id: runId, feature_description: claim, prd_context: "feature" });
  return {
    ...state,
    strategy_executions: [{
      strategy: "chain_of_thought",
      assignment: selectStrategy({ claim, context: "feature" }),
      actualConfidenceGain: 0.3,
      wasCompliant: true,
      retryCount: 0,
      prdContext: "feature",
      sessionId: "prior-session",
    }],
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
});

it("writes pending evidence under the run id and clears all three queues before a replay", async () => {
  const strategyState = pendingStrategyEvidence();
  const judge = { kind: "team", name: "engineer" } as const;
  const recordStrategyExecution = vi.fn().mockImplementationOnce(() => {
    throw new Error("first strategy write failed");
  });
  const recordQualityScore = vi.fn();
  repositories.evidence.mockReturnValue({ recordStrategyExecution, recordQualityScore });
  const reliability = { recordObservation: vi.fn() };
  repositories.reliability.mockReturnValue(reliability);
  const { drainEvidenceQueues } = await import("../evidence-drain.js");
  const queued: PipelineState = {
    ...strategyState,
    strategy_executions: [...strategyState.strategy_executions, ...strategyState.strategy_executions],
    quality_scores: [{
      prd_context: "feature", rules_checked: 5, rules_passed: 4, critical_violations: 1, total_score: 0.8,
    }],
    reliability_observations: [{
      claim_id: "COPY-1", judge, claim_type: "correctness", ground_truth_is_fail: false, judge_was_correct: true,
    }],
  };

  const drained = drainEvidenceQueues(queued);
  expect(drained).toEqual({
    ...queued, strategy_executions: [], quality_scores: [], reliability_observations: [],
  });
  expect(drainEvidenceQueues(drained)).toBe(drained);
  expect(recordStrategyExecution).toHaveBeenCalledTimes(2);
  expect(recordStrategyExecution).toHaveBeenLastCalledWith(expect.objectContaining({
    strategy: "chain_of_thought", wasCompliant: true,
  }), runId);
  expect(recordQualityScore).toHaveBeenCalledExactlyOnceWith({
    prdId: runId, prdContext: "feature", rulesChecked: 5, rulesPassed: 4,
    criticalViolations: 1, totalScore: 0.8, auditFlagsRaised: null,
  });
  expect(writeObservation).toHaveBeenCalledExactlyOnceWith(reliability, expect.objectContaining({
    claim_id: "COPY-1", judge, observation: { groundTruthIsFail: false, judgeWasCorrect: true },
  }), runId);
  expect(repositories.reliability).toHaveBeenCalledOnce();

  drainEvidenceQueues(strategyState);
  expect(recordStrategyExecution).toHaveBeenCalledTimes(3);
  expect(repositories.evidence).toHaveBeenCalledTimes(2);
});

it("clears strategy evidence when no repository was available at first use", async () => {
  const state = pendingStrategyEvidence();
  repositories.evidence.mockReturnValue(null);
  const { drainEvidenceQueues } = await import("../evidence-drain.js");
  expect(drainEvidenceQueues(state).strategy_executions).toEqual([]);

  const recordStrategyExecution = vi.fn();
  repositories.evidence.mockReturnValue({ recordStrategyExecution });
  expect(drainEvidenceQueues(state).strategy_executions).toEqual([]);
  expect(repositories.evidence).toHaveBeenCalledOnce();
  expect(recordStrategyExecution).not.toHaveBeenCalled();
  expect(repositories.reliability).not.toHaveBeenCalled();
});
