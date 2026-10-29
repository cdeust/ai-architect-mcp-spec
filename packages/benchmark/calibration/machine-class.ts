/**
 * Machine-class detection + per-bucket gate lookup for Phase 4.5.
 *
 * Phase 4.5 calibrates `wall_time_ms` against the canned-baseline pipeline
 * (`makeCannedDispatcher`) at the frozen baseline of Wave B. Because
 * canned-pipeline wall-time is dominated by JS execution speed (no LLM,
 * no I/O), it is sensitive to host-machine class. A single global gate is
 * either too tight on a slow CI runner or too loose on a fast workstation.
 *
 * This module:
 *   1. Buckets the host into one of MACHINE_CLASSES from `os.cpus()` +
 *      `os.totalmem()`. Heuristic, deterministic, no shelling out.
 *   2. Looks up the per-bucket calibrated `wall_time_ms` gate value, falling
 *      back to a single provisional value when no per-bucket calibration
 *      data exists.
 *
 * Layer contract (§2.2): imports from Node stdlib only. No
 * @prd-gen/core / @prd-gen/orchestration imports — this is a leaf utility
 * consumed by `pipeline-kpis.ts` (which is already in the calibration
 * import perimeter via `instrumentation.ts`).
 *
 * source: docs/PHASE_4_PLAN.md §4.5 — per-machine-class wall_time_ms gate.
 * source: C3 deliverable, Phase 4 Wave C.
 */

import { cpus, totalmem } from "node:os";

/**
 * Machine-class buckets, ordered roughly fastest → slowest. The five-bucket
 * partition is intentionally coarse: the goal is to keep the canned-baseline
 * P95 within ±20% across hosts in the same bucket, NOT to micro-classify.
 *
 * source: §4.5 frozen-baseline definition; canned-dispatcher wall-time is
 *   sensitive to single-thread CPU speed and memory bandwidth, not core
 *   count or NUMA topology.
 */
export const MACHINE_CLASSES = [
  "m_series_high", // Apple M-series, ≥32 GB RAM (Pro/Max/Ultra workstation tier)
  "m_series_mid", // Apple M-series, <32 GB RAM (Air, base Pro)
  "x86_intel", // Intel x86_64
  "x86_amd", // AMD x86_64
  "ci_runner", // Conservative fallback / CI environment / unrecognised
] as const;

export type MachineClass = (typeof MACHINE_CLASSES)[number];

/**
 * Heuristic-based detection. The CPU model string is provided by the OS
 * (Darwin/Linux/Windows) and is the only easily-portable signal short of
 * shelling out to sysctl/lscpu. The classification is intentionally
 * generous: a misclassification falls back one bucket toward `ci_runner`,
 * which has the loosest gate and is therefore safe.
 *
 * Precondition: none.
 * Postcondition: returns one of MACHINE_CLASSES; never throws.
 *
 * source: empirical CPU-model strings observed on:
 *   - Apple M2 Pro / M3 Max workstations: "Apple M2 Pro" / "Apple M3 Max"
 *   - Apple M1 Air: "Apple M1"
 *   - GitHub Actions x86_64 runners: "Intel(R) Xeon(R) CPU ..." / "AMD EPYC..."
 *   - Local Intel desktop: "Intel(R) Core(TM) i7-..."
 */
export function detectMachineClass(): MachineClass {
  const cpuList = cpus();
  if (!cpuList || cpuList.length === 0) return "ci_runner";
  const model = cpuList[0]?.model ?? "";
  const memBytes = totalmem();
  const memGB = memBytes / (1024 * 1024 * 1024);

  // Apple M-series. Heuristic: model string starts with "Apple M".
  if (/^Apple M/.test(model)) {
    // 32 GB threshold separates workstation Pro/Max/Ultra from base/Air tier.
    return memGB >= 32 ? "m_series_high" : "m_series_mid";
  }
  // Intel x86 — broad pattern covers Core, Xeon, Pentium, Celeron, etc.
  if (/Intel\b/i.test(model)) return "x86_intel";
  // AMD x86 — covers EPYC, Ryzen, Threadripper.
  if (/AMD\b/i.test(model)) return "x86_amd";
  // Unknown architecture or virtualised CPU model (some CI providers strip
  // the model string). Conservative fallback.
  return "ci_runner";
}

