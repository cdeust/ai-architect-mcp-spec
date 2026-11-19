/**
 * Pipeline runner — stateless reducer with emit_message coalescing.
 *
 * Inputs:  current PipelineState + optional last ActionResult fed from host.
 * Output:  updated PipelineState + the next SUBSTANTIVE NextAction the host
 *          must execute, plus the list of messages that were emitted while
 *          advancing to it.
 *
 * Coalescing: handlers may emit an `emit_message` action when they
 * advance state without needing host involvement (banners, status updates).
 * The host never has to "advance past" an emit_message — the runner re-enters
 * automatically until it produces an action that genuinely requires the host
 * (ask_user, call_*_tool, spawn_subagents, write_file, done, failed) or until
 * a maximum re-entry cap is reached (defense-in-depth against handler bugs).
 *
 * The runner NEVER performs I/O. It cannot itself call MCP tools, spawn
 * agents, or interact with the user. All side effects are delegated to the
 * host via the substantive NextAction. The host calls `step()` again with
 * the result, advancing the FSM.
 *
 * This separation is what makes the orchestrator testable: every handler is
 * a pure function that takes (state, result?) and returns (state', action).
 */

import {
  type ActionResult,
  type HandlerAction,
  type NextAction,
} from "./types/actions.js";
import { type PipelineState, touch, appendError } from "./types/state.js";
import { handleBanner } from "./handlers/banner.js";
import { handlePreflight } from "./handlers/preflight.js";
import { handleContextDetection } from "./handlers/context-detection.js";
import { handleInputAnalysis } from "./handlers/input-analysis.js";
import { handleFeasibilityGate } from "./handlers/feasibility-gate.js";
import { handleClarification } from "./handlers/clarification.js";
import { handleBudget } from "./handlers/budget.js";
import { handleSectionGeneration } from "./handlers/section-generation.js";
import { handleJiraGeneration } from "./handlers/jira-generation.js";
import { handleFileExport } from "./handlers/file-export.js";
import { handleSelfCheck } from "./handlers/self-check.js";
import { handleImplementationGate } from "./handlers/implementation-gate.js";
import { handlePreImplGrounding } from "./handlers/pre-impl-grounding.js";
import { handleImplementation } from "./handlers/implementation.js";
import { handlePostImplVerification } from "./handlers/post-impl-verification.js";
import { handleTesting } from "./handlers/testing.js";
import { handleReview } from "./handlers/review.js";
import { handlePrGate } from "./handlers/pr-gate.js";
import { handlePrCreation } from "./handlers/pr-creation.js";
import { handleFinalize } from "./handlers/finalize.js";

export interface StepInput {
  readonly state: PipelineState;
  readonly result?: ActionResult;
}

export interface StepOutput {
  readonly state: PipelineState;
  readonly action: NextAction;
  /**
   * Messages collected while coalescing emit_message actions on the way to
   * `action`. Empty when no emit_message was traversed. The host should
   * display these to the user before acting on `action`.
   */
  readonly messages: ReadonlyArray<{
    readonly text: string;
    readonly level: "info" | "warn" | "error";
  }>;
}

export type StepHandler = (input: StepInput) => {
  readonly state: PipelineState;
  readonly action: HandlerAction;
  readonly warning?: string;
};

const HANDLERS: Record<PipelineState["current_step"], StepHandler> = {
  banner: handleBanner,
  preflight: handlePreflight,
  context_detection: handleContextDetection,
  input_analysis: handleInputAnalysis,
  feasibility_gate: handleFeasibilityGate,
  clarification: handleClarification,
  budget: handleBudget,
  section_generation: handleSectionGeneration,
  jira_generation: handleJiraGeneration,
  file_export: handleFileExport,
  self_check: handleSelfCheck,
  implementation_gate: handleImplementationGate,
  pre_impl_grounding: handlePreImplGrounding,
  implementation: handleImplementation,
  post_impl_verification: handlePostImplVerification,
  testing: handleTesting,
  review: handleReview,
  pr_gate: handlePrGate,
  pr_creation: handlePrCreation,
  finalize: handleFinalize,
  complete: ({ state }) => ({
    state,
    action: {
      kind: "done",
      summary: "Pipeline already complete.",
      artifacts: [],
    },
  }),
};

