/**
 * Learning-loop tests for EvidenceRepository: strategy performance,
 * historical adjustments, quality history and adaptive thresholds.
 * Real better-sqlite3 against temp files; skipped if the native module is
 * unavailable (same contract as evidence-retention.test.ts).
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import {
  tryCreateEvidenceRepository,
  type StrategyExecution,
  type PRDQualityScore,
} from "../index.js";

const paths: string[] = [];

function open() {
  const p = join(tmpdir(), `evidence-learning-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(p);
  return tryCreateEvidenceRepository(p);
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const s of ["", "-wal", "-shm"]) if (existsSync(p + s)) rmSync(p + s);
  }
});

const exec = (o: Partial<StrategyExecution> = {}): StrategyExecution => ({
  strategy: "chain_of_thought" as never,
  claimCharacteristics: ["a"],
  complexityTier: "moderate",
  expectedImprovement: 0.5,
  actualConfidenceGain: 0.5,
  wasCompliant: true,
  retryCount: 0,
  prdContext: "feature",
  ...o,
});

const score = (n: number, o: Partial<PRDQualityScore> = {}): PRDQualityScore => ({
  prdId: `prd-${n}`,
  prdContext: "feature",
  rulesChecked: 10,
  rulesPassed: 8,
  criticalViolations: 0,
  totalScore: n,
  auditFlagsRaised: 0,
  ...o,
});

describe("EvidenceRepository learning loop", () => {
  it("summarises strategy performance and honours the minimum-executions floor", () => {
    const repo = open();
    if (!repo) return;
    for (let i = 0; i < 3; i++) repo.recordStrategyExecution(exec({ actualConfidenceGain: 0.2, wasCompliant: i > 0 }));
    repo.recordStrategyExecution(exec({ strategy: "tree_of_thoughts" as never }));

    expect(repo.getStrategyPerformance(10)).toEqual([]);
    const rows = repo.getStrategyPerformance(3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ strategy: "chain_of_thought", executionCount: 3 });
    expect(rows[0]!.avgExpectedImprovement).toBeCloseTo(0.5);
    expect(rows[0]!.avgActualGain).toBeCloseTo(0.2);
    expect(rows[0]!.performanceDelta).toBeCloseTo(-0.3);
    expect(rows[0]!.complianceRate).toBeCloseTo(2 / 3);
    expect(repo.getStrategyPerformance(1).map((r) => r.strategy)[0]).toBe("chain_of_thought");
    repo.close();
  });

  it("clamps historical adjustments to ±0.3 and skips zero-expectation strategies", () => {
    const repo = open();
    if (!repo) return;
    repo.recordStrategyExecution(exec({ strategy: "chain_of_thought" as never, expectedImprovement: 0.1, actualConfidenceGain: 0.9 }));
    repo.recordStrategyExecution(exec({ strategy: "tree_of_thoughts" as never, expectedImprovement: 1, actualConfidenceGain: 0 }));
    repo.recordStrategyExecution(exec({ strategy: "react" as never, expectedImprovement: 0.5, actualConfidenceGain: 0.55 }));
    repo.recordStrategyExecution(exec({ strategy: "self_consistency" as never, expectedImprovement: 0, actualConfidenceGain: 1 }));

    const adj = repo.getHistoricalAdjustments(1);
    expect(adj.get("chain_of_thought" as never)).toBe(0.3);
    expect(adj.get("tree_of_thoughts" as never)).toBe(-0.3);
    expect(adj.get("react" as never)).toBeCloseTo(0.1);
    expect(adj.has("self_consistency" as never)).toBe(false);
    repo.close();
  });

  it("returns quality history newest-limited and round-trips every field", () => {
    const repo = open();
    if (!repo) return;
    repo.recordQualityScore(score(1, { prdContext: "proposal", criticalViolations: 2, auditFlagsRaised: 3 }));
    repo.recordQualityScore(score(2));
    const all = repo.getQualityHistory();
    expect(all).toHaveLength(2);
    expect(all).toContainEqual({
      prdId: "prd-1",
      prdContext: "proposal",
      rulesChecked: 10,
      rulesPassed: 8,
      criticalViolations: 2,
      totalScore: 1,
      auditFlagsRaised: 3,
    });
    expect(repo.getQualityHistory(1)).toHaveLength(1);
    repo.close();
  });

  it("derives p25/p50/p75 thresholds only once enough samples exist", () => {
    const repo = open();
    if (!repo) return;
    for (let i = 1; i <= 19; i++) repo.recordQualityScore(score(i));
    repo.recalculateThresholds();
    expect(repo.getThreshold("quality_fail_threshold")).toBeUndefined();

    repo.recordQualityScore(score(20));
    repo.recalculateThresholds();
    const fail = repo.getThreshold("quality_fail_threshold")!;
    expect(fail.currentValue).toBe(6);
    expect(fail.sampleCount).toBe(20);
    expect(repo.getThreshold("quality_improvement_threshold")!.currentValue).toBe(11);
    expect(repo.getThreshold("quality_good_threshold")!.currentValue).toBe(16);

    // Re-running upserts rather than duplicating.
    repo.recordQualityScore(score(21));
    repo.recalculateThresholds();
    expect(repo.getThreshold("quality_fail_threshold")!.sampleCount).toBe(21);
    repo.close();
  });

  it("ignores an empty run id when pruning and counts rows", () => {
    const repo = open();
    if (!repo) return;
    repo.recordStrategyExecution(exec());
    expect(repo.pruneRunEvidence("")).toBe(0);
    expect(repo.strategyExecutionCount()).toBe(1);
    repo.close();
  });

  it("creates missing parent directories for the database", () => {
    const root = join(tmpdir(), `evidence-nested-${Date.now()}`);
    const dir = join(root, "a", "b");
    const repo = tryCreateEvidenceRepository(join(dir, "e.db"));
    try {
      if (!repo) return;
      expect(existsSync(dir)).toBe(true);
      repo.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
