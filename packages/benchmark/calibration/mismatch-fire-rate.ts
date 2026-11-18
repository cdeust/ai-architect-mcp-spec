/**
 * Phase 4.3 — Plan-mismatch fire-rate calibration analysis script.
 *
 * Procedure (matches the pre-registration block in
 * docs/PHASE_4_PLAN.md §4.3):
 *
 *   1. Read JSONL run records from
 *      packages/benchmark/calibration/data/mismatch-fire-rate.*.jsonl.
 *      Each row has shape:
 *        {
 *          "run_id": string,
 *          "prd_context": one of the 8 PRDContext values,
 *          "mismatch_fired": boolean,
 *          "mismatch_kinds": MismatchKind[]
 *        }
 *      Rows are produced by the calibration runner (separate, not committed
 *      yet — see "Remaining gaps" in the calibration README).
 *
 *   2. Compute overall and per-kind fire counts. Exact 95% Clopper-Pearson
 *      CI for each.
 *
 *   3. Stratify by prd_context; report per-cell counts. Verify each cell
 *      meets the floor of K/8 runs.
 *
 *   4. Build XmR control chart on per-batch fire rate (n=20 runs/batch).
 *      Lock limits on the first 12 batches, scan the full series.
 *
 *   5. Apply pre-registered decision rule:
 *        - upper CI < 0.01 ⇒ "fallback path demonstrably unreached"
 *        - fire_count ≥ 1 ⇒ "investigate root cause"
 *
 * Measurement-only: this script does not modify any pipeline state, does
 * not call MCP tools, and does not write to the EvidenceRepository.
 *
 * source: PHASE_4_PLAN.md §4.3 (Phase 3+4 cross-audit, 2026-04).
 *         Pre-registered before any data row is collected.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  clopperPearson,
  type ClopperPearsonInterval,
} from "./clopper-pearson.js";
import { xmrAnalyze, type XmRReport } from "./xmr.js";
import {
  extractMismatchEvents,
  MISMATCH_KINDS,
  MISMATCH_DIAGNOSTIC_PREFIX,
  type MismatchKind,
} from "../src/instrumentation.js";

// source: PHASE_4_PLAN.md §4.3 RNG-seed pre-registration. Constant must not
// change after first data collection — assertion below enforces this.
export const PRE_REGISTERED_SEED = 0xc0ffee0403;

// source: PHASE_4_PLAN.md §4.3 stratification. Round-robin over
// PRDContextSchema (packages/core/src/domain/prd-context.ts).
export const PRD_CONTEXT_DOMAIN = [
  "proposal",
  "feature",
  "bug",
  "incident",
  "poc",
  "mvp",
  "release",
  "cicd",
] as const;

// source: PHASE_4_PLAN.md §4.3 sample-size calculation. K=460 ⇒ upper bound
// at 0 fires ≈ 0.80% (clears the 1% H0 ceiling).
export const PRIMARY_K = 460;
// source: PHASE_4_PLAN.md §4.3 — fallback sample size when fire_count ∈ {1, 2}
// on the K=460 primary run. K=3,000 ⇒ CP-95 upper bound at 0 fires ≈ 0.12%
// (provides finer resolution for the underpowered regime). The FIRE_RATE_CEILING
// threshold (1%) still applies on the fallback dataset; the same
// Clopper-Pearson upper-bound test governs the decision rule.
export const FALLBACK_K = 3_000;
// source: PHASE_4_PLAN.md §4.3 stratification floor.
export const PER_CONTEXT_FLOOR = Math.ceil(PRIMARY_K / PRD_CONTEXT_DOMAIN.length);
// source: PHASE_4_PLAN.md §4.3 CC-4 control chart spec.
export const XMR_BATCH_SIZE = 20;
export const XMR_BASELINE_BATCHES = 12;
// source: PHASE_4_PLAN.md §4.3 pre-registered H0 ceiling.
export const FIRE_RATE_CEILING = 0.01;

// ─── Pre-flight injection check (AP-5 negative falsifier) ─────────────────────

/**
 * Run ONE synthetic injection round-trip BEFORE consuming any real dataset.
 *
 * Pre-condition: called with a known-good mismatch_kind string.
 * Post-condition: throws with a human-readable abort message if
 *   `extractMismatchEvents` returns 0 events for the injection — which
 *   indicates the MISMATCH_DIAGNOSTIC_PREFIX in instrumentation.ts has
 *   drifted away from the injected string, making the instrumentation
 *   untrustworthy.
 *
 * Invariant: the real dataset is NEVER consumed if this check fails.
 *
 * source: Curie A3 / Popper AP-5 / Phase 3+4 cross-audit (2026-04).
 *         Pre-registration in docs/PHASE_4_PLAN.md §4.3 "Step 0 pre-flight".
 */
