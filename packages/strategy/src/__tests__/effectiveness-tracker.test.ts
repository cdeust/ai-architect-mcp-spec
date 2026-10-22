import { describe, it, expect, vi } from "vitest";
import type { EvidenceRepository, StrategyPerformanceSummary } from "@prd-gen/core";
import {
  EffectivenessTracker,
  ExecutionResultSchema,
  type ExecutionResult,
} from "../effectiveness-tracker.js";

const summary = (o: Partial<StrategyPerformanceSummary>): StrategyPerformanceSummary => ({
  strategy: "chain_of_thought" as never,
  executionCount: 10,
  avgExpectedImprovement: 1,
  avgActualGain: 1,
  performanceDelta: 0,
  complianceRate: 1,
  ...o,
});

function tracker(rows: StrategyPerformanceSummary[]) {
  const recordStrategyExecution = vi.fn();
  const getStrategyPerformance = vi.fn().mockReturnValue(rows);
  const repo = { recordStrategyExecution, getStrategyPerformance } as unknown as EvidenceRepository;
  return { t: new EffectivenessTracker(repo), recordStrategyExecution, getStrategyPerformance };
}

describe("EffectivenessTracker.recordExecution", () => {
  it("flattens the assignment into a StrategyExecution and forwards the session id", () => {
    const { t, recordStrategyExecution } = tracker([]);
    const result = {
      strategy: "chain_of_thought",
      assignment: {
        expectedImprovement: 0.4,
        claimAnalysis: { characteristics: ["a", "b"], complexityTier: "moderate" },
      },
      actualConfidenceGain: 0.3,
      wasCompliant: true,
      retryCount: 2,
      prdContext: "feature",
      sessionId: "s1",
    } as unknown as ExecutionResult;
    t.recordExecution(result);
    expect(recordStrategyExecution).toHaveBeenCalledWith(
      {
        strategy: "chain_of_thought",
        claimCharacteristics: ["a", "b"],
        complexityTier: "moderate",
        expectedImprovement: 0.4,
        actualConfidenceGain: 0.3,
        wasCompliant: true,
        retryCount: 2,
        prdContext: "feature",
      },
      "s1",
    );
  });
});

describe("EffectivenessTracker.generateReport", () => {
  it("reports zeros when there is no data", () => {
    const { t, getStrategyPerformance } = tracker([]);
    expect(t.generateReport()).toEqual({
      totalMeasurements: 0,
      averageConfidenceGain: 0,
      overallComplianceRate: 0,
      underperformingStrategies: [],
      overperformingStrategies: [],
    });
    expect(getStrategyPerformance).toHaveBeenCalledWith(5);
  });

  it("weights averages by execution count and passes minExecutions through", () => {
    const { t, getStrategyPerformance } = tracker([
      summary({ executionCount: 1, avgActualGain: 0, complianceRate: 0 }),
      summary({ strategy: "tree_of_thoughts" as never, executionCount: 3, avgActualGain: 1, complianceRate: 1 }),
    ]);
    const r = t.generateReport(2);
    expect(getStrategyPerformance).toHaveBeenCalledWith(2);
    expect(r.totalMeasurements).toBe(4);
    expect(r.averageConfidenceGain).toBeCloseTo(0.75);
    expect(r.overallComplianceRate).toBeCloseTo(0.75);
  });

  it("flags strategies more than 20% off their expectation in either direction", () => {
    const { t } = tracker([
      summary({ strategy: "chain_of_thought" as never, avgExpectedImprovement: 1, performanceDelta: -0.5 }),
      summary({ strategy: "tree_of_thoughts" as never, avgExpectedImprovement: 1, performanceDelta: 0.5 }),
      summary({ strategy: "react" as never, avgExpectedImprovement: 1, performanceDelta: 0.1 }),
    ]);
    const r = t.generateReport();
    expect(r.underperformingStrategies).toEqual(["chain_of_thought"]);
    expect(r.overperformingStrategies).toEqual(["tree_of_thoughts"]);
  });
});

describe("ExecutionResultSchema", () => {
  it("rejects incomplete results", () => {
    expect(ExecutionResultSchema.safeParse({ retryCount: -1 }).success).toBe(false);
  });
});
