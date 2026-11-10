/**
 * `finalize` — Cortex `remember`, run once per pipeline, immediately before
 * the terminal `done` action. The ONLY step that reaches `current_step:
 * "complete"` (design-phases-3-5.md §2.2).
 *
 * Relocated from self-check/remember-phase.ts (Phase 1b, 2026-07-14) as part
 * of PR 3b — the post-specs implementation gate now sits between
 * self_check's PRD deliverables and this terminal remember/done pair.
 * self_check's finalize() no longer emits `remember` itself: it computes the
 * final summary/artifacts/verification, stores it in
 * `state.pending_completion`, and advances to `implementation_gate`. Every
 * path through the (PR-3b-scoped) post-specs loop — "prd_only" straight from
 * the gate, or "implement" → pre_impl_grounding's dead-end — converges here.
 *
 * Phase C logic itself is UNCHANGED from remember-phase.ts: the reducer
 * needs a host round trip to run `remember`, and the verdicts that produced
 * the summary are not recoverable on a later step() call (verification_plan
 * is cleared during self-check Phase B; the batch_result is not persisted).
 * Storing the already-computed payload is the seam: this module either
 * (a) emits the remember call, or (b) once its result comes back (or
 * `run_remembered` is already true on replay), reconstructs the exact `done`
 * action from `pending_completion`.
 *
 * A `remember` failure is best-effort and MUST NOT block completion — the
 * run has already produced its deliverables; recording that fact durably in
 * Cortex is a bonus, not a precondition, mirroring the per-section recall's
 * degrade-gracefully contract in section-generation.ts.
 *
 * source: Phase 1b (2026-07-14) — Cortex memory-loop closure (original Phase
 * C). source: design-phases-3-5.md §2.2, §5 PR 3b — relocation.
 */

import { appendError, type PipelineState } from "../types/state.js";
import type { HandlerAction, NextAction } from "../types/actions.js";
import type { StepHandler } from "../runner.js";

export const REMEMBER_CORRELATION_ID = "self_check_remember";

type PendingCompletion = NonNullable<PipelineState["pending_completion"]>;

/**
 * source: prd-gen convention — every other call_cortex_tool[recall] site
 * (section-generation.ts, input-analysis.ts Phase 1a) tags its origin via
 * the correlation_id alone; `remember` additionally accepts `tags` +
 * `source` per the Cortex MCP `remember` tool contract. Tags/source strings
 * are UNCHANGED from the original self-check-owned Phase C (they describe
 * the pipeline phase that computed the payload, not this file's location).
 */
const REMEMBER_TAGS: readonly string[] = ["prd-gen", "prd-run"];
const REMEMBER_SOURCE = "prd-gen:self_check";

/**
 * PR 3b addition: summarize the post-specs decision + any grounding
 * collected so far, so the remembered fact documents what happened between
 * self-check and finalize even when no code was written (dead-ended gate).
 * Returns "" when state.post_specs is null (run never reached the gate —
 * cannot happen on the current step graph, but defensive for direct-inject
 * tests) so buildRememberContent can omit the block entirely.
 *
 * PR 4b addition: appends the implementation/verification/testing/review
 * outcome when the run reached that far (design-phases-3-5.md §5 PR
 * breakdown item 4: "finalize's remember content extended to include
 * implementation/verification/PR outcome").
 *
 * PR 5 addition: appends the PR outcome — pushed/opened with its URL,
 * declined at `pr_gate` ("No"), or degraded (push/`gh pr create` failure) —
 * whenever `post_specs.pr` is non-null (design §5 PR 5: "the remember of
 * finalize includes the PR outcome (url or decline/failure)").
 */
function buildPostSpecsSummary(state: PipelineState): string {
  const ps = state.post_specs;
  if (!ps) return "";
  const lines = [`Post-specs decision: ${ps.decision}`];
  if (ps.impact_queries.results.length > 0) {
    const ok = ps.impact_queries.results.filter((r) => r.success).length;
    lines.push(
      `Pre-implementation grounding: ${ps.impact_queries.results.length} symbol(s) queried (${ok} succeeded).`,
    );
    for (const r of ps.impact_queries.results) {
      lines.push(
        `  - ${r.qualified_name}: ${r.success ? "ok" : `failed (${r.error ?? "unknown"})`}`,
      );
    }
  }
  if (ps.implementation) {
    lines.push(
      `Implementation: branch '${ps.implementation.branch}' at ${ps.implementation.worktree_path ?? "(unknown worktree)"} (${ps.implementation.changed_files.length} file(s) changed).`,
    );
  }
  if (ps.verification) {
    lines.push(`Post-implementation verification: gates_passed=${ps.verification.gates_passed}.`);
  }
  if (ps.testing) {
    lines.push(`Testing: report recorded (${ps.testing.raw_report.length} char(s)).`);
  }
  if (ps.review) {
    lines.push(
      `Review: verdict=${ps.review.verdict} (attempt ${ps.review.attempt}, ${ps.retry_count} retry/retries used).`,
    );
    if (ps.review.findings.length > 0) {
      lines.push(`  Findings: ${ps.review.findings.join("; ")}`);
    }
  }
  if (ps.pr) {
    lines.push(
      ps.pr.pushed
        ? `PR: opened at ${ps.pr.url ?? "(unknown url)"}.`
        : "PR: not opened (declined at the gate, or push/gh pr create failed).",
    );
  }
  return lines.join("\n");
}