export function runPreflightInjectionCheck(): void {
  // Use the first known kind as the synthetic payload.
  const syntheticKind = MISMATCH_KINDS[0];
  const syntheticError = `${MISMATCH_DIAGNOSTIC_PREFIX}${syntheticKind}`;
  const result = extractMismatchEvents({ errors: [syntheticError] });
  if (result.events.length === 0) {
    throw new Error(
      "[mismatch-fire-rate] ABORT: instrumentation pre-flight injection check FAILED. " +
        `Injected '${syntheticError}' but extractMismatchEvents returned 0 events. ` +
        "MISMATCH_DIAGNOSTIC_PREFIX may have drifted in instrumentation.ts. " +
        "Real dataset NOT consumed; no decision emitted. " +
        "Fix: ensure the prefix in instrumentation.ts matches the string emitted by " +
        "handleSelfCheckPhaseB in packages/orchestration/src/handlers/self-check.ts.",
    );
  }
}

export interface CalibrationRun {
  readonly run_id: string;
  readonly prd_context: (typeof PRD_CONTEXT_DOMAIN)[number];
  readonly mismatch_fired: boolean;
  readonly mismatch_kinds: ReadonlyArray<MismatchKind>;
}

export interface PerContextStats {
  readonly context: (typeof PRD_CONTEXT_DOMAIN)[number];
  readonly trials: number;
  readonly fires: number;
  readonly meetsFloor: boolean;
}

export interface FireRateReport {
  readonly trials: number;
  readonly fires: number;
  readonly overallCI: ClopperPearsonInterval;
  readonly perKindCI: Record<MismatchKind, ClopperPearsonInterval>;
  readonly perContext: ReadonlyArray<PerContextStats>;
  readonly xmr: XmRReport | null;
  readonly decision:
    | "fallback_unreached_delete_candidate"
    | "investigate_root_cause"
    | "underpowered"
    | "underpowered_run_fallback_K3000";
  readonly decisionRationale: string;
  /**
   * When decision === "underpowered_run_fallback_K3000", contains the
   * Clopper-Pearson upper bound that would result from 0 fires in K=3,000.
   * Provided so the caller can display the expected resolution before
   * committing to the fallback run.
   *
   * source: PHASE_4_PLAN.md §4.3 fallback sample size (Popper AP-2, 2026-04).
   */
  readonly fallbackK3000UpperBound?: number;
}

function loadDataset(dataDir: string): ReadonlyArray<CalibrationRun> {
  if (!existsSync(dataDir)) return [];
  const files = readdirSync(dataDir).filter(
    (f) => f.startsWith("mismatch-fire-rate.") && f.endsWith(".jsonl"),
  );
  const out: CalibrationRun[] = [];
  for (const f of files) {
    const text = readFileSync(join(dataDir, f), "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = JSON.parse(trimmed) as CalibrationRun;
      out.push(row);
    }
  }
  return out;
}

