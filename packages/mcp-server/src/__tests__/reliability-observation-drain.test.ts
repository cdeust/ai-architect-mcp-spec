/**
 * #121 — the drain of the reliability observations a run has queued.
 *
 * The queue is emptied whether the server has a reliability repository or
 * not: that is what keeps it from growing from step to step when
 * better-sqlite3 cannot be loaded (review 1 of #245). The stdio test of the
 * whole run is skipped in that case, so the rule is tested here without a
 * database: the repository is a recorder and the log is a spy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newPipelineState, type PipelineState } from "@prd-gen/orchestration";
import { OBSERVATION_LOG_PATH } from "../observation-log-path.js";
import { writeObservation } from "../observation-writer.js";
import { drainReliabilityObservations } from "../reliability-observation-drain.js";

vi.mock("@prd-gen/benchmark", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@prd-gen/benchmark")>();
  return { ...actual, appendObservationLog: vi.fn() };
});

// The real writer, counted: without a repository it must not be started at
// all. Started with none, it would fail inside its own best-effort handler
// and write nothing either, so the log alone cannot tell the two apart.
vi.mock("../observation-writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../observation-writer.js")>();
  return { ...actual, writeObservation: vi.fn(actual.writeObservation) };
});

const FEYNMAN = { kind: "genius" as const, name: "feynman" as const };
const CURIE = { kind: "genius" as const, name: "curie" as const };

// Two judges on one claim the consensus failed: feynman said FAIL, curie PASS.
function queued(): PipelineState {
  return {
    ...newPipelineState({ run_id: "drain-run", feature_description: "f", skip_preflight: true }),
    reliability_observations: [
      { claim_id: "FR-001", judge: FEYNMAN, claim_type: "fr_traceability", ground_truth_is_fail: true, judge_was_correct: true },
      { claim_id: "FR-001", judge: CURIE, claim_type: "fr_traceability", ground_truth_is_fail: true, judge_was_correct: false },
    ],
  };
}

async function logged(): Promise<ReturnType<typeof vi.fn>> {
  const { appendObservationLog } = await import("@prd-gen/benchmark");
  return appendObservationLog as ReturnType<typeof vi.fn>;
}

describe("drainReliabilityObservations (#121)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("empties the queue and writes nothing when the server has no reliability repository", async () => {
    const state = queued();
    const drained = drainReliabilityObservations(state, null);
    expect(drained.reliability_observations).toEqual([]);
    expect({ ...drained, reliability_observations: state.reliability_observations }).toEqual(state);
    // The writer is not started, so there is nothing to wait for.
    expect(vi.mocked(writeObservation).mock.calls).toEqual([]);
    expect((await logged()).mock.calls).toEqual([]);
  });

  it("hands each queued observation once to the repository, then to the log under the run id, and empties the queue", async () => {
    const recordObservation = vi.fn();
    const state = queued();
    const drained = drainReliabilityObservations(state, { recordObservation });

    expect(drained.reliability_observations).toEqual([]);
    expect(vi.mocked(writeObservation).mock.calls).toHaveLength(2);
    // The state given is not changed: the reducer's states are values.
    expect(state.reliability_observations).toHaveLength(2);
    // The repository write is done when the drain returns.
    expect(recordObservation.mock.calls).toEqual([
      [FEYNMAN, "fr_traceability", { groundTruthIsFail: true, judgeWasCorrect: true }],
      [CURIE, "fr_traceability", { groundTruthIsFail: true, judgeWasCorrect: false }],
    ]);

    const log = await logged();
    await vi.waitUntil(() => log.mock.calls.length >= 2, { timeout: 3000 });
    expect(log.mock.calls.map((call) => call[1])).toEqual([OBSERVATION_LOG_PATH, OBSERVATION_LOG_PATH]);
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ run_id: "drain-run", claim_id: "FR-001", judge_id: FEYNMAN, judge_verdict: false, ground_truth: true }),
      expect.objectContaining({ run_id: "drain-run", claim_id: "FR-001", judge_id: CURIE, judge_verdict: true, ground_truth: true }),
    ]);
  });

  it("returns the state it was given when the queue is empty", () => {
    const state = newPipelineState({ run_id: "empty", feature_description: "f", skip_preflight: true });
    expect(drainReliabilityObservations(state, { recordObservation: vi.fn() })).toEqual(state);
  });
});
