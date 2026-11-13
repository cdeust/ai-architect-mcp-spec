/**
 * D2.D — observation flush hook integration tests.
 *
 * Tests the concludeSection / concludeDocument path with the onObservation
 * callback (D2.B). All tests use stub data — no SQLite, no filesystem I/O
 * required (hermetic by design per coding-standards §3.2).
 *
 * source: D2.D specification; coding-standards §4 (hermetic tests).
 */

import { describe, expect, it, vi } from "vitest";
import { concludeSection } from "../orchestrator.js";
import type { JudgeVerdict, AgentIdentity } from "@prd-gen/core";
import type { ClaimObservationFlushed, ConcludeOptions } from "../orchestrator.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function judge(name: string): AgentIdentity {
  return { kind: "genius", name } as AgentIdentity;
}

function verdict(
  claimId: string,
  jName: string,
  v: JudgeVerdict["verdict"],
  confidence = 0.9,
): JudgeVerdict {
  return {
    judge: judge(jName),
    claim_id: claimId,
    verdict: v,
    rationale: "test",
    caveats: [],
    confidence,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("concludeSection — observation flush hook (D2.B)", () => {
  it("D2.D-7: onObservation called once per (judge × claim) when claimTypes is provided", () => {
    const observations: ClaimObservationFlushed[] = [];
    const flusher = vi.fn((obs: ClaimObservationFlushed) => {
      observations.push(obs);
    });

    const verdicts: JudgeVerdict[] = [
      verdict("C-1", "alice", "PASS"),
      verdict("C-1", "bob", "PASS"),
      verdict("C-2", "alice", "FAIL"),
    ];

    const claimTypes = new Map<string, "correctness" | "architecture">([
      ["C-1", "correctness"],
      ["C-2", "correctness"],
    ]);

    const opts: ConcludeOptions = {
      strategy: "weighted_average",
      claimTypes,
      onObservation: flusher,
    };

    concludeSection("overview", verdicts, opts);

    // C-1 has 2 judges, C-2 has 1 judge → 3 calls total.
    expect(flusher).toHaveBeenCalledTimes(3);

    // C-1: consensus verdict is PASS → groundTruthIsFail = false.
    const c1Obs = observations.filter((o) => o.claimType === "correctness" && observations.indexOf(o) < 2);
    // Both judges for C-1 should have judgeWasCorrect = true (they said PASS = correct when gt is PASS).
    for (const obs of c1Obs) {
      expect(obs.observation.groundTruthIsFail).toBe(false);
      expect(obs.observation.judgeWasCorrect).toBe(true);
    }
  });

  it("D2.D-8: onObservation not called when claimTypes is absent", () => {
    const flusher = vi.fn();

    const verdicts: JudgeVerdict[] = [
      verdict("C-1", "alice", "PASS"),
    ];

    // No claimTypes → no observations flushed (guard: claimType must be known).
    concludeSection("overview", verdicts, {
      strategy: "weighted_average",
      onObservation: flusher,
      // claimTypes not provided
    });

    expect(flusher).not.toHaveBeenCalled();
  });

  it("D2.D-9: FAIL consensus verdict → groundTruthIsFail = true", () => {
    const observations: ClaimObservationFlushed[] = [];
    const flusher = (obs: ClaimObservationFlushed) => observations.push(obs);

    // Both judges say FAIL → consensus = FAIL → groundTruthIsFail = true.
    const verdicts: JudgeVerdict[] = [
      verdict("C-1", "alice", "FAIL"),
      verdict("C-1", "bob", "FAIL"),
    ];

    concludeSection("overview", verdicts, {
      claimTypes: new Map([["C-1", "correctness"]]),
      onObservation: flusher,
    });

    expect(observations).toHaveLength(2);
    for (const obs of observations) {
      // Consensus = FAIL → groundTruthIsFail = true.
      expect(obs.observation.groundTruthIsFail).toBe(true);
      // Both judges said FAIL → judgeWasCorrect = true (gt=FAIL, judge=FAIL).
      expect(obs.observation.judgeWasCorrect).toBe(true);
    }
  });

  it("D2.D-10: dissenting judge marked judgeWasCorrect = false", () => {
    const observations: ClaimObservationFlushed[] = [];
    const flusher = (obs: ClaimObservationFlushed) => observations.push(obs);

    // 2 say FAIL, 1 says PASS → consensus = FAIL (majority + fail_threshold).
    const verdicts: JudgeVerdict[] = [
      verdict("C-1", "alice", "FAIL", 0.8),
      verdict("C-1", "bob", "FAIL", 0.8),
      verdict("C-1", "charlie", "PASS", 0.4),
    ];

    concludeSection("overview", verdicts, {
      claimTypes: new Map([["C-1", "correctness"]]),
      onObservation: flusher,
    });

    expect(observations).toHaveLength(3);

    const charlieObs = observations.find((o) => o.judge.name === "charlie");
    expect(charlieObs).toBeDefined();
    // Charlie said PASS, but consensus is FAIL → groundTruthIsFail = true.
    // Charlie said PASS (not FAIL) → judgeWasCorrect = false.
    expect(charlieObs!.observation.groundTruthIsFail).toBe(true);
    expect(charlieObs!.observation.judgeWasCorrect).toBe(false);
  });

  it.each(["parse_error", "judge_invocation_failed", "plan_mismatch"])(
    "#121: a verdict that carries %s is not flushed, and the claim still concludes on every verdict",
    (caveat) => {
      // docs/PHASE_4_PLAN.md, "Parse-failure rate as a separate special-cause
      // signal": such verdicts "are NOT included in the reliability
      // calculation". They stand for a failure of the machinery, not for
      // what the judge concluded.
      const observations: ClaimObservationFlushed[] = [];
      const failed: JudgeVerdict = { ...verdict("C-1", "carol", "INCONCLUSIVE", 0), caveats: [caveat] };
      const verdicts = [verdict("C-1", "alice", "PASS"), verdict("C-1", "bob", "PASS"), failed];
      const options: ConcludeOptions = { claimTypes: new Map([["C-1", "correctness"]]) };

      const report = concludeSection("overview", verdicts, {
        ...options,
        onObservation: (obs) => observations.push(obs),
      });

      expect(observations.map((o) => o.judge.name)).toEqual(["alice", "bob"]);
      // The consensus is the one of the three verdicts: only the flush changes.
      expect(report).toEqual(concludeSection("overview", verdicts, options));
      expect(report.judges_invoked).toBe(3);
    },
  );

  it("#121: another caveat does not keep a verdict out of the flush", () => {
    const observations: ClaimObservationFlushed[] = [];
    const hedged: JudgeVerdict = { ...verdict("C-1", "carol", "PASS"), caveats: ["depends on the runtime"] };
    concludeSection("overview", [verdict("C-1", "alice", "PASS"), hedged], {
      claimTypes: new Map([["C-1", "correctness"]]),
      onObservation: (obs) => observations.push(obs),
    });
    expect(observations.map((o) => o.judge.name)).toEqual(["alice", "carol"]);
  });

  it("D2.D-11: observation flusher errors are not propagated (best-effort)", () => {
    // The flusher throws; the pipeline must not abort (best-effort semantics).
    // Named failure mode (coding-standards §6.1): "flusher throws on DB error
    // or log write failure." The try/catch in concludeFromVerdicts swallows it.
    const flusher = vi.fn().mockImplementation(() => {
      throw new Error("DB write failed");
    });

    const verdicts: JudgeVerdict[] = [
      verdict("C-1", "alice", "PASS"),
    ];

    // Must not throw even though flusher always throws.
    expect(() =>
      concludeSection("overview", verdicts, {
        claimTypes: new Map([["C-1", "correctness"]]),
        onObservation: flusher,
      }),
    ).not.toThrow();

    expect(flusher).toHaveBeenCalledTimes(1);
  });
});
