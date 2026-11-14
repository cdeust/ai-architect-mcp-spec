/**
 * Section generation — the core PRD authoring loop.
 *
 * State machine PER section:
 *   pending     → emit call_cortex_tool (recall section-specific context)
 *                 status := retrieving
 *   retrieving  → on tool_result: emit spawn_subagents (engineer drafts section)
 *                 status := generating
 *   generating  → on subagent_batch_result: store content, run validation
 *                 in-process, status := passed | retrying | failed
 *   retrying    → emit spawn_subagents with violations as additional context
 *                 status := generating, attempt++
 *   passed      → advance to next section
 *   failed      → log, advance to next section anyway (don't block)
 *
 * When all sections are passed/failed → transition to jira_generation.
 *
 * B6 refactor (Wave D): validateAndAdvance, applyRetryArmPolicy,
 * buildExecutionResults, failSection, and replaceSection have been extracted
 * to ./section-generation/validate-and-advance.ts to keep this file ≤500 LOC
 * (coding-standards §4.1). All public behaviour is unchanged.
 *
 * source: Fowler (2018), Refactoring, §6.1 Extract Function.
 * source: coding-standards §4.1 (500-line file limit).
 */

import type { StepHandler } from "../runner.js";
import type { ActionResult, HandlerAction } from "../types/actions.js";
import {
  appendError,
  type PipelineState,
  type SectionStatus,
} from "../types/state.js";
import {
  SECTION_DISPLAY_NAMES,
  CAPABILITIES,
  type SectionType,
} from "@prd-gen/core";
import {
  buildSectionPrompt,
  type CodebaseGrounding,
} from "@prd-gen/meta-prompting";
import { selectStrategy, type StrategyAssignment } from "@prd-gen/strategy";
import { SECTIONS_BY_CONTEXT, SECTION_RECALL_TEMPLATES } from "../section-plan.js";
import {
  replaceSection,
  failSection,
  validateAndAdvance,
} from "./section-generation/validate-and-advance.js";
import { summarizeCortexRecall } from "./cortex-recall-summary.js";

/**
 * Maximum draft attempts per section before marking it failed and moving on.
 *
 * Exported so the benchmark layer can import the single authoritative value
 * instead of maintaining a mirror constant (Wave D1.A).
 *
 * Re-exported from section-generation-constants.ts (single source of truth)
 * to avoid a circular import between this file and validate-and-advance.ts.
 *
 * source: docs/PHASE_4_PLAN.md §4.2 retry budget; provisional anchor pending
 * the Schoenfeld N=823 ablation study (Wave D + future calibration runs).
 */
// source: docs/PHASE_4_PLAN.md §4.2 retry budget; provisional anchor pending
// the Schoenfeld N=823 ablation study (Wave D + future calibration runs).
export { MAX_ATTEMPTS } from "./section-generation-constants.js";

import { SECTION_GENERATE_INV_PREFIX as GENERATE_PREFIX } from "./protocol-ids.js";

const RETRIEVE_PREFIX = "section_retrieve_";

function correlationFor(prefix: string, sectionType: string): string {
  return `${prefix}${sectionType}`;
}

function ensureSectionsInitialized(state: PipelineState): PipelineState {
  if (state.sections.length > 0 || !state.prd_context) return state;
  const planned = SECTIONS_BY_CONTEXT[state.prd_context];
  // Enforce the maxSections cap: 11 (the limit baked into CAPABILITIES) is
  // larger than any single context plan, so this is effectively a no-op
  // for normal use, but stays here as a defense if SECTIONS_BY_CONTEXT
  // ever grows. source: CAPABILITIES (core/src/domain/capabilities.ts).
  const cap = CAPABILITIES.maxSections;
  const allowed = planned.slice(0, cap);
  const sections: SectionStatus[] = allowed.map((section_type) => ({
    section_type,
    status: "pending",
    attempt: 0,
    violation_count: 0,
    last_violations: [],
    attempt_log: [],
  }));
  return { ...state, sections };
}

function findActiveSection(state: PipelineState): SectionStatus | undefined {
  return state.sections.find(
    (s) => s.status !== "passed" && s.status !== "failed",
  );
}

