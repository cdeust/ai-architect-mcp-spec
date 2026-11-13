/**
 * Input analysis — call ai-architect-mcp-codebase `analyze_codebase`, then
 * `prepare_prd_input` (FEATURE MODE) to ground the feature on the code graph.
 *
 * Tool contracts (source of truth: ai-architect-mcp-codebase/src/tool_schemas.rs,
 * verified against ai-architect-mcp-codebase/src/main.rs do_analyze_codebase,
 * 2026-07-13):
 *   analyze_codebase (Stage 3 — all-in-one: index_codebase + resolve_graph +
 *   cluster_graph in one call; tool_schemas.rs:522 analyze_codebase_schema):
 *     inputs:  { path, output_dir, language?, dependency_scope? }
 *     output:  { graph_path, index, resolve, cluster:{community_count,
 *                process_count, modularity} }   ← graph tools take graph_path
 *   prepare_prd_input (feature mode — no finding_id):
 *     inputs:  { feature_description, output_dir, graph_path }
 *     output:  prd_context { matched_symbols, impacted_communities,
 *                            impacted_processes, graph_stats, mode:"feature" }
 *
 * We deliberately call `analyze_codebase` rather than bare `index_codebase`:
 * `index_codebase` alone is Stage 3a ONLY (parse + build graph nodes/edges) —
 * it does NOT resolve call/import edges (Stage 3b) or detect communities/
 * processes (Stage 3c). Grounding via `prepare_prd_input` on an
 * index-only graph therefore returns impacted_community_count=0 and
 * impacted_process_count=0 regardless of the real codebase (measured
 * 2026-07-13, e2e run_mrjlmfh6_3tq3d4, cobaye repo graphify: 0/0 via
 * index_codebase vs 9 communities / 162 processes via analyze_codebase on
 * the same repo — see Cortex memory 4263670). `analyze_codebase` performs
 * index+resolve+cluster in one host round trip, which is also fewer
 * `call_pipeline_tool` hops than doing the three stages piecemeal.
 *
 * Two sequential host-driven calls, each following the established reducer
 * protocol (emit call_pipeline_tool → host runs it → result fed back via
 * tool_result → handler processes result.data):
 *   1. analyze_codebase        → sets codebase_graph_path / codebase_indexed
 *   2. prepare_prd_input        → sets codebase_grounding / prd_input_prepared
 * Only after BOTH complete does the step advance to feasibility_gate.
 *
 * The output_dir is derived from run_id so retries are idempotent and runs
 * do not collide. We write under <codebase_path>/.prd-gen/graphs/<run_id>/
 * by default; a real deployment may want to override via env var.
 *
 * Phase 2 (git-historian, 2026-07-14): once `prd_input_prepared` settles
 * (success OR advisory failure), and only when `state.codebase_path` is set,
 * this handler spawns `zetetic-team-subagents:git-historian` to mine the
 * codebase's version-control history BEFORE advancing to feasibility_gate.
 * The gate logic (completeCodebaseAnalysis / handleGitHistoryResult) is
 * extracted to ./input-analysis/git-history.ts — see that module's doc for
 * the full sequencing rationale and why it lives after grounding rather than
 * before/in-parallel with global recall or analyze_codebase.
 *
 * Git hygiene (defect found in the same e2e run, memory 4263670): a run
 * writes ~39MB of graph artifacts under <codebase_path>/.prd-gen/. That path
 * lives INSIDE the user's target repo and is not git-ignored by default —
 * left unaddressed it would pollute the user's `git status`/commits. This
 * handler is a pure reducer (StepHandler: state → {state, action}, no direct
 * fs access — see the module's layer contract in runner.ts) so it cannot
 * write the guard file itself; it emits a `write_file` action for
 * `.prd-gen/.gitignore` (content: `*`, the standard self-ignore pattern used
 * by `.next/`/`.turbo/`) THE SAME WAY file-export.ts writes PRD output files
 * — through the existing write_file/file_written port, executed by the host
 * (or canned-dispatcher.ts in tests). Idempotency is tracked in its own
 * `state.codebase_gitignore_written` flag rather than `state.written_files`:
 * that array is the PRD-deliverable ledger (pipeline-kpis.ts counts it as
 * `written_files_count`, expected to land on exactly the 9 PRD output
 * files) — folding an infrastructure guard file into it would silently
 * inflate that KPI. This write is emitted once, before the first
 * `analyze_codebase` call that would otherwise be the first thing to
 * populate `.prd-gen/`.
 */

import { join } from "node:path";
import type { StepHandler } from "../runner.js";
import { appendError, type PipelineState } from "../types/state.js";
import type { ActionResult, HandlerAction } from "../types/actions.js";
import { summarizeCortexRecall } from "./cortex-recall-summary.js";
import {
  completeCodebaseAnalysis,
  handleGitHistoryResult,
  isGitHistoryResult,
} from "./input-analysis/git-history.js";

