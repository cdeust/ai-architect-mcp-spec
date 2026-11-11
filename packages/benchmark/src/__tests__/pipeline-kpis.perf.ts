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

describe("pipeline KPIs: wall time", () => {
  it("the trial+codebase canned run meets every gate, wall time included", () => {
    const kpis = measurePipeline({
      run_id: "kpi_trial_codebase_wall_time",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/benchmark",
    });

    expect(kpis.final_action_kind).toBe("done");
    expect(kpis.wall_time_ms).toBeLessThan(KPI_GATES.wall_time_ms_max);
    const gates = evaluateGates(kpis, true);
    expect(gates.violations).toEqual([]);
    expect(gates.passed).toBe(true);
  });
});
