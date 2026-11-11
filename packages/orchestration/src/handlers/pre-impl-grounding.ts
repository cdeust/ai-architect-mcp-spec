/**
 * `pre_impl_grounding` — PRE-implementation blast-radius grounding
 * (design-phases-3-5.md §1, §3). One `call_pipeline_tool[get_impact]` round
 * trip per affected symbol, cursor-driven via `post_specs.impact_queries`.
 *
 * Symbol source: re-derived from `state.sections`' technical_specification
 * content via `parseAffectedSymbolsBlock` — the SAME extraction
 * file-export.ts performs when deciding whether to write the
 * `stage-5.affected_symbols.json` sidecar. NOT read from
 * `state.affected_symbols_path` on disk: this is a pure reducer with no
 * filesystem access, and the parsed claims already live in state.sections —
 * re-parsing is cheap (a handful of small objects) and avoids a second state
 * field duplicating the sidecar's content. `state.affected_symbols_path`
 * is used only as the GATE signal (non-null iff file-export found >=1 claim
 * — see file-export.ts's conditional sidecar emission).
 *
 * A technical_specification draft that failed validation is not a symbol
 * source: file-export.ts withholds it from the PRD and writes no sidecar
 * from it, so this handler queries none of its symbols and says why it
 * skipped. source: cdeust/ai-architect-mcp-spec#122.
 *
 * PR 4a wiring (design §3, §5.2): once grounding is gathered (or skipped —
 * grounding is best-effort context, never a gate), this handler advances to
 * `implementation`, carrying `post_specs` forward so the engineer's prompt
 * (implementation.ts) can embed the collected grounding. `testing`/`review`/
 * PR stages are still not wired (PRs 4b/5).
 *
 * Failure policy (design §4): a `get_impact` tool error DEGRADES — recorded
 * via `appendError("upstream_failure")`, the failing symbol's result entry
 * is kept (success:false), and the cursor still advances to the next
 * symbol. No get_impact failure aborts the loop or blocks `finalize`.
 *
 * Loop-guard placement (Phase 2 git-historian lesson, restated in design
 * §3): result-processing MUST be evaluated before any state-only "already
 * done" advance guard, or a replay re-issues the same call forever. This
 * handler checks the incoming `result` FIRST.
 */

import type { StepHandler } from "../runner.js";
import { appendError, type PipelineState } from "../types/state.js";
import {
  initialPostSpecs,
  type ImpactQueryResult,
  type PostSpecsState,
} from "../types/state/post-specs-state.js";
import { parseAffectedSymbolsBlock } from "@prd-gen/core";
import {
  PRE_IMPL_GROUNDING_IMPACT_PREFIX,
  preImplGroundingImpactCorrelationId,
} from "./protocol-ids.js";

/**
 * Cap on the number of affected symbols queried via get_impact per run.
 *
 * source: design-phases-3-5.md §3 — "provisional, no source — marked 'to
 * measure'", same convention as MAX_ATTEMPTS
 * (section-generation-constants.ts). Not a measured/sourced constant;
 * flagged for production-telemetry calibration before it is treated as
 * final (§10 stakes-calibration rule 8 — sources).
 */
export const IMPACT_QUERY_SYMBOL_CAP = 10;

function ensurePostSpecs(state: PipelineState): PostSpecsState {
  return state.post_specs ?? initialPostSpecs();
}

/**
 * precondition:  none — safe on any state.
 * postcondition: returns the deduplicated, cap-bounded list of qualified
 *                names claimed by the technical_specification section's
 *                affected-symbols block. Empty when no such section/block
 *                exists or the section failed validation (mirrors
 *                file-export.ts's affectedSymbolsForState empty-document
 *                fallback).
 */
function boundedAffectedSymbols(state: PipelineState): string[] {
  const techSpec = state.sections.find(
    (s) =>
      s.section_type === "technical_specification" && s.content && s.status !== "failed",
  );
  if (!techSpec?.content) return [];
  const doc = parseAffectedSymbolsBlock(techSpec.content);
  const names = doc.affected_symbols.map((s) => s.qualified_name);
  return Array.from(new Set(names)).slice(0, IMPACT_QUERY_SYMBOL_CAP);
}

/**
 * precondition:  none — safe on any state.
 * postcondition: true iff a technical_specification draft failed validation
 *                and no technical_specification section passed with content.
 */
function technicalSpecDraftWithheld(state: PipelineState): boolean {
  const techSpecs = state.sections.filter(
    (s) => s.section_type === "technical_specification" && s.content,
  );
  return techSpecs.length > 0 && techSpecs.every((s) => s.status === "failed");
}