const CORRELATION_ID = "input_analysis_index";
const PREPARE_CORRELATION_ID = "input_analysis_prepare_prd_input";
const GLOBAL_RECALL_CORRELATION_ID = "input_analysis_global_recall";

/**
 * source: reuses the per-section recall size (section-generation.ts
 * recallAction) for consistency — one Cortex recall query, same result
 * size, whether it is run-level or section-level. That size is a
 * provisional heuristic, as said there. Cross-audit code-reviewer H6
 * (Phase 3+4, 2026-04), reapplied at the global-recall call site Phase 1a
 * (2026-07-14).
 */
const GLOBAL_RECALL_MAX_RESULTS = 8;

/**
 * Phase 1a — global Cortex memory recall, ONE call per run, fired before any
 * codebase-specific or per-section work. Runs regardless of whether a
 * codebase_path is present, because memory recall is not code-graph
 * grounding — it is prior-run/decision context that applies to every PRD
 * context. Placed at the front of input_analysis (rather than in preflight)
 * to keep preflight strictly a liveness check (SRP — preflight's own module
 * doc scopes it to "verify required MCP servers are reachable"); this
 * handler already owns "build every kind of upstream context the pipeline
 * uses before section generation" (code-graph grounding via
 * analyze_codebase/prepare_prd_input below).
 *
 * precondition:  state.global_recall_done === false.
 * postcondition: either (a) a call_cortex_tool[recall] action with
 *                { query: feature_description, max_results }, leaving
 *                global_recall_done false (result sets it); or (b) once the
 *                result is processed, global_recall_done === true and
 *                control falls through to the existing codebase-analysis
 *                flow on the SAME step() call (no extra host round trip is
 *                spent just to re-enter this handler).
 *
 * A failed or empty recall is NOT a pipeline failure — Cortex memory is
 * best-effort context, exactly like the per-section recall it mirrors.
 * Failure/emptiness increments the existing `cortex_recall_empty_count`
 * counter (shared with the per-section path; both signal "a recall call
 * returned nothing") and appends an `upstream_failure` error on explicit
 * failure, but always proceeds.
 *
 * source: Phase 1a (2026-07-14) — Cortex memory-loop closure.
 */
function handleGlobalRecall(
  state: PipelineState,
  result: ActionResult | undefined,
): { state: PipelineState; action: HandlerAction } {
  if (
    result?.kind === "tool_result" &&
    result.correlation_id === GLOBAL_RECALL_CORRELATION_ID
  ) {
    if (!result.success) {
      const nextState = appendError(
        {
          ...state,
          global_recall_done: true,
          global_recall_summary: "",
          cortex_recall_empty_count: state.cortex_recall_empty_count + 1,
        },
        `global recall failed: ${result.error ?? "unknown"}; continuing without prior-run memory context`,
        "upstream_failure",
      );
      return continueAfterGlobalRecall(nextState);
    }
    const summary = summarizeCortexRecall(result.data);
    const nextState: PipelineState = {
      ...state,
      global_recall_done: true,
      global_recall_summary: summary,
      cortex_recall_empty_count:
        summary.length === 0
          ? state.cortex_recall_empty_count + 1
          : state.cortex_recall_empty_count,
    };
    return continueAfterGlobalRecall(nextState);
  }

  return {
    state,
    action: {
      kind: "call_cortex_tool",
      tool_name: "recall",
      arguments: {
        query: state.feature_description,
        max_results: GLOBAL_RECALL_MAX_RESULTS,
      },
      correlation_id: GLOBAL_RECALL_CORRELATION_ID,
    },
  };
}

/**
 * Fall through into the pre-existing codebase-analysis flow on the same
 * step() call, now that global_recall_done is true. Kept as a named seam
 * (rather than inlining a recursive call to the exported handler) so the
 * control flow reads as "recall, THEN codebase analysis" rather than an
 * opaque self-recursion.
 */
function continueAfterGlobalRecall(state: PipelineState): {
  state: PipelineState;
  action: HandlerAction;
} {
  return handleCodebaseAnalysis(state, undefined);
}

/**
 * Self-ignore pattern for the `.prd-gen/` artifact directory. `*` inside
 * `.prd-gen/.gitignore` ignores every file in that directory, including the
 * `.gitignore` file itself (mirrors the `.next/`/`.turbo/` convention) — so
 * the ~39MB of graph artifacts a run produces never shows up in the user's
 * `git status`. source: standard build-tool self-ignore idiom (Next.js
 * `.next/`, Turborepo `.turbo/`); no numeric constant to cite.
 */
const GITIGNORE_CONTENT = "*\n";

