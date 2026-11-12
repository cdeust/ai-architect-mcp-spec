/**
 * validate-and-advance.ts — section validation + retry-arm policy (Wave D B6).
 *
 * Extracted from section-generation.ts to keep the parent file under the
 * §4.1 500-line limit (Fowler Extract Function, coding-standards §4.1).
 *
 * Exports:
 *   validateAndAdvance    — run validation and emit the next action.
 *   applyRetryArmPolicy   — pure arm-branching helper (D1.C ablation).
 *   buildExecutionResults — strategy attribution for the EvidenceRepository.
 *   failSection           — section failure path.
 *   replaceSection        — state update helper.
 *
 * Layer: orchestration/handlers — no benchmark imports, no I/O.
 *
 * source: Fowler (2018), Refactoring, §6.1 Extract Function.
 * source: coding-standards §4.1 (500-line file limit).
 * source: Wave D B6 remediation.
 */

import type { HandlerAction } from "../../types/actions.js";
import {
  appendError,
  type PipelineState,
  type SectionStatus,
} from "../../types/state.js";
import { validateSection } from "@prd-gen/validation";
// SectionType is not imported: every section type in this module arrives as
// SectionStatus.section_type, which state/section-status.ts already types via
// SectionTypeSchema.
import {
  SECTION_DISPLAY_NAMES,
  isBlockingViolation,
  type PRDContext,
} from "@prd-gen/core";
import type { StrategyAssignment, ExecutionResult } from "@prd-gen/strategy";
import { MAX_ATTEMPTS } from "../section-generation-constants.js";

// ─── replaceSection ───────────────────────────────────────────────────────────

/**
 * Immutably replace one section in state.sections.
 *
 * Precondition:  next.section_type exists in state.sections.
 * Postcondition: returned state has exactly one entry with next.section_type,
 *   whose value equals next. All other sections are unchanged.
 */
export function replaceSection(
  state: PipelineState,
  next: SectionStatus,
): PipelineState {
  return {
    ...state,
    sections: state.sections.map((s) =>
      s.section_type === next.section_type ? next : s,
    ),
  };
}

// ─── buildExecutionResults ────────────────────────────────────────────────────

/**
 * Build ExecutionResult entries for a section's terminal transition.
 *
 * Precondition: `active.status` is `"passed"` or `"failed"`. Enforced
 *   structurally — non-terminal callers receive [] back.
 * Postcondition: one ExecutionResult per required strategy (or one for
 *   optional[0] if no required strategies). Empty array when no assignment.
 *
 * source: Phase 4 strategy-wiring (2026-04).
 * source: coding-standards §1.1 SRP — attribution is separate from validation.
 */
export function buildExecutionResults(
  active: SectionStatus,
  prdContext: PRDContext,
  passed: boolean,
): readonly ExecutionResult[] {
  if (active.status !== "passed" && active.status !== "failed") return [];
  const assignment = active.strategy_assignment;
  if (!assignment) return [];

  const strategies =
    assignment.required.length > 0
      ? assignment.required
      : assignment.optional[0]
        ? [assignment.optional[0]]
        : [];
  if (strategies.length === 0) return [];

  const attempts = Math.max(1, active.attempt);
  const actualConfidenceGain = passed ? assignment.expectedImprovement : 0;
  const retryCount = Math.max(0, attempts - 1);

  return strategies.map((strategy) => ({
    strategy,
    assignment: assignment as StrategyAssignment,
    actualConfidenceGain,
    wasCompliant: passed,
    retryCount,
    prdContext,
  }));
}

// ─── applyRetryArmPolicy ──────────────────────────────────────────────────────

/**
 * Determine which violations to feed into the next retry attempt based on the
 * ablation arm (D1.C).
 *
 * Precondition:  state.retry_policy is null OR has a valid arm.
 * Postcondition: returns violations for the next attempt and the attempt_log
 *   entry for the current attempt.
 *   - arm "without_prior_violations": violationsForNextAttempt = [].
 *   - arm "with_prior_violations" (default): violationsForNextAttempt = [...violations].
 *
 * The arm is read from state so the reducer stays pure (no direct benchmark
 * imports, §2.2 layer rule).
 *
 * source: PHASE_4_PLAN.md §4.2 D1.C ablation arm specification.
 * source: coding-standards §1.5 DIP — arm selection is injected via state.
 * source: Wave D B6 remediation (Extract Function).
 */
export function applyRetryArmPolicy(
  state: PipelineState,
  active: SectionStatus,
  violations: readonly string[],
): {
  violationsForNextAttempt: readonly string[];
  attemptLogEntry: { attempt: number; violations_fed: readonly string[] };
} {
  const attemptLogEntry = {
    attempt: active.attempt,
    violations_fed: [...active.last_violations],
  };

  const arm = state.retry_policy?.arm ?? "with_prior_violations";
  const violationsForNextAttempt =
    arm === "without_prior_violations" ? [] : [...violations];

  return { violationsForNextAttempt, attemptLogEntry };
}

// ─── failSection ─────────────────────────────────────────────────────────────

/**
 * Transition a section to "failed" and record the error.
 *
 * Precondition:  reason is a non-empty string describing why the section failed.
 * Postcondition: state.errors has one new "section_failure" entry; active
 *   section status is "failed".
 *
 * source: coding-standards §1.1 SRP — failure path isolated from retry path.
 */
