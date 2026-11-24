import { getRetryArmForRun, MAX_ATTEMPTS_BASELINE } from "@prd-gen/benchmark";
import { newPipelineState, RUN_STORE_TTL_MS } from "@prd-gen/orchestration";
import { afterEach, expect, it, vi } from "vitest";
import type { KeptRunsOptions } from "../kept-runs.js";
import type { RunFiles } from "../run-files.js";
import { withRetryPolicy } from "../retry-policy-wiring.js";

const evidence = vi.hoisted(() => ({
  repository: vi.fn(),
  onDrop: undefined as KeptRunsOptions["onDrop"],
}));

vi.mock("../evidence-db-path.js", () => ({ getEvidenceRepo: evidence.repository }));

vi.mock("../kept-runs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../kept-runs.js")>();
  return {
    ...actual,
    KeptRuns: class extends actual.KeptRuns {
      constructor(files: RunFiles, options: KeptRunsOptions) {
        super(files, options);
        evidence.onDrop = options.onDrop;
      }
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("releases the evidence for an expired completed run and tolerates an absent repository", async () => {
  const run_id = "run_finished_for_prune";
  const pruneRunEvidence = vi.fn();
  evidence.repository.mockReturnValue({ pruneRunEvidence });
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { runs } = await import("../pipeline-runs.js");
  const finished = newPipelineState({ run_id, feature_description: "Keep a receipt" });
  runs.keep({ ...finished, current_step: "complete" }, { kind: "done", summary: "Saved", artifacts: [] });
  expect(pruneRunEvidence).not.toHaveBeenCalled();

  now += RUN_STORE_TTL_MS;
  expect(runs.find(run_id)).toEqual({ kind: "unknown" });
  expect(pruneRunEvidence).toHaveBeenCalledExactlyOnceWith(run_id);

  evidence.repository.mockReturnValue(null);
  expect(evidence.onDrop).toBeTypeOf("function");
  expect(() => evidence.onDrop!(run_id)).not.toThrow();
});

it("uses a time component and a six-character random suffix for a typical generated run id", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.123456);
  const { generateRunId } = await import("../pipeline-runs.js");
  expect(generateRunId()).toMatch(/^run_[a-z0-9]+_[a-z0-9]{6}$/);
});

it("assigns the baseline retry budget and the run's benchmark arm", () => {
  const state = newPipelineState({ run_id: "run_retry_defaults", feature_description: "Keep a receipt" });
  expect(withRetryPolicy(state)).toEqual({
    ...state,
    retry_policy: { maxAttempts: MAX_ATTEMPTS_BASELINE, arm: getRetryArmForRun(state.run_id) },
  });
  expect(state.retry_policy).toBeNull();
});

it("keeps an already configured retry budget and arm", () => {
  const state = newPipelineState({ run_id: "run_retry_resume", feature_description: "Keep a receipt" });
  const resumed = { ...state, retry_policy: { maxAttempts: 12, arm: "without_prior_violations" as const } };
  expect(withRetryPolicy(resumed)).toBe(resumed);
});
