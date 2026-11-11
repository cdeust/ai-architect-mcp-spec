/**
 * input_analysis Phase 1a — global Cortex memory recall.
 *
 * Proves:
 *   1. On first entry to input_analysis, the handler emits
 *      call_cortex_tool[recall] with { query: feature_description,
 *      max_results }, BEFORE any codebase-specific work (gitignore write /
 *      analyze_codebase), regardless of whether codebase_path is set.
 *   2. A successful non-empty result stores global_recall_summary and sets
 *      global_recall_done, then falls through to the existing
 *      codebase-analysis flow on the SAME step() call.
 *   3. An empty result (Cortex reachable, zero hits) sets
 *      global_recall_summary = "" and increments cortex_recall_empty_count —
 *      the SAME counter the per-section recall path uses — without failing
 *      the run.
 *   4. A failed result (Cortex unreachable) records an upstream_failure
 *      error, still increments cortex_recall_empty_count, sets
 *      global_recall_done, and the run proceeds (degrades gracefully).
 *   5. global_recall_done=true (replay) skips straight to the
 *      codebase-analysis flow — the recall call fires exactly once per run.
 *
 * source: Phase 1a (2026-07-14) — Cortex memory-loop closure.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newPipelineState, step, type PipelineState } from "../index.js";

/** Must match input-analysis.ts:GLOBAL_RECALL_CORRELATION_ID. */
const GLOBAL_RECALL_CORRELATION_ID = "input_analysis_global_recall";

function stateAtInputAnalysis(opts: {
  codebasePath?: string | null;
  feature?: string;
}): PipelineState {
  const s = newPipelineState({
    run_id: "global_recall_001",
    feature_description: opts.feature ?? "build OAuth login",
    codebase_path: opts.codebasePath ?? null,
    skip_preflight: true,
  });
  // Position state as if context_detection already ran (a real run always
  // passes through it before input_analysis) — otherwise downstream
  // handlers (clarification) fail on "reached without PRD context" for a
  // reason unrelated to Phase 1a, which these tests do not exercise.
  return { ...s, current_step: "input_analysis", prd_context: "feature" };
}

describe("input_analysis Phase 1a — global recall (nominal)", () => {
  it("emits call_cortex_tool[recall] BEFORE any codebase work, query = feature_description", () => {
    const s = stateAtInputAnalysis({ codebasePath: "/tmp/global-recall" });
    const out = step({ state: s });

    expect(out.action.kind).toBe("call_cortex_tool");
    if (out.action.kind !== "call_cortex_tool") return;
    expect(out.action.tool_name).toBe("recall");
    expect(out.action.correlation_id).toBe(GLOBAL_RECALL_CORRELATION_ID);
    expect(out.action.arguments).toHaveProperty("query", "build OAuth login");
    // source: reuses the section-level recall budget (8) for consistency —
    // see input-analysis.ts:GLOBAL_RECALL_MAX_RESULTS.
    expect(out.action.arguments).toHaveProperty("max_results", 8);
    // Not yet consumed the .prd-gen/.gitignore write or analyze_codebase.
    expect(out.state.global_recall_done).toBe(false);
    expect(out.state.codebase_gitignore_written).toBe(false);
  });

  it("fires even with no codebase_path (memory recall is not code-graph grounding)", () => {
    const s = stateAtInputAnalysis({ codebasePath: null });
    const out = step({ state: s });
    expect(out.action.kind).toBe("call_cortex_tool");
    if (out.action.kind !== "call_cortex_tool") return;
    expect(out.action.tool_name).toBe("recall");
  });

  it("non-empty result stores the summary and falls through to the codebase flow", () => {
    const issued = step({ state: stateAtInputAnalysis({ codebasePath: "/tmp/gr2" }) });
    const cid =
      issued.action.kind === "call_cortex_tool" ? issued.action.correlation_id : "";
    const out = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: cid,
        success: true,
        data: { results: [{ content: "prior decision: use JWT" }], total: 1 },
      },
    });

    expect(out.state.global_recall_done).toBe(true);
    expect(out.state.global_recall_summary).toContain("prior decision: use JWT");
    expect(out.state.cortex_recall_empty_count).toBe(0);
    // Fell through on the SAME step() call — no extra host round trip spent
    // just to re-enter input_analysis. Next action is the codebase flow.
    expect(out.action.kind).toBe("write_file");
    if (out.action.kind === "write_file") {
      expect(out.action.path).toBe(join("/tmp/gr2", ".prd-gen", ".gitignore"));
    }
  });

  it("replay (global_recall_done already true) skips straight to the codebase flow", () => {
    const s: PipelineState = {
      ...stateAtInputAnalysis({ codebasePath: "/tmp/gr3" }),
      global_recall_done: true,
      global_recall_summary: "prior summary",
    };
    const out = step({ state: s });
    expect(out.action.kind).toBe("write_file");
  });
});

describe("input_analysis Phase 1a — global recall (empty result)", () => {
  it("empty results array: summary is '', cortex_recall_empty_count increments, run proceeds", () => {
    const issued = step({ state: stateAtInputAnalysis({ codebasePath: null }) });
    const cid =
      issued.action.kind === "call_cortex_tool" ? issued.action.correlation_id : "";
    const out = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: cid,
        success: true,
        data: { results: [], total: 0 },
      },
    });

    expect(out.state.global_recall_done).toBe(true);
    expect(out.state.global_recall_summary).toBe("");
    expect(out.state.cortex_recall_empty_count).toBe(1);
    // No codebase_path → falls through past codebase analysis into
    // feasibility_gate, which itself coalesces (no epic signals in the
    // fixture feature text) straight through to clarification's first
    // substantive action — step() never stops at an intermediate
    // emit_message hop.
    expect(out.action.kind).not.toBe("failed");
    expect(out.state.current_step).toBe("clarification");
    expect(out.state.errors.length).toBe(0);
  });
});

describe("input_analysis Phase 1a — global recall (Cortex unavailable)", () => {
  it("failed recall: records upstream_failure, still proceeds, never blocks the run", () => {
    const issued = step({ state: stateAtInputAnalysis({ codebasePath: null }) });
    const cid =
      issued.action.kind === "call_cortex_tool" ? issued.action.correlation_id : "";
    const out = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: cid,
        success: false,
        data: null,
        error: "cortex MCP unreachable",
      },
    });

    expect(out.state.global_recall_done).toBe(true);
    expect(out.state.global_recall_summary).toBe("");
    expect(out.state.cortex_recall_empty_count).toBe(1);
    expect(
      out.state.errors.some((e) => e.includes("global recall failed")),
    ).toBe(true);
    expect(
      out.state.error_kinds[out.state.errors.length - 1],
    ).toBe("upstream_failure");
    // The run is NOT failed — it proceeds past input_analysis, feasibility_gate,
    // and straight into clarification's first substantive action (see the
    // empty-result test above for why current_step lands on "clarification").
    expect(out.action.kind).not.toBe("failed");
    expect(out.state.current_step).toBe("clarification");
  });
});