function deriveOutputDir(codebasePath: string, runId: string): string {
  return join(codebasePath, ".prd-gen", "graphs", runId);
}

function deriveGitignorePath(codebasePath: string): string {
  return join(codebasePath, ".prd-gen", ".gitignore");
}

/**
 * Emit the `prepare_prd_input` (feature-mode) grounding call, OR skip it
 * gracefully and advance when grounding is impossible.
 *
 * precondition:  state.codebase_indexed && state.codebase_graph_path set;
 *                state.prd_input_prepared === false.
 * postcondition: either (a) a call_pipeline_tool[prepare_prd_input] action
 *                with { feature_description, output_dir, graph_path }, leaving
 *                prd_input_prepared false (result will set it); or (b) when
 *                there is no usable feature_description, prd_input_prepared is
 *                set true and current_step advances to feasibility_gate with
 *                grounding left null — preserving the no-grounding behavior.
 */
function emitPrepare(state: PipelineState): {
  state: PipelineState;
  action: HandlerAction;
} {
  const featureDescription = state.feature_description.trim();
  const graphPath = state.codebase_graph_path;

  // No feature text to ground, or graph missing → skip grounding, advance
  // (subject to the git-historian gate — see completeCodebaseAnalysis).
  // (graphPath is non-null by precondition; the guard keeps the type narrow.)
  if (!featureDescription || !graphPath) {
    return completeCodebaseAnalysis(
      { ...state, prd_input_prepared: true },
      "No feature description to ground; skipping code-graph grounding.",
    );
  }

  const outputDir =
    state.codebase_output_dir ??
    deriveOutputDir(state.codebase_path!, state.run_id);

  return {
    state: { ...state, codebase_output_dir: outputDir },
    action: {
      kind: "call_pipeline_tool",
      tool_name: "prepare_prd_input",
      // Feature mode: no finding_id. AP grounds the free text on the graph.
      arguments: {
        feature_description: featureDescription,
        output_dir: outputDir,
        graph_path: graphPath,
      },
      correlation_id: PREPARE_CORRELATION_ID,
    },
  };
}

/**
 * Emit the `analyze_codebase` call (index + resolve + cluster in one host
 * round trip — see the module doc for why this replaces bare
 * `index_codebase`).
 *
 * precondition:  state.codebase_path is set; the `.prd-gen/.gitignore`
 *                write has already been recorded
 *                (state.codebase_gitignore_written === true — callers must
 *                check that before invoking this).
 * postcondition: a call_pipeline_tool[analyze_codebase] action with
 *                { path, output_dir, language: "auto" }, correlation_id
 *                CORRELATION_ID. state.codebase_output_dir is set (computed
 *                once, reused on retries so runs are idempotent).
 */
function emitAnalyze(state: PipelineState): {
  state: PipelineState;
  action: HandlerAction;
} {
  const outputDir =
    state.codebase_output_dir ??
    deriveOutputDir(state.codebase_path!, state.run_id);

  return {
    state: { ...state, codebase_output_dir: outputDir },
    action: {
      kind: "call_pipeline_tool",
      tool_name: "analyze_codebase",
      arguments: {
        path: state.codebase_path,
        output_dir: outputDir,
        language: "auto",
      },
      correlation_id: CORRELATION_ID,
    },
  };
}

export const handleInputAnalysis: StepHandler = ({ state, result }) => {
  // Phase 1a — global memory recall fires exactly once per run, before any
  // codebase-specific work, regardless of whether a codebase_path exists.
  if (!state.global_recall_done) {
    return handleGlobalRecall(state, result);
  }
  return handleCodebaseAnalysis(state, result);
};