function computePerContext(
  runs: ReadonlyArray<CalibrationRun>,
): PerContextStats[] {
  const buckets = new Map<
    (typeof PRD_CONTEXT_DOMAIN)[number],
    { trials: number; fires: number }
  >();
  for (const ctx of PRD_CONTEXT_DOMAIN) {
    buckets.set(ctx, { trials: 0, fires: 0 });
  }
  for (const r of runs) {
    const b = buckets.get(r.prd_context);
    if (!b) continue;
    b.trials += 1;
    if (r.mismatch_fired) b.fires += 1;
  }
  return PRD_CONTEXT_DOMAIN.map((ctx) => {
    const b = buckets.get(ctx)!;
    return {
      context: ctx,
      trials: b.trials,
      fires: b.fires,
      meetsFloor: b.trials >= PER_CONTEXT_FLOOR,
    };
  });
}

function computePerKind(
  runs: ReadonlyArray<CalibrationRun>,
): Record<MismatchKind, ClopperPearsonInterval> {
  const trials = runs.length;
  const out = {} as Record<MismatchKind, ClopperPearsonInterval>;
  for (const k of MISMATCH_KINDS) {
    const fires = runs.filter((r) => r.mismatch_kinds.includes(k)).length;
    out[k] = clopperPearson(fires, Math.max(trials, 1));
  }
  return out;
}

function computeBatchedFireRates(
  runs: ReadonlyArray<CalibrationRun>,
): number[] {
  const rates: number[] = [];
  for (let i = 0; i + XMR_BATCH_SIZE <= runs.length; i += XMR_BATCH_SIZE) {
    const slice = runs.slice(i, i + XMR_BATCH_SIZE);
    const fires = slice.filter((r) => r.mismatch_fired).length;
    rates.push(fires / XMR_BATCH_SIZE);
  }
  return rates;
}

interface DecideResult {
  readonly decision: FireRateReport["decision"];
  readonly rationale: string;
  readonly fallbackK3000UpperBound?: number;
}

/**
 * Apply the pre-registered binary decision rule.
 *
 * Pre-condition: fires ≥ 0, trials ≥ 0, ci is a valid Clopper-Pearson
 *   interval for (fires, trials).
 * Post-condition: returns exactly one of the four pre-registered decision
 *   branches; rationale text includes the exact CI values so the report is
 *   self-contained.
 *
 * K=3,000 fallback branch (Popper AP-2 / PHASE_4_PLAN.md §4.3):
 *   fire_count ∈ {1, 2} on the K=460 primary run is an underpowered regime
 *   where the CP-95 upper bound (≈2–4%) sits above the 1% ceiling but the
 *   event count is too low to conclude "investigate_root_cause" with
 *   statistical confidence. The pre-registered response is to run a
 *   K=3,000 fallback dataset. The FIRE_RATE_CEILING (1%) and the same
 *   Clopper-Pearson upper-bound test apply identically on the fallback;
 *   no new decision logic is introduced.
 *
 * source: PHASE_4_PLAN.md §4.3 decision rule + stopping rule (2026-04).
 */
