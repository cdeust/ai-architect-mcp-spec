import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newPipelineState, step } from "../index.js";

// These tests exercise the runner downstream of `preflight` — they assume
// the Cortex / ai-architect probes have already passed. Use skip_preflight
// so the runner advances straight to context_detection.
const seed = (codebasePath?: string) =>
  newPipelineState({
    run_id: "test_run_001",
    feature_description: "build a feature for OAuth login",
    codebase_path: codebasePath ?? null,
    skip_preflight: true,
  });

/** Must match input-analysis.ts:GLOBAL_RECALL_CORRELATION_ID. */
const GLOBAL_RECALL_CORRELATION_ID = "input_analysis_global_recall";

/** Must match protocol-ids.ts:GIT_HISTORY_INV_ID. */
const GIT_HISTORY_INV_ID = "input_analysis_git_history";

/**
 * Drive a {state, action} pair where action is the git-historian
 * spawn_subagents (Phase 2 — the gate on top of prd_input_prepared) through
 * a canned successful investigation, returning the resulting {state, action}
 * at the point input_analysis advances to feasibility_gate/clarification.
 */
function resolveGitHistory(out: ReturnType<typeof step>) {
  expect(out.action.kind).toBe("spawn_subagents");
  const batch_id =
    out.action.kind === "spawn_subagents" ? out.action.batch_id : "";
  expect(batch_id).toBe(GIT_HISTORY_INV_ID);
  return step({
    state: out.state,
    result: {
      kind: "subagent_batch_result",
      batch_id,
      responses: [
        {
          invocation_id: GIT_HISTORY_INV_ID,
          raw_text: "History is silent within the searched space (canned).",
        },
      ],
    },
  });
}

/**
 * Drive a fresh state past input_analysis's Phase 1a global recall (the
 * FIRST substantive action input_analysis emits, before any codebase or
 * clarification work) and return the resulting {state, action} at the same
 * point the pre-Phase-1a tests below assumed as their starting position.
 */
function issueGlobalRecall(codebasePath?: string) {
  const out = step({ state: seed(codebasePath) });
  expect(out.action.kind).toBe("call_cortex_tool");
  const correlation_id =
    out.action.kind === "call_cortex_tool" ? out.action.correlation_id : "";
  expect(correlation_id).toBe(GLOBAL_RECALL_CORRELATION_ID);
  return step({
    state: out.state,
    result: {
      kind: "tool_result",
      correlation_id,
      success: true,
      data: { results: [], total: 0 },
    },
  });
}