export function failSection(
  state: PipelineState,
  active: SectionStatus,
  reason: string,
  draft?: string,
  violations: readonly string[] = [],
): { state: PipelineState; action: HandlerAction } {
  const next: SectionStatus = {
    ...active,
    status: "failed",
    content: draft ?? active.content,
    violation_count: violations.length || active.violation_count,
    last_violations: [...violations],
  };
  const stateWithSection = replaceSection(state, next);
  let stateWithError = appendError(
    stateWithSection,
    `[section_generation:${active.section_type}] ${reason}`,
    "section_failure",
  );
  if (state.prd_context) {
    const execs = buildExecutionResults(next, state.prd_context, false);
    if (execs.length > 0) {
      stateWithError = {
        ...stateWithError,
        strategy_executions: [...stateWithError.strategy_executions, ...execs],
      };
    }
  }
  return {
    state: stateWithError,
    action: {
      kind: "emit_message",
      level: "warn",
      message: `✗ ${SECTION_DISPLAY_NAMES[active.section_type]}: ${reason}`,
    },
  };
}

// ─── validateAndAdvance ───────────────────────────────────────────────────────

/**
 * Validate a freshly-generated section draft and emit the next action.
 *
 * Precondition:  active.status === "generating".
 * Precondition:  active.attempt ∈ [1, effectiveMaxAttempts]. The first attempt
 *                is counted at the retrieving→generating transition, so the
 *                first call to validateAndAdvance has active.attempt = 1.
 * Postcondition: exactly one of three outcomes is produced:
 *                 (a) validation succeeded (no blocking violation; advisory
 *                     ones are reported in the message) → status="passed",
 *                     content set.
 *                 (b) validation failed AND active.attempt >= effectiveMaxAttempts
 *                     → status="failed", error appended.
 *                 (c) validation failed AND active.attempt < effectiveMaxAttempts
 *                     → status="generating", attempt = active.attempt + 1
 *                     (STRICT increase — termination argument).
 * Invariant:    `attempt` is the loop variant; it strictly increases on every
 *               retry; effectiveMaxAttempts bounds total attempts. If this
 *               contract breaks, section_generation does not terminate.
 *
 * source: dijkstra cross-audit H2 (Phase 3+4, 2026-04).
 * source: Wave D B6 remediation (Extract Function).
 */
export function validateAndAdvance(
  state: PipelineState,
  active: SectionStatus,
  draft: string,
  draftActionFn: (
    state: PipelineState,
    section: SectionStatus,
    recallSummary: string,
    priorViolations: readonly string[],
  ) => HandlerAction,
): { state: PipelineState; action: HandlerAction } {
  const report = validateSection(draft, active.section_type);
  // Only blocking violations fail the section or are fed into a retry.
  // Advisory ones (a lexicon found none of a topic's words) cannot tell
  // whether the topic applies to the feature; retrying on them spends model
  // calls and teaches the model to stuff keywords (issue #117). They are
  // reported in the pass message instead.
  const violations = report.violations
    .filter(isBlockingViolation)
    .map((v) => `[${v.rule}] ${v.message}`);
  const advisories = report.violations
    .filter((v) => !isBlockingViolation(v))
    .map((v) => `[${v.rule}] ${v.message}`);

  // Record which violations were fed into this attempt BEFORE branching on outcome.
  // (Curie A2: instrumentation must observe behavior, not infer it.)
  const { violationsForNextAttempt, attemptLogEntry } = applyRetryArmPolicy(
    state,
    active,
    violations,
  );

  const activeWithLog: SectionStatus = {
    ...active,
    attempt_log: [...(active.attempt_log ?? []), attemptLogEntry],
  };

  if (violations.length === 0) {
    const next: SectionStatus = {
      ...activeWithLog,
      status: "passed",
      content: draft,
      violation_count: 0,
      last_violations: [],
    };
    let stateWithSection = replaceSection(state, next);
    if (state.prd_context) {
      const execs = buildExecutionResults(next, state.prd_context, true);
      if (execs.length > 0) {
        stateWithSection = {
          ...stateWithSection,
          strategy_executions: [...stateWithSection.strategy_executions, ...execs],
        };
      }
    }
    return {
      state: stateWithSection,
      action: {
        kind: "emit_message",
        message:
          `✓ ${SECTION_DISPLAY_NAMES[active.section_type]} passed validation (attempt ${active.attempt}).` +
          (advisories.length > 0
            ? ` Advisory (${advisories.length}, not blocking): ${advisories.join("; ")}`
            : ""),
      },
    };
  }

  // Read the effective max-attempts from the injected retry policy (D1.C).
  const effectiveMaxAttempts =
    state.retry_policy?.maxAttempts ?? MAX_ATTEMPTS;

  if (activeWithLog.attempt >= effectiveMaxAttempts) {
    return failSection(
      state,
      activeWithLog,
      `Failed validation after ${effectiveMaxAttempts} attempts. Violations: ${violations.join("; ")}`,
      draft,
      violations,
    );
  }

  // Retry: increment attempt and re-draft with violations as feedback.
  // attempt is the loop variant — it MUST increase here.
  const next: SectionStatus = {
    ...activeWithLog,
    status: "generating",
    content: draft,
    attempt: activeWithLog.attempt + 1,
    violation_count: violations.length,
    last_violations: [...violationsForNextAttempt],
  };
  const updatedState = replaceSection(state, next);
  return {
    state: updatedState,
    action: draftActionFn(updatedState, next, "", violationsForNextAttempt),
  };
}