function decide(
  fires: number,
  ci: ClopperPearsonInterval,
  trials: number,
): DecideResult {
  // Primary dataset underpowered — fewer runs than pre-registered minimum.
  if (trials < PRIMARY_K) {
    return {
      decision: "underpowered",
      rationale: `K=${trials} < pre-registered minimum K=${PRIMARY_K}`,
    };
  }

  // H0 rejected: 0 fires and CI upper < 1%.
  if (fires === 0 && ci.upper < FIRE_RATE_CEILING) {
    return {
      decision: "fallback_unreached_delete_candidate",
      rationale: `0 fires in K=${trials}; CP-95 upper ${ci.upper.toFixed(4)} < ${FIRE_RATE_CEILING}`,
    };
  }

  // Underpowered regime on K=460: fire_count ∈ {1, 2}.
  // The CP upper bound sits above 1% but fires are too rare to conclude
  // root-cause. Pre-registered response: run the K=3,000 fallback dataset.
  // Compute the expected upper bound at 0 fires in K=FALLBACK_K so the
  // caller can confirm the fallback provides sufficient resolution.
  if (trials <= PRIMARY_K && (fires === 1 || fires === 2)) {
    const fallbackUpperBound = clopperPearson(0, FALLBACK_K).upper;
    return {
      decision: "underpowered_run_fallback_K3000",
      rationale:
        `fire_count=${fires} on K=${trials} is underpowered (CP-95 upper ${ci.upper.toFixed(4)} ≥ ${FIRE_RATE_CEILING}). ` +
        `Pre-registered response: run fallback K=${FALLBACK_K}. ` +
        `Expected CP-95 upper at 0 fires in K=${FALLBACK_K}: ${fallbackUpperBound.toFixed(4)}.`,
      fallbackK3000UpperBound: fallbackUpperBound,
    };
  }

  // fire_count ≥ 1 on primary K (not the 1–2 underpowered regime handled
  // above, i.e. fires ≥ 3, or fires ≥ 1 on the fallback K=3,000 dataset).
  // FIRE_RATE_CEILING and CP upper bound govern identically on both datasets.
  if (fires >= 1) {
    if (ci.upper < FIRE_RATE_CEILING) {
      // Fires observed but upper bound still clears the ceiling — possible
      // if running on the fallback K=3,000 with 1–2 fires.
      return {
        decision: "fallback_unreached_delete_candidate",
        rationale: `${fires} fires in K=${trials}; CP-95 upper ${ci.upper.toFixed(4)} < ${FIRE_RATE_CEILING}`,
      };
    }
    return {
      decision: "investigate_root_cause",
      rationale: `${fires} fires observed (K=${trials}); CP-95 upper ${ci.upper.toFixed(4)} ≥ ${FIRE_RATE_CEILING}. Root-cause analysis required before threshold change`,
    };
  }

  // 0 fires but CI upper ≥ 1% — can only occur if K is unusually small
  // relative to PRIMARY_K after the underpowered check above. Guard branch.
  return {
    decision: "underpowered",
    rationale: `0 fires but CP-95 upper ${ci.upper.toFixed(4)} ≥ ${FIRE_RATE_CEILING}`,
  };
}

export function analyze(
  runs: ReadonlyArray<CalibrationRun>,
): FireRateReport {
  const trials = runs.length;
  const fires = runs.filter((r) => r.mismatch_fired).length;
  const overallCI = clopperPearson(fires, Math.max(trials, 1));
  const perKindCI = computePerKind(runs);
  const perContext = computePerContext(runs);
  const batchedRates = computeBatchedFireRates(runs);
  const xmr =
    batchedRates.length >= XMR_BASELINE_BATCHES
      ? xmrAnalyze(batchedRates, XMR_BASELINE_BATCHES)
      : null;
  const { decision, rationale, fallbackK3000UpperBound } = decide(fires, overallCI, trials);
  return {
    trials,
    fires,
    overallCI,
    perKindCI,
    perContext,
    xmr,
    decision,
    decisionRationale: rationale,
    ...(fallbackK3000UpperBound !== undefined ? { fallbackK3000UpperBound } : {}),
  };
}

function formatPerKindBlock(
  perKindCI: Record<MismatchKind, ClopperPearsonInterval>,
): string[] {
  const lines = ["", "## Per mismatch_kind (CP-95)"];
  for (const k of MISMATCH_KINDS) {
    const ci = perKindCI[k];
    lines.push(
      `  ${k.padEnd(22)} fires=${ci.successes}/${ci.trials}  rate=${ci.pointEstimate.toFixed(4)}  upper=${ci.upper.toFixed(4)}`,
    );
  }
  return lines;
}

