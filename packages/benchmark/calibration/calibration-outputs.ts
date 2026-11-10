/**
 * Phase 4.5 + 4.2 calibration-output JSON schemas (Wave D / D3.3).
 *
 * Two artefacts produced by `calibrate-gates.ts`:
 *
 *   1. `gate-calibration-K100.json` — per-gate calibrated values + XmR record
 *      reference. Output of the K≥100 calibration runs against the frozen
 *      canned baseline. Loaded by `pipeline-kpis.ts::loadCalibratedGates`.
 *
 *   2. `event-rate-K50.json` — measured first-attempt fail rate from K=50
 *      baseline runs. Feeds the §4.2 Schoenfeld N recompute decision (if the
 *      observed event_rate diverges from the provisional 0.30 anchor by
 *      more than ±0.05 absolute, N must be recomputed).
 *
 * Both schemas carry:
 *   - `schema_version: 1` — bump when the field set changes.
 *   - `commit_hash`      — git HEAD at the moment the runner produced this.
 *   - `seed_used`        — pre-registered RNG seed (4.5 = 0x4_05_C3, 4.2 = 50).
 *   - `timestamp`        — ISO-8601 UTC when the artefact was written.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 Implementation gates / §4.2 event_rate hedge.
 * source: D3.3 brief — Wave D calibration outputs.
 *
 * Layer contract (§2.2): zod + Node stdlib only. Pure schema/types module —
 * no I/O outside the explicit `read*` / `write*` helpers below.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// ─── Output paths (canonical) ────────────────────────────────────────────────

/**
 * Canonical path to the K≥100 calibration output JSON.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 — "packages/benchmark/calibration/data/
 *   gate-calibration-K100.json".
 */
export const GATE_CALIBRATION_K100_PATH =
  "packages/benchmark/calibration/data/gate-calibration-K100.json";

/**
 * Canonical directory for per-gate XmR chart JSONs.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 — "packages/benchmark/calibration/data/
 *   gate-calibration-K100.xmr/<gate>.json".
 */
export const GATE_CALIBRATION_XMR_DIR =
  "packages/benchmark/calibration/data/gate-calibration-K100.xmr";

/**
 * Canonical path to the K=50 event-rate measurement output.
 *
 * source: docs/PHASE_4_PLAN.md §4.2 event_rate hedge — D3.2 brief.
 */
export const EVENT_RATE_K50_PATH =
  "packages/benchmark/calibration/data/event-rate-K50.json";

// ─── XmR-record sub-schema ───────────────────────────────────────────────────

/**
 * One XmR record persisted alongside the gate-calibration JSON. Matches the
 * `xmr.ts::XmRReport` shape (limits + signals) plus the per-batch series for
 * downstream consumption.
 *
 * source: xmr.ts — XmRLimits + XmRReport types.
 */
export const XmRRecordSchema = z.object({
  centerline: z.number(),
  upperControlLimit: z.number(),
  lowerControlLimit: z.number(),
  meanMovingRange: z.number(),
  basePoints: z.number().int().positive(),
  signals: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      value: z.number(),
      rule: z.enum(["outside_3sigma", "run_of_8"]),
    }),
  ),
  inControl: z.boolean(),
  /** The full series the chart was scanned over (per-batch means). */
  series: z.array(z.number()),
});

export type XmRRecord = z.infer<typeof XmRRecordSchema>;

// ─── Per-gate calibration entry ──────────────────────────────────────────────

/**
 * One row in the gate-calibration output, per gate.
 *
 * `gate_name` matches a key of `KPI_GATES` (or the per-bucket sub-key for
 * `wall_time_ms_max`, encoded as `wall_time_ms_max:<machine_class>`). The
 * machine-class qualifier is only present for `wall_time_ms_max`; all other
 * gates are global.
 *
 * `provisional` is the value currently shipped in `KPI_GATES`. `calibrated`
 * is the K≥100-derived value (P95 or 3σ UCL per the gate's estimand type
 * in the §4.5 per-gate table). `would_tighten` is `calibrated < provisional`,
 * `would_loosen` the opposite — surfaced explicitly so a reviewer doesn't
 * have to recompute.
 *
 * `ci_upper` is the 95% Clopper-Pearson upper bound on the order statistic
 * (P95-type gates) or the same UCL repeated (XmR-type gates). Provided so
 * a downstream consumer can reason about confidence in the calibration.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 PRE-REGISTRATION — Estimand + Estimator.
 */
export const GateCalibrationEntrySchema = z.object({
  gate_name: z.string().min(1),
  estimand_type: z.enum(["p95", "xmr_3sigma_ucl"]),
  k_observed: z.number().int().positive(),
  provisional: z.number(),
  calibrated: z.number(),
  ci_upper: z.number().nullable(),
  ci_lower: z.number().nullable(),
  would_tighten: z.boolean(),
  would_loosen: z.boolean(),
  passes_threshold: z.boolean(),
  /** Optional XmR record path under GATE_CALIBRATION_XMR_DIR. */
  xmr_path: z.string().nullable(),
  machine_class: z.string().nullable(),
  /**
   * Wave E override: when true, block automatic promotion of this gate even
   * if passes_threshold=true. Used for wall_time_ms_max (canned-dispatcher
   * calibration only; requires per-machine-class non-canned runs).
   *
   * source: PHASE_4_PLAN.md §4.5 wall_time_ms_max disposition (Wave E, option b).
   */
  hold_provisional: z.boolean().optional(),
  hold_provisional_reason: z.string().optional(),
});