/**
 * precondition:  `pending` is state.pending_completion, non-null.
 * postcondition: returns a self-contained fact string — readable without
 *                this run's context — naming the feature, PRD context type,
 *                section/ticket counts, self-check/judge verdicts (via
 *                `pending.summary`, already human-readable), the post-specs
 *                decision + grounding summary (when present), and every
 *                exported file path (state.written_files) as verifiable
 *                references.
 */
function buildRememberContent(
  state: PipelineState,
  pending: PendingCompletion,
): string {
  const sectionsTotal = state.sections.filter(
    (s) => s.section_type !== "jira_tickets",
  ).length;
  const hasJiraTickets = state.sections.some(
    (s) => s.section_type === "jira_tickets" && s.content,
  );
  const exportedFiles = state.written_files.length
    ? state.written_files.join("\n  - ")
    : "(none written)";
  const postSpecsSummary = buildPostSpecsSummary(state);

  return [
    `PRD run complete: "${state.feature_description}"`,
    `PRD context: ${state.prd_context ?? "unknown"}`,
    `Sections: ${sectionsTotal} planned. JIRA tickets generated: ${hasJiraTickets ? "yes" : "no"}.`,
    "",
    pending.summary,
    "",
    ...(postSpecsSummary ? [postSpecsSummary, ""] : []),
    `Exported files (verifiable references):`,
    `  - ${exportedFiles}`,
  ].join("\n");
}

function rememberAction(
  state: PipelineState,
  pending: PendingCompletion,
): HandlerAction {
  return {
    kind: "call_cortex_tool",
    tool_name: "remember",
    arguments: {
      content: buildRememberContent(state, pending),
      tags: REMEMBER_TAGS,
      source: REMEMBER_SOURCE,
    },
    correlation_id: REMEMBER_CORRELATION_ID,
  };
}

function doneAction(pending: PendingCompletion): NextAction {
  return {
    kind: "done",
    summary: pending.summary,
    artifacts: pending.artifacts,
    verification: pending.verification,
    ...(pending.outcome ? { outcome: pending.outcome } : {}),
  };
}

/**
 * Either emits `remember` (first entry, or replay before the result
 * arrives) or — once `run_remembered` is already true — returns `done`
 * directly.
 */
function emitRememberOrDone(
  state: PipelineState,
  pending: PendingCompletion,
): { state: PipelineState; action: HandlerAction } {
  if (state.run_remembered) {
    return {
      state: { ...state, current_step: "complete", pending_completion: null },
      action: doneAction(pending),
    };
  }
  return {
    state: { ...state, pending_completion: pending },
    action: rememberAction(state, pending),
  };
}

/**
 * precondition:  state.pending_completion !== null (set by self_check's
 *                finalize(), carried through implementation_gate /
 *                pre_impl_grounding unchanged).
 * postcondition: state.run_remembered === true AND the returned action is
 *                `done` (remember failure is recorded via appendError but
 *                never blocks completion).
 */
export const handleFinalize: StepHandler = ({ state, result }) => {
  const pending = state.pending_completion;
  if (!pending) {
    throw new Error("handleFinalize reached with pending_completion === null");
  }

  if (
    result?.kind === "tool_result" &&
    result.correlation_id === REMEMBER_CORRELATION_ID
  ) {
    const nextState: PipelineState = result.success
      ? { ...state, run_remembered: true }
      : appendError(
          { ...state, run_remembered: true },
          `remember failed: ${result.error ?? "unknown"}; run summary was not persisted to Cortex`,
          "upstream_failure",
        );
    return emitRememberOrDone(nextState, pending);
  }

  // Not yet dispatched (or replay before the result arrives) — (re)issue.
  return { state, action: rememberAction(state, pending) };
};