describe("pipeline runner — emit_message coalescing", () => {
  it("first step() never returns emit_message as the action kind", () => {
    const out = step({ state: seed() });
    expect(out.action.kind).not.toBe("emit_message");
  });

  it("first step() returns at least one coalesced message (welcome banner)", () => {
    const out = step({ state: seed() });
    expect(out.messages.length).toBeGreaterThan(0);
    expect(out.messages[0].text).toContain("PRD Spec Generator");
  });

  it("auto-detected feature context advances past context_detection in one step", () => {
    const afterRecall = issueGlobalRecall();
    // 'build OAuth login' → trigger 'build' → feature → input_analysis (no codebase, global recall resolved) → feasibility_gate → clarification compose action
    expect(afterRecall.state.prd_context).toBe("feature");
    expect(afterRecall.state.global_recall_done).toBe(true);
    expect(afterRecall.state.current_step).toBe("clarification");
    // First clarification action: spawn engineer to compose the question
    expect(afterRecall.action.kind).toBe("spawn_subagents");
  });

  it("input_analysis with codebase first writes the .prd-gen/.gitignore guard", () => {
    const out = issueGlobalRecall("/some/path");
    expect(out.state.global_recall_done).toBe(true);
    expect(out.action.kind).toBe("write_file");
    if (out.action.kind === "write_file") {
      expect(out.action.path).toBe(join("/some/path", ".prd-gen", ".gitignore"));
      expect(out.action.content).toBe("*\n");
    }
  });

  it("input_analysis: after the gitignore write, yields a call_pipeline_tool action with analyze_codebase", () => {
    const written = issueGlobalRecall("/some/path");
    const gitignorePath =
      written.action.kind === "write_file" ? written.action.path : "";
    const out = step({
      state: written.state,
      result: { kind: "file_written", path: gitignorePath, bytes: 2 },
    });
    expect(out.state.codebase_gitignore_written).toBe(true);
    // The gitignore guard is NOT a PRD deliverable — must not pollute the
    // written_files ledger pipeline-kpis.ts counts as written_files_count.
    expect(out.state.written_files).not.toContain(gitignorePath);
    expect(out.action.kind).toBe("call_pipeline_tool");
    if (out.action.kind === "call_pipeline_tool") {
      expect(out.action.tool_name).toBe("analyze_codebase");
      expect(out.action.arguments).toHaveProperty("path", "/some/path");
      expect(out.action.arguments).toHaveProperty("output_dir");
    }
  });

  /**
   * Drive input_analysis past the gitignore-write step and return the
   * resulting {state, action} where action is the analyze_codebase
   * call_pipeline_tool. Shared by the tests below so each one only asserts
   * on the behaviour it's named for.
   */
  function issueAnalyze(codebasePath: string) {
    const written = issueGlobalRecall(codebasePath);
    const gitignorePath =
      written.action.kind === "write_file" ? written.action.path : "";
    return step({
      state: written.state,
      result: { kind: "file_written", path: gitignorePath, bytes: 2 },
    });
  }

  it("input_analysis: analyze_codebase success emits prepare_prd_input (feature mode) before advancing", () => {
    const issued = issueAnalyze("/x");
    expect(issued.state.codebase_output_dir).not.toBeNull();
    const correlation_id =
      issued.action.kind === "call_pipeline_tool"
        ? issued.action.correlation_id
        : "";
    const afterIndex = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id,
        success: true,
        data: { graph_path: "/x/.prd-gen/graphs/test_run_001/graph" },
      },
    });
    // Graph recorded but step has NOT advanced — it now emits the grounding call.
    expect(afterIndex.state.codebase_indexed).toBe(true);
    expect(afterIndex.state.codebase_graph_path).toBe(
      "/x/.prd-gen/graphs/test_run_001/graph",
    );
    expect(afterIndex.state.prd_input_prepared).toBe(false);
    expect(afterIndex.state.current_step).toBe("input_analysis");
    expect(afterIndex.action.kind).toBe("call_pipeline_tool");
    if (afterIndex.action.kind === "call_pipeline_tool") {
      expect(afterIndex.action.tool_name).toBe("prepare_prd_input");
      // Feature mode: free-text feature + graph, no finding_id.
      expect(afterIndex.action.arguments).toHaveProperty("feature_description");
      expect(afterIndex.action.arguments).not.toHaveProperty("finding_id");
      expect(afterIndex.action.arguments).toHaveProperty(
        "graph_path",
        "/x/.prd-gen/graphs/test_run_001/graph",
      );
      expect(afterIndex.action.arguments).toHaveProperty("output_dir");
    }
  });

  it("input_analysis: prepare_prd_input result stores grounding then advances to clarification compose", () => {
    const issued = issueAnalyze("/x");
    const indexCid =
      issued.action.kind === "call_pipeline_tool"
        ? issued.action.correlation_id
        : "";
    const afterIndex = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: indexCid,
        success: true,
        data: { graph_path: "/x/.prd-gen/graphs/test_run_001/graph" },
      },
    });
    const prepareCid =
      afterIndex.action.kind === "call_pipeline_tool"
        ? afterIndex.action.correlation_id
        : "";
    const grounding = {
      matched_symbols: [{ fqn: "auth::login" }],
      impacted_communities: [1],
      impacted_processes: [],
      graph_stats: { nodes: 10 },
      mode: "feature",
    };
    const after = step({
      state: afterIndex.state,
      result: {
        kind: "tool_result",
        correlation_id: prepareCid,
        success: true,
        // AP feature mode wraps the grounding in `prd_context`.
        data: { prd_context: grounding },
      },
    });
    expect(after.state.prd_input_prepared).toBe(true);
    expect(after.state.codebase_grounding).toEqual(grounding);
    // prd_context (the PRD-kind enum) must NOT be clobbered by grounding.
    expect(after.state.prd_context).toBe("feature");
    // Grounding settled but git-historian gate has not yet been resolved —
    // still on input_analysis, next action is the git-historian spawn.
    expect(after.state.current_step).toBe("input_analysis");
    const afterGitHistory = resolveGitHistory(after);
    expect(afterGitHistory.state.git_history_done).toBe(true);
    expect(afterGitHistory.state.current_step).toBe("clarification");
    expect(afterGitHistory.action.kind).toBe("spawn_subagents");
  });

  it("input_analysis: prepare_prd_input failure is advisory — advances without grounding", () => {
    const issued = issueAnalyze("/x");
    const indexCid =
      issued.action.kind === "call_pipeline_tool"
        ? issued.action.correlation_id
        : "";
    const afterIndex = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: indexCid,
        success: true,
        data: { graph_path: "/x/g" },
      },
    });
    const prepareCid =
      afterIndex.action.kind === "call_pipeline_tool"
        ? afterIndex.action.correlation_id
        : "";
    const after = step({
      state: afterIndex.state,
      result: {
        kind: "tool_result",
        correlation_id: prepareCid,
        success: false,
        data: null,
        error: "graph unreadable",
      },
    });
    expect(after.state.prd_input_prepared).toBe(true);
    expect(after.state.codebase_grounding).toBeNull();
    // Advisory prepare_prd_input failure still routes through the
    // git-historian gate before advancing — same as the success path.
    expect(after.state.current_step).toBe("input_analysis");
    const afterGitHistory = resolveGitHistory(after);
    expect(afterGitHistory.state.git_history_done).toBe(true);
    expect(afterGitHistory.state.current_step).toBe("clarification");
    expect(afterGitHistory.action.kind).toBe("spawn_subagents");
  });

  it("section_generation fails fast if prd_context is null", () => {
    const s = newPipelineState({
      run_id: "x",
      feature_description: "x",
    });
    const forced = { ...s, current_step: "section_generation" as const };
    const out = step({ state: forced });
    expect(out.action.kind).toBe("failed");
  });

  it("budget step refuses to advance without proceed_signal", () => {
    const s = newPipelineState({
      run_id: "x",
      feature_description: "x",
    });
    const forced = { ...s, current_step: "budget" as const };
    const out = step({ state: forced });
    expect(out.action.kind).toBe("failed");
  });

  it("budget step with proceed_signal coalesces past budget into section_generation", () => {
    const s = newPipelineState({
      run_id: "x",
      feature_description: "x",
    });
    const forced = {
      ...s,
      current_step: "budget" as const,
      proceed_signal: true,
      prd_context: "feature" as const,
    };
    const out = step({ state: forced });
    // Coalesces budget message → section_generation needs codebase recall
    expect(out.state.current_step).toBe("section_generation");
    expect(out.action.kind).toBe("call_cortex_tool");
    // The step allocates nothing and does not say it does (#120); the recall
    // that follows asks what the pipeline asks for every section.
    expect(out.messages.map((m) => m.text)).toEqual(["Starting section generation."]);
    expect(out.action.kind === "call_cortex_tool" ? out.action.arguments : null).toMatchObject({ max_results: 8 });
  });

  it("failed action surfaces in messages even when emit_message coalesces", () => {
    const s = newPipelineState({
      run_id: "x",
      feature_description: "x",
    });
    const forced = { ...s, current_step: "section_generation" as const };
    const out = step({ state: forced });
    // failed action does NOT coalesce — it's a terminal action.
    expect(out.action.kind).toBe("failed");
    if (out.action.kind === "failed") {
      expect(out.action.step).toBe("section_generation");
    }
  });
});