export type GateCalibrationEntry = z.infer<typeof GateCalibrationEntrySchema>;

// ─── Top-level GateCalibrationK100 ───────────────────────────────────────────

/**
 * Schema for `gate-calibration-K100.json`.
 *
 * Empty `gates: []` is the unsealed-template state — the committed stub.
 * `loadCalibratedGates()` returns null when `gates.length === 0`.
 *
 * `frozen_baseline_commit` is the HEAD sha recorded as provenance when the
 * canned dispatcher's behaviour was measured (`frozen-baseline.ts`); nothing
 * is refused because of it. The runner's only pre-flight check compares the
 * SHA-256 of the `pipeline-kpis.ts` being measured with the stored
 * `frozen_baseline_content_hash` of a sealed artefact — see §4.5
 * Frozen-baseline definition.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 PRE-REGISTRATION → Frozen-baseline.
 * source: D3.3 brief — schema_version + commit_hash + seed_used + timestamp.
 */
export const GateCalibrationK100Schema = z.object({
  schema_version: z.literal(1),
  commit_hash: z.string().min(1),
  seed_used: z.number().int().nonnegative(),
  timestamp: z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), {
    message: "timestamp must be a valid ISO-8601 string",
  }),
  k_target: z.number().int().positive(),
  k_achieved: z.number().int().nonnegative(),
  frozen_baseline_commit: z.string().min(1),
  frozen_baseline_content_hash: z.string().min(1),
  gates: z.array(GateCalibrationEntrySchema),
});

export type GateCalibrationK100 = z.infer<typeof GateCalibrationK100Schema>;

// ─── EventRateK50 ────────────────────────────────────────────────────────────

/**
 * Schema for `event-rate-K50.json` — the §4.2 first-attempt fail rate.
 *
 * `measured_event_rate` = (failed_pending_retry events) / (section, attempt)
 * pairs across K=50 runs. Compared to the provisional anchor 0.30; if
 * `Math.abs(measured - 0.30) > 0.05`, the runner emits a Schoenfeld-recompute
 * warning.
 *
 * source: docs/PHASE_4_PLAN.md §4.2 event_rate=0.30 PROVISIONAL anchor hedge.
 */
export const EventRateK50Schema = z.object({
  schema_version: z.literal(1),
  commit_hash: z.string().min(1),
  seed_used: z.number().int().nonnegative(),
  timestamp: z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), {
    message: "timestamp must be a valid ISO-8601 string",
  }),
  k_target: z.number().int().positive(),
  k_observed: z.number().int().nonnegative(),
  total_attempts: z.number().int().nonnegative(),
  total_events: z.number().int().nonnegative(),
  measured_event_rate: z.number().min(0).max(1),
  ci95_clopper_pearson: z.object({
    lower: z.number().min(0).max(1),
    upper: z.number().min(0).max(1),
  }),
  provisional_anchor: z.number().min(0).max(1),
  diverges_beyond_tolerance: z.boolean(),
  recompute_recommended: z.boolean(),
});

export type EventRateK50 = z.infer<typeof EventRateK50Schema>;

// ─── Read / write helpers (pure I/O; no business logic) ──────────────────────

/**
 * Read + validate a `gate-calibration-K100.json` artefact.
 *
 * Precondition: `path` points to a JSON file matching GateCalibrationK100Schema.
 * Postcondition: returns the parsed object on success.
 * Throws Error with a descriptive message on missing-file / parse-error / schema
 *   violation — the loader in `pipeline-kpis.ts` catches and returns `null`
 *   rather than propagating, so a missing/invalid file silently keeps the
 *   provisional defaults active.
 *
 * source: D3.5 brief — `loadCalibratedGates` returns null on error.
 */
export function readGateCalibrationK100(
  path: string = GATE_CALIBRATION_K100_PATH,
): GateCalibrationK100 {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const parsed = GateCalibrationK100Schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `readGateCalibrationK100: schema mismatch at "${path}":\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("\n"),
    );
  }
  return parsed.data;
}

/** Write + validate a gate-calibration artefact (overwrites in place). */
export function writeGateCalibrationK100(
  artefact: GateCalibrationK100,
  path: string = GATE_CALIBRATION_K100_PATH,
): void {
  const parsed = GateCalibrationK100Schema.safeParse(artefact);
  if (!parsed.success) {
    throw new Error(
      `writeGateCalibrationK100: artefact failed schema validation:\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("\n"),
    );
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(parsed.data, null, 2) + "\n", "utf8");
}

/** Read + validate the K=50 event-rate artefact. */
export function readEventRateK50(
  path: string = EVENT_RATE_K50_PATH,
): EventRateK50 {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const parsed = EventRateK50Schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `readEventRateK50: schema mismatch at "${path}":\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("\n"),
    );
  }
  return parsed.data;
}

/** Write + validate the event-rate artefact. */
export function writeEventRateK50(
  artefact: EventRateK50,
  path: string = EVENT_RATE_K50_PATH,
): void {
  const parsed = EventRateK50Schema.safeParse(artefact);
  if (!parsed.success) {
    throw new Error(
      `writeEventRateK50: artefact failed schema validation:\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("\n"),
    );
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(parsed.data, null, 2) + "\n", "utf8");
}