function formatStratificationBlock(
  perContext: ReadonlyArray<PerContextStats>,
): string[] {
  const lines = ["", "## Stratification (per prd_context)"];
  for (const c of perContext) {
    const flag = c.meetsFloor ? "OK" : `FLOOR-MISS (need ${PER_CONTEXT_FLOOR})`;
    lines.push(
      `  ${c.context.padEnd(10)} trials=${c.trials.toString().padStart(4)}  fires=${c.fires.toString().padStart(3)}  ${flag}`,
    );
  }
  return lines;
}

function formatXmrBlock(xmr: XmRReport | null): string[] {
  const lines = ["", "## XmR control chart"];
  if (!xmr) {
    lines.push(
      `  not yet computable — need ≥ ${XMR_BASELINE_BATCHES} batches of ${XMR_BATCH_SIZE} runs`,
    );
  } else {
    lines.push(
      `  centerline:           ${xmr.limits.centerline.toFixed(4)}`,
      `  UCL:                  ${xmr.limits.upperControlLimit.toFixed(4)}`,
      `  LCL:                  ${xmr.limits.lowerControlLimit.toFixed(4)}`,
      `  in-control:           ${xmr.inControl}`,
      `  signals:              ${xmr.signals.length}`,
    );
    for (const s of xmr.signals) {
      lines.push(
        `    batch[${s.index}] value=${s.value.toFixed(4)} rule=${s.rule}`,
      );
    }
  }
  return lines;
}

function formatReport(r: FireRateReport): string {
  const lines: string[] = [
    "# Plan-mismatch fire-rate (Phase 4.3) — analysis report",
    "",
    `K (trials):            ${r.trials}`,
    `Fires (any kind):      ${r.fires}`,
    `Overall fire rate:     ${r.overallCI.pointEstimate.toFixed(4)}`,
    `  CP-95 lower:         ${r.overallCI.lower.toFixed(4)}`,
    `  CP-95 upper:         ${r.overallCI.upper.toFixed(4)}`,
    `  H0 ceiling (p=${FIRE_RATE_CEILING}): ${r.overallCI.upper < FIRE_RATE_CEILING ? "REJECTED" : "NOT REJECTED"}`,
  ];

  lines.push(...formatPerKindBlock(r.perKindCI));
  lines.push(...formatStratificationBlock(r.perContext));
  lines.push(...formatXmrBlock(r.xmr));

  lines.push(
    "",
    "## Decision",
    `  outcome:    ${r.decision}`,
    `  rationale:  ${r.decisionRationale}`,
  );
  if (r.decision === "underpowered_run_fallback_K3000" && r.fallbackK3000UpperBound !== undefined) {
    lines.push(
      `  fallback K=${FALLBACK_K} expected upper bound (0 fires): ${r.fallbackK3000UpperBound.toFixed(4)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// CLI entry point — `node dist/calibration/mismatch-fire-rate.js [data-dir]`.
async function main(): Promise<void> {
  // Pre-registered seed assertion (Fisher Fi-A): if this constant has been
  // mutated between data collection and analysis, abort.
  if (PRE_REGISTERED_SEED !== 0xc0ffee0403) {
    throw new Error(
      "PRE_REGISTERED_SEED has been mutated post-registration — refuse to analyze.",
    );
  }
  // Step 0: pre-flight injection check — aborts before touching data if the
  // instrumentation prefix has drifted (AP-5 negative falsifier).
  runPreflightInjectionCheck();

  const dataDir =
    process.argv[2] ??
    join(
      process.cwd(),
      "packages/benchmark/calibration/data",
    );
  const runs = loadDataset(dataDir);
  if (runs.length === 0) {
    console.log(
      `[mismatch-fire-rate] no data rows found under ${dataDir}; ` +
        "run the calibration runner first.",
    );
    return;
  }
  const report = analyze(runs);
  console.log(formatReport(report));
}

if (
  process.argv[1]?.endsWith("mismatch-fire-rate.js") ||
  process.argv[1]?.endsWith("mismatch-fire-rate.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