/**
 * Calibrated per-bucket gate values, populated by Phase 4.5 calibration runs
 * (K≥100 per bucket against the frozen canned baseline). Until calibration
 * data exists, every bucket maps to `null`, and `getWallTimeMsGateForMachine`
 * returns the provisional fallback.
 *
 * Each non-null value MUST be accompanied by:
 *   1. A `// source: benchmark <script>, run <date>, N=<count>` comment.
 *   2. The committed JSONL data under `data/` (CC-2).
 *   3. An XmR control-chart record under
 *      `data/wall-time-ms.<bucket>.xmr.json` (CC-4).
 *
 * Per docs/PHASE_4_PLAN.md §4.5 "Tampering safeguard": these values may
 * only change when the corresponding XmR chart shows a sustained shift
 * (run of 8 on one side of mean) OR a pre-registered re-calibration cycle.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 — per-machine-class wall_time_ms gate.
 */
export const WALL_TIME_MS_GATE_BY_CLASS: Readonly<
  Record<MachineClass, number | null>
> = {
  m_series_high: null,
  m_series_mid: null,
  x86_intel: null,
  x86_amd: null,
  ci_runner: null,
};

/**
 * Provisional fallback used when no per-bucket calibration data exists.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 — keeps the same provisional value as
 *   `KPI_GATES.wall_time_ms_max` (500ms) so a missing calibration row does
 *   not silently change behaviour. Matches the value in
 *   `pipeline-kpis.ts::KPI_GATES.wall_time_ms_max`. If that constant moves
 *   without this one moving, the unit test `gate-tuning-regression.test.ts`
 *   will catch the drift.
 */
export const WALL_TIME_MS_GATE_FALLBACK = 500;

/**
 * Look up the per-machine-class wall_time_ms gate value.
 *
 * Returns the calibrated bucket value when present; otherwise the
 * provisional fallback. The detection step is run on every call so the
 * function is also valid in test environments that mutate `os.cpus()` /
 * `os.totalmem()` (e.g., when running per-bucket calibration synthetically).
 *
 * Precondition: none.
 * Postcondition: returns a positive finite number.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 — per-machine-class gate seam.
 */
export function getWallTimeMsGateForMachine(): number {
  const klass = detectMachineClass();
  const calibrated = WALL_TIME_MS_GATE_BY_CLASS[klass];
  return calibrated ?? WALL_TIME_MS_GATE_FALLBACK;
}

// ─── Gate-blocked-run log (Curie R6 / Phase 4.5 censoring mitigation) ────────

/**
 * Path to the JSONL log of every gate violation observed in a benchmark run.
 *
 * docs/PHASE_4_PLAN.md §4.5 "Censoring mitigation" requires a separate log
 * of blocked-run KPIs even when those runs do not complete the pipeline,
 * so threshold drift can be audited without re-running calibration.
 *
 * Gitignored alongside the other calibration data sinks (judge observation
 * log, dropped claims). Reuses the calibration-seams pattern of
 * append-only JSONL with explicit `schema_version`.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 censoring-mitigation requirement.
 */
export const GATE_BLOCKED_LOG_PATH =
  "packages/benchmark/calibration/data/gate-blocked-log.jsonl";

/**
 * One entry in the gate-blocked log. One JSONL line per (run_id, gate_name)
 * pair — a single run with multiple violations produces multiple lines so
 * each gate's distribution can be analysed independently.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 censoring-mitigation schema.
 */
export interface GateBlockedLogEntry {
  readonly run_id: string;
  readonly gate_name: string;
  readonly observed: number | boolean;
  readonly threshold: number | boolean;
  readonly machine_class: MachineClass;
  readonly timestamp: string; // ISO-8601 UTC
  readonly schema_version: 1;
}