function recallAction(
  feature: string,
  sectionType: SectionType,
): HandlerAction {
  const template = SECTION_RECALL_TEMPLATES[sectionType];
  const query = template.replace("{feature}", feature);
  return {
    kind: "call_cortex_tool",
    tool_name: "recall",
    /**
     * source: provisional heuristic, not measured. It is also the number
     * of results a prompt keeps (cortex-recall-summary.ts,
     * RECALL_MAX_RESULTS_INCLUDED), so asking for more would add nothing
     * to a prompt. The module this comment cited for a per-section
     * retrieval budget, mcp-server/context-budget.ts, was never read by the
     * pipeline and is gone (#120). Cross-audit code-reviewer H6 (Phase 3+4,
     * 2026-04).
     */
    arguments: { query, max_results: 8 },
    correlation_id: correlationFor(RETRIEVE_PREFIX, sectionType),
  };
}

/**
 * Normalize the opaque `state.codebase_grounding` into the grounding shape the
 * section prompt renders.
 *
 * AP's feature-mode `prepare_prd_input` returns a RESPONSE object that CONTAINS
 * the grounding under `.prd_context`. `state.codebase_grounding` is stored as
 * that whole response (the orchestration layer is a pure passthrough — see
 * state.ts), so the grounding is `state.codebase_grounding.prd_context`. Fall
 * back to the object itself if `.prd_context` is absent (already-flat payloads),
 * and to `undefined` when no grounding exists at all.
 *
 * precondition: `raw` is `state.codebase_grounding` (Record<string, unknown> | null).
 * postcondition: returns a CodebaseGrounding (possibly empty-but-typed) when a
 *   grounding object is present, else `undefined`. An `undefined` result makes
 *   `renderGroundingBlock` emit nothing → byte-identical pre-grounding prompt.
 *
 * source: AP feature-mode prepare_prd_input contract — response carries
 * `prd_context` (the grounding); shipped 2026-06.
 */
function normalizeGrounding(
  raw: Record<string, unknown> | null | undefined,
): CodebaseGrounding | undefined {
  if (!raw) return undefined;
  const nested = (raw as { prd_context?: unknown }).prd_context;
  const grounding =
    nested && typeof nested === "object" ? nested : raw;
  return grounding as CodebaseGrounding;
}

function draftAction(
  state: PipelineState,
  section: SectionStatus,
  recall_summary: string,
  prior_violations: readonly string[],
): HandlerAction {
  const display = SECTION_DISPLAY_NAMES[section.section_type];
  if (!state.prd_context) {
    throw new Error(`section-generation reached without prd_context`);
  }

  const prompt = buildSectionPrompt({
    section_type: section.section_type,
    feature_description: state.feature_description,
    prd_context: state.prd_context,
    recall_summary,
    clarification_qa: state.clarifications
      .filter((c): c is typeof c & { answer: string } => Boolean(c.answer))
      .map((c) => ({ question: c.question, answer: c.answer })),
    prior_violations: [...prior_violations],
    attempt: section.attempt,
    // Phase 4 strategy-wiring (2026-04): pass the persisted assignment
    // so every retry uses the SAME strategies the selector chose at the
    // pending → retrieving transition.
    strategy_assignment: section.strategy_assignment,
    // Thread AP's code-graph grounding (state.codebase_grounding, possibly
    // wrapped in a prepare_prd_input response) into the prompt so drafts
    // reference real symbols/files/communities/processes. `undefined` when no
    // codebase grounding exists → prompt is byte-identical to before.
    codebase_grounding: normalizeGrounding(state.codebase_grounding),
    // Run-level Cortex memory recall (Phase 1a, fetched once in
    // input_analysis on feature_description), distinct from `recall_summary`
    // above (per-section, template-driven). `undefined`/"" when Cortex
    // returned nothing or the run predates the field → prompt is
    // byte-identical to before.
    global_recall_summary: state.global_recall_summary ?? undefined,
    // git-historian investigation report (Phase 2, fetched once in
    // input_analysis after code-graph grounding settles). `undefined`/""
    // when no codebase, the investigation returned nothing, or the run
    // predates the field → prompt is byte-identical to before.
    git_history_summary: state.git_history_summary ?? undefined,
  });

  return {
    kind: "spawn_subagents",
    purpose: "draft",
    batch_id: correlationFor(GENERATE_PREFIX, section.section_type),
    invocations: [
      {
        invocation_id: correlationFor(GENERATE_PREFIX, section.section_type),
        subagent_type: "zetetic-team-subagents:engineer",
        description: `Draft section: ${display}`,
        prompt,
        isolation: "none",
      },
    ],
  };
}

/**
 * Failed-precondition early return when prd_context is null.
 */
function failNoPrdContext(state: PipelineState) {
  return {
    state: appendError(
      state,
      "[section_generation] prd_context is null",
      "structural",
    ),
    action: {
      kind: "failed" as const,
      reason: "section_generation reached without prd_context",
      step: "section_generation" as const,
    },
  };
}

