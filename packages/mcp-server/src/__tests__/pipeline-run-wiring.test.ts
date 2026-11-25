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

it("builds a run id from the base-36 clock and the first six base-36 digits of the random fraction", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  vi.spyOn(Math, "random").mockReturnValue(0.123456789);
  const { generateRunId } = await import("../pipeline-runs.js");
  expect(generateRunId()).toBe("run_loyw3v28_4fzzzx");
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