/**
 * Maximum re-entries while coalescing emit_message actions. The cap surfaces
 * infinite-loop bugs as a `failed` action instead of an OOM/hang.
 *
 * source: derived from the longest legitimate emit_message chain across all
 * handlers (verified by Dijkstra cross-audit, 2026-04; updated for the PR 3b
 * post-specs gate, design-phases-3-5.md §2.2). The longest chain occurs on a
 * fully-replayed state with all sections done, no JIRA source, all files
 * written, and the "prd_only" gate answer already on file:
 *   banner → context_detection → input_analysis (already-indexed) →
 *   feasibility_gate → clarification (max-done) → budget → section_generation
 *   (all-done) → jira_generation (no-source) → file_export (all-written) →
 *   self_check (emit_message, hands off to implementation_gate) →
 *   pre_impl_grounding's dead-end is NOT on this chain (implementation_gate
 *   itself returns the substantive ask_user)
 * = 10 emit_message hops before a substantive action. Cap of 16 gives ~1.6x
 * safety margin. Tune from production telemetry once we observe re-entry
 * depth.
 */
const COALESCE_CAP = 16;

export function step(input: StepInput): StepOutput {
  const messages: Array<{ text: string; level: "info" | "warn" | "error" }> =
    [];
  let currentState = input.state;
  // The first iteration consumes the result; subsequent iterations have no
  // result because the host has not been asked to do anything yet.
  let pendingResult: ActionResult | undefined = input.result;

  for (let i = 0; i < COALESCE_CAP; i++) {
    const out = invoke(currentState, pendingResult);
    if (out.warning) messages.push({ text: out.warning, level: "warn" });
    currentState = out.state;
    pendingResult = undefined; // result is consumed on the first iteration only

    if (out.action.kind === "emit_message") {
      // HandlerAction is z.input, so level may be undefined here even though
      // the parsed output type makes it required. Default at the boundary —
      // matches the schema's .default("info") — to keep the runtime invariant
      // that messages[i].level is always concrete.
      const level = out.action.level ?? "info";
      messages.push({ text: out.action.message, level });

      // Defense-in-depth escape: if a handler is ever modified to advance
      // `current_step` to "complete" while still returning `emit_message`,
      // synthesize a terminal action from the accumulated messages instead
      // of continuing to iterate. Currently unreachable — no handler in the
      // tree exhibits this pattern — but kept as a guard for future
      // handler edits.
      if (currentState.current_step === "complete") {
        return {
          state: touch(currentState),
          action: terminalFromMessages(messages),
          messages,
        };
      }
      continue;
    }

    return {
      state: touch(currentState),
      action: out.action as NextAction, // narrowed: kind !== "emit_message"
      messages,
    };
  }

  // Hit the cap — surface as a failed action. This indicates a handler bug
  // (likely an infinite emit_message loop that does not advance state).
  // Use appendError to keep state.errors and state.error_kinds in lockstep
  // (cross-audit dijkstra CRIT-1, Phase 3+4 follow-up, 2026-04). A raw
  // spread here would leave error_kinds shorter than errors, silently
  // corrupting the structural_error_count KPI for the rest of the run.
  const stateWithError = appendError(
    currentState,
    `[runner] coalesce cap (${COALESCE_CAP}) exceeded; suspected handler loop on step '${currentState.current_step}'`,
    "structural", // handler-loop runaway is a code-layer defect, not a section validator failure
  );
  return {
    state: touch(stateWithError),
    action: {
      kind: "failed",
      reason: `Runner exceeded emit_message coalesce cap (${COALESCE_CAP}). The pipeline may have an infinite handler loop on step '${currentState.current_step}'.`,
      step: currentState.current_step,
    },
    messages,
  };
}

/**
 * Synthesize a terminal action from coalesced messages. If any message has
 * level === "error", the synthesis becomes `failed` (an error-level signal
 * is conserved across the coalescing boundary). Otherwise it becomes `done`
 * with all message texts in the summary, prefixed by their level when not
 * "info".
 */
function terminalFromMessages(
  messages: ReadonlyArray<{ text: string; level: "info" | "warn" | "error" }>,
): NextAction {
  const errorMsgs = messages.filter((m) => m.level === "error");
  if (errorMsgs.length > 0) {
    return {
      kind: "failed",
      reason: errorMsgs.map((m) => m.text).join("\n"),
      step: "complete",
    };
  }
  const summary = messages
    .map((m) =>
      m.level === "info" ? m.text : `[${m.level.toUpperCase()}] ${m.text}`,
    )
    .join("\n");
  return { kind: "done", summary, artifacts: [] };
}

function invoke(
  state: PipelineState,
  result: ActionResult | undefined,
): ReturnType<StepHandler> {
  const handler = HANDLERS[state.current_step];
  if (!handler) {
    return {
      state,
      action: {
        kind: "failed",
        reason: `No handler for step '${state.current_step}'`,
        step: state.current_step,
      },
    };
  }

  try {
    return handler({ state, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: appendError(
        state,
        `[${state.current_step}] ${message}`,
        "structural", // uncaught handler exception — by definition a code-layer bug
      ),
      action: {
        kind: "failed",
        reason: message,
        step: state.current_step,
      },
    };
  }
}