function handleCodebaseAnalysis(
  state: PipelineState,
  result: ActionResult | undefined,
): { state: PipelineState; action: HandlerAction } {
  // No codebase → skip indexing entirely.
  if (!state.codebase_path) {
    return {
      state: { ...state, current_step: "feasibility_gate" },
      action: {
        kind: "emit_message",
        message: "No codebase provided. Skipping codebase analysis.",
      },
    };
  }

  // Result of the git-historian investigation spawn (Phase 2). MUST be
  // checked BEFORE the state-only "both phases done" guard below — that
  // guard fires whenever codebase_indexed/graph_path/prd_input_prepared are
  // already true (which they are by the time this spawn's result comes
  // back), and does not itself inspect `result`. Checking the result first
  // ensures a returning subagent_batch_result is consumed exactly once
  // rather than being ignored while the guard re-emits the same spawn
  // forever. See ./input-analysis/git-history.ts for the gate logic.
  if (isGitHistoryResult(result)) {
    return handleGitHistoryResult(state, result);
  }

  // Both phases done (index + grounding) → move on, subject to the
  // git-historian gate (completeCodebaseAnalysis). Guard placed BEFORE the
  // remaining result-routing blocks so a replayed terminal state advances
  // idempotently without re-issuing any of the three calls.
  if (
    state.codebase_indexed &&
    state.codebase_graph_path &&
    state.prd_input_prepared
  ) {
    return completeCodebaseAnalysis(
      state,
      `Codebase analysis ready (graph: ${state.codebase_graph_path}).`,
    );
  }

  // Result of a prepare_prd_input (feature-mode grounding) call. Process its
  // result.data, store the grounding, set the idempotency flag, and advance.
  if (
    result?.kind === "tool_result" &&
    result.correlation_id === PREPARE_CORRELATION_ID
  ) {
    if (!result.success) {
      // Grounding is best-effort: the PRD can still be generated without it.
      // Treat AP failure as an upstream issue, flag prepared so we do not
      // loop, and advance (subject to the git-historian gate) rather than
      // failing the whole pipeline.
      return completeCodebaseAnalysis(
        {
          ...appendError(
            state,
            `prepare_prd_input failed: ${result.error ?? "unknown"}; continuing without code-graph grounding`,
            "upstream_failure",
          ),
          prd_input_prepared: true,
        },
        "Code-graph grounding unavailable; proceeding without it.",
        "warn",
      );
    }
    // AP feature mode wraps the grounding in `prd_context`; tolerate a flat
    // payload too (the orchestration layer does not parse the shape further).
    const data = (result.data ?? {}) as {
      prd_context?: Record<string, unknown>;
    };
    const grounding: Record<string, unknown> =
      data.prd_context ?? (result.data as Record<string, unknown>) ?? {};
    return completeCodebaseAnalysis(
      { ...state, codebase_grounding: grounding, prd_input_prepared: true },
      "Feature grounded on code graph.",
    );
  }

  // Result of an analyze_codebase call.
  if (result?.kind === "tool_result" && result.correlation_id === CORRELATION_ID) {
    if (!result.success) {
      return {
        state: appendError(
          state,
          `analyze_codebase failed: ${result.error ?? "unknown"}`,
          // External tool failure — the pipeline gives up but it's not a
          // handler bug. Cross-audit curie H1 (Phase 3+4 follow-up).
          "upstream_failure",
        ),
        action: {
          kind: "failed",
          reason: `analyze_codebase failed: ${result.error ?? "unknown"}`,
          step: "input_analysis",
        },
      };
    }
    const data = (result.data ?? {}) as { graph_path?: string };
    const graphPath = data.graph_path ?? null;
    if (!graphPath) {
      return {
        state: appendError(
          state,
          `analyze_codebase succeeded but returned no graph_path`,
          // The upstream tool advertised success but violated its own
          // contract. From the orchestration layer's perspective this
          // is the SAME class as the explicit-failure case above —
          // a tool we can't act on. Tag it as upstream_failure so the
          // structural gate doesn't conflate this with a handler bug.
          "upstream_failure",
        ),
        action: {
          kind: "failed",
          reason: "analyze_codebase returned no graph_path",
          step: "input_analysis",
        },
      };
    }
    // Indexed+resolved+clustered — do NOT advance yet. Record the graph,
    // then fall through to the prepare_prd_input emission below
    // (state.codebase_graph_path is now set, state.prd_input_prepared is
    // still false).
    return emitPrepare({
      ...state,
      codebase_indexed: true,
      codebase_graph_path: graphPath,
    });
  }

  // Index already done but grounding not yet prepared (e.g. fresh entry with a
  // pre-indexed codebase, or replay after the index step). Emit prepare.
  if (
    state.codebase_indexed &&
    state.codebase_graph_path &&
    !state.prd_input_prepared
  ) {
    return emitPrepare(state);
  }

  // Result of the `.prd-gen/.gitignore` write. Record it in its own
  // idempotency flag (NOT written_files — see module doc) and fall through
  // to trigger analyze_codebase now that the artifact directory is guarded.
  if (
    result?.kind === "file_written" &&
    result.path === deriveGitignorePath(state.codebase_path) &&
    !state.codebase_gitignore_written
  ) {
    return emitAnalyze({ ...state, codebase_gitignore_written: true });
  }

  // Not yet indexed and the gitignore guard hasn't been written this run —
  // write it FIRST so `.prd-gen/` never has a window where it could show up
  // untracked in the user's `git status` before analyze_codebase populates it.
  if (!state.codebase_gitignore_written) {
    return {
      state,
      action: {
        kind: "write_file",
        path: deriveGitignorePath(state.codebase_path),
        content: GITIGNORE_CONTENT,
      },
    };
  }

  // Guard already written this run (e.g. replay after a analyze_codebase
  // failure was retried) — trigger the analyze_codebase call directly.
  return emitAnalyze(state);
}
