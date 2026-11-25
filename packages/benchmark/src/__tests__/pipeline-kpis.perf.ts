/**
 * Wall-time gate of the canned pipeline run, measured alone.
 *
 * `wall_time_ms` is elapsed time, so inside the parallel `pnpm test` run it
 * measures the scheduler: the run below took 39 to 67 ms in an idle process
 * and up to 932 ms with 12 busy loops on 4 cores, against a 500 ms gate
 * (measured 2026-11-11, 10 and 30 cold processes). It runs here, under
 * `pnpm test:perf` (one worker, no file parallelism; see
 * vitest.perf.config.ts), and `pipeline-kpis.test.ts` judges every other
 * KPI of the same run.
 */

import { describe, expect, it } from "vitest";
import { KPI_GATES, evaluateGates, measurePipeline } from "../pipeline-kpis.js";

/**
 * Fastest of the observed wall times. Machine load only ever ADDS time to a run
 * (the 932 ms above against 39 to 67 ms idle), so the fastest run is the one
 * least perturbed by anything but the pipeline itself. A pipeline that is slow
 * in every run is still slow in the fastest one, which is what the gate judges.
 */
export function fastestWallTime(wallTimes: readonly number[]): number {
  return Math.min(...wallTimes);
}

// source: heuristic provisional; seven runs of about 50 ms each keep the file near a second idle.
const RUNS = 7;

const INPUT = {
  run_id: "kpi_trial_codebase_wall_time",
  feature_description: "build a feature for OAuth login",
  codebase_path: "/tmp/benchmark",
};

describe("pipeline KPIs: wall time", () => {
  it("the trial+codebase canned run meets every gate, wall time included", () => {
    measurePipeline(INPUT); // warm-up: the first run pays the cold TypeScript transform
    const runs = Array.from({ length: RUNS }, () => measurePipeline(INPUT));
    const kpis = { ...runs[0]!, wall_time_ms: fastestWallTime(runs.map(run => run.wall_time_ms)) };

    expect(kpis.final_action_kind).toBe("done");
    expect(kpis.wall_time_ms).toBeLessThan(KPI_GATES.wall_time_ms_max);
    const gates = evaluateGates(kpis, true);
    expect(gates.violations).toEqual([]);
    expect(gates.passed).toBe(true);
  });

  // Positive controls: taking the fastest run must not make the gate blind.
  it("ignores a run slowed by load but not a pipeline that is slow every time", () => {
    expect(fastestWallTime([932, 41, 600])).toBe(41);
    expect(fastestWallTime([600, 700, 650])).toBeGreaterThanOrEqual(KPI_GATES.wall_time_ms_max);
  });

  it("fails the gate for a canned run over the wall time limit", () => {
    const slow = { ...measurePipeline(INPUT), wall_time_ms: KPI_GATES.wall_time_ms_max + 1 };
    const gates = evaluateGates(slow, true);
    expect(gates.passed).toBe(false);
    expect(gates.violations.map(violation => violation.metric)).toEqual(["wall_time_ms_max"]);
  });
});