/**
 * Advances to `implementation` (PR 4a, design-phases-3-5.md §3), carrying
 * the collected (or skipped) grounding forward. `testing`/`review`/PR stages
 * are still not wired (PRs 4b/5) — `implementation` may itself dead-end to
 * `finalize` on a subagent failure (implementation.ts's own failure policy).
 */
function advanceToImplementation(
  state: PipelineState,
  message: string,
): { state: PipelineState; action: { kind: "emit_message"; message: string; level: "info" } } {
  return {
    state: { ...state, current_step: "implementation" },
    action: {
      kind: "emit_message",
      message,
      level: "info",
    },
  };
}

export const handlePreImplGrounding: StepHandler = ({ state, result }) => {
  const postSpecs = ensurePostSpecs(state);
  const symbols = boundedAffectedSymbols(state);
  const expectedCorrelationId = preImplGroundingImpactCorrelationId(
    postSpecs.impact_queries.index,
  );

  // Result-processing FIRST (Phase 2 git-historian loop-ordering lesson).
  if (result?.kind === "tool_result" && result.correlation_id.startsWith(PRE_IMPL_GROUNDING_IMPACT_PREFIX)) {
    if (result.correlation_id !== expectedCorrelationId) {
      // Protocol violation: stale/mismatched correlation_id. Log and
      // re-issue the call for the CURRENT cursor position rather than
      // silently advancing on unrelated data (mirrors file-export.ts's
      // "unexpected result kind → re-issue" guard).
      return {
        state: appendError(
          state,
          `[pre_impl_grounding] unexpected correlation_id '${result.correlation_id}' (expected '${expectedCorrelationId}'); re-issuing`,
          "structural",
        ),
        action: emitImpactCall(state, postSpecs, symbols),
      };
    }

    const symbol = symbols[postSpecs.impact_queries.index];
    const entry: ImpactQueryResult = result.success
      ? { qualified_name: symbol, success: true, data: (result.data ?? {}) as Record<string, unknown> }
      : { qualified_name: symbol, success: false, error: result.error ?? "unknown" };

    const nextImpactQueries = {
      ...postSpecs.impact_queries,
      index: postSpecs.impact_queries.index + 1,
      results: [...postSpecs.impact_queries.results, entry],
    };
    let nextState: PipelineState = {
      ...state,
      post_specs: { ...postSpecs, impact_queries: nextImpactQueries },
    };
    if (!result.success) {
      nextState = appendError(
        nextState,
        `get_impact failed for '${symbol}': ${result.error ?? "unknown"}; continuing with partial grounding`,
        "upstream_failure",
      );
    }
    return {
      state: nextState,
      action: {
        kind: "emit_message",
        message: `Blast-radius grounding: ${symbol} (${nextImpactQueries.index}/${symbols.length}).`,
      },
    };
  }

  const graphPath = state.codebase_graph_path;

  // No graph, or no sidecar was exported (zero affected-symbol claims) →
  // skip cleanly (design §3 "no graph or empty sidecar → skip").
  if (!graphPath || !state.affected_symbols_path || symbols.length === 0) {
    return advanceToImplementation(
      {
        ...state,
        post_specs: {
          ...postSpecs,
          impact_queries: { ...postSpecs.impact_queries, done: true },
        },
      },
      technicalSpecDraftWithheld(state)
        ? "The Technical Specification section failed validation: its draft is withheld, " +
            "so no blast-radius grounding is queried. Proceeding to implementation."
        : "No affected-symbols grounding available. Proceeding to implementation.",
    );
  }

  if (postSpecs.impact_queries.index >= symbols.length) {
    return advanceToImplementation(
      {
        ...state,
        post_specs: {
          ...postSpecs,
          impact_queries: { ...postSpecs.impact_queries, done: true },
        },
      },
      `Pre-implementation grounding complete: ${symbols.length} symbol(s) queried. Proceeding to implementation.`,
    );
  }

  return {
    state: { ...state, post_specs: postSpecs },
    action: emitImpactCall(state, postSpecs, symbols),
  };
};

function emitImpactCall(
  state: PipelineState,
  postSpecs: PostSpecsState,
  symbols: readonly string[],
): { kind: "call_pipeline_tool"; tool_name: string; arguments: Record<string, unknown>; correlation_id: string } {
  const symbol = symbols[postSpecs.impact_queries.index];
  return {
    kind: "call_pipeline_tool",
    tool_name: "get_impact",
    arguments: {
      graph_path: state.codebase_graph_path,
      qualified_name: symbol,
    },
    correlation_id: preImplGroundingImpactCorrelationId(postSpecs.impact_queries.index),
  };
}