/**
 * No more sections to process → advance to jira_generation.
 */
function advanceToJira(init: PipelineState) {
  return {
    state: { ...init, current_step: "jira_generation" as const },
    action: {
      kind: "emit_message" as const,
      message: "All sections processed. Generating JIRA tickets.",
    },
  };
}

/**
 * Select a strategy assignment for the section based on its claim signal.
 *
 * source: Phase 4 strategy-wiring (2026-04).
 */
function chooseStrategyForSection(
  state: PipelineState,
  section_type: SectionType,
): StrategyAssignment {
  const display = SECTION_DISPLAY_NAMES[section_type];
  return selectStrategy({
    claim: `${display}: ${state.feature_description}`,
    context: section_type,
    hasCodebase: state.codebase_indexed,
  });
}

/**
 * pending → retrieving: kick off the Cortex recall for the active section.
 *
 * Strategy assignment is materialized here (once per section) so retries
 * downstream reuse the SAME assignment.
 */
function startRetrieving(init: PipelineState, active: SectionStatus) {
  const assignment =
    active.strategy_assignment ?? chooseStrategyForSection(init, active.section_type);
  const next = {
    ...active,
    status: "retrieving" as const,
    strategy_assignment: assignment,
  };
  return {
    state: replaceSection(init, next),
    action: recallAction(init.feature_description, active.section_type),
  };
}

/**
 * retrieving → generating: recall returned; spawn the engineer to draft.
 */
function advanceFromRecall(
  init: PipelineState,
  active: SectionStatus,
  data: unknown,
) {
  const recallSummary = summarizeCortexRecall(data);
  // Track empty recalls so the KPI surface can surface recall-efficacy
  // without post-hoc parsing.
  const emptyRecall = recallSummary.length === 0;
  const next = {
    ...active,
    status: "generating" as const,
    attempt: active.attempt + 1,
  };
  const stateWithRecall = emptyRecall
    ? {
        ...init,
        cortex_recall_empty_count: init.cortex_recall_empty_count + 1,
      }
    : init;
  const updated = replaceSection(stateWithRecall, next);
  return {
    state: updated,
    action: draftAction(updated, next, recallSummary, active.last_violations),
  };
}

/**
 * generating → validation: subagent returned; either pass / retry / fail.
 */
function processDraft(
  init: PipelineState,
  active: SectionStatus,
  result: Extract<ActionResult, { kind: "subagent_batch_result" }>,
) {
  const draft = collectDraftText(result, active.section_type);
  if (!draft) {
    return failSection(init, active, "Subagent returned empty draft");
  }
  // Pass draftAction as a callback so validateAndAdvance can emit retries
  // without importing this file (avoids circular dependency).
  return validateAndAdvance(init, active, draft, draftAction);
}

/**
 * Stalled (no matching result kind/correlation) — re-issue the appropriate
 * action so the host has another chance to fulfill it.
 */
function reissueStalled(init: PipelineState, active: SectionStatus) {
  if (active.status === "retrieving") {
    return {
      state: init,
      action: recallAction(init.feature_description, active.section_type),
    };
  }
  return {
    state: init,
    action: draftAction(init, active, "", active.last_violations),
  };
}

export const handleSectionGeneration: StepHandler = ({ state, result }) => {
  if (!state.prd_context) {
    return failNoPrdContext(state);
  }

  const init = ensureSectionsInitialized(state);
  const active = findActiveSection(init);

  if (!active) {
    return advanceToJira(init);
  }

  if (active.status === "pending") {
    return startRetrieving(init, active);
  }

  if (
    active.status === "retrieving" &&
    result?.kind === "tool_result" &&
    result.correlation_id ===
      correlationFor(RETRIEVE_PREFIX, active.section_type)
  ) {
    return advanceFromRecall(init, active, result.data);
  }

  if (
    active.status === "generating" &&
    result?.kind === "subagent_batch_result" &&
    result.batch_id === correlationFor(GENERATE_PREFIX, active.section_type)
  ) {
    return processDraft(init, active, result);
  }

  return reissueStalled(init, active);
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function collectDraftText(
  result: Extract<ActionResult, { kind: "subagent_batch_result" }>,
  sectionType: SectionType,
): string | null {
  const expectedId = correlationFor(GENERATE_PREFIX, sectionType);
  const response = result.responses.find((r) => r.invocation_id === expectedId);
  if (!response) return null;
  if (response.error) return null;
  return response.raw_text?.trim() ?? null;
}
