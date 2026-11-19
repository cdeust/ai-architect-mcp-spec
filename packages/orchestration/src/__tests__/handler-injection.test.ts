import { describe, expect, it } from "vitest";
import { newPipelineState, type ActionResult, type PipelineState } from "../index.js";
import { stepOnce } from "./helpers/step-once.js";

describe("jira_generation", () => {
  it("is skipped when no source sections have content", () => {
    // Postcondition: handleJiraGeneration emits emit_message("No source sections")
    // and advances to file_export when requirements/user_stories/acceptance_criteria
    // are all absent. Exercised by driving the state machine with all sections
    // in 'failed' status so no content field is set.
    const baseState = newPipelineState({
      run_id: "inj_jira_skip",
      feature_description: "build a feature for OAuth login",
    });
    const noContentState: PipelineState = {
      ...baseState,
      current_step: "jira_generation",
      prd_context: "feature",
      proceed_signal: true,
      sections: [
        {
          section_type: "requirements",
          status: "failed",
          attempt: 3,
          violation_count: 1,
          last_violations: ["too short"],
          // No content field → gatherSourceSections filters it out
        },
      ],
    };

    const out = stepOnce(noContentState);
    expect(out.action.kind).not.toBe("spawn_subagents");
    expect(out.state.current_step).not.toBe("jira_generation");
  });
});

describe("input_analysis", () => {
  it("emits failed when analyze_codebase returns success:false", () => {
    const baseState = newPipelineState({
      run_id: "inj_index_failure",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/inj",
    });
    const awaitingResult: PipelineState = {
      ...baseState,
      current_step: "input_analysis",
      // Phase 1a global recall already resolved — position the state past
      // it so this injection targets the codebase-analysis branch only.
      global_recall_done: true,
      codebase_output_dir: "/tmp/inj/.prd-gen/graphs/inj_index_failure",
    };
    const failedToolResult: ActionResult = {
      kind: "tool_result",
      correlation_id: "input_analysis_index",
      success: false,
      error: "disk quota exceeded",
    };

    const out = stepOnce(awaitingResult, failedToolResult);
    expect(out.action.kind).toBe("failed");
    if (out.action.kind === "failed") {
      expect(out.action.reason).toContain("disk quota exceeded");
      expect(out.action.step).toBe("input_analysis");
    }
  });

  it("emits failed when analyze_codebase returns no graph_path", () => {
    const baseState = newPipelineState({
      run_id: "inj_no_graph_path",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/inj",
    });
    const awaitingResult: PipelineState = {
      ...baseState,
      current_step: "input_analysis",
      global_recall_done: true,
      codebase_output_dir: "/tmp/inj/.prd-gen/graphs/inj_no_graph_path",
    };
    const missingGraphPath: ActionResult = {
      kind: "tool_result",
      correlation_id: "input_analysis_index",
      success: true,
      data: {},
    };

    const out = stepOnce(awaitingResult, missingGraphPath);
    expect(out.action.kind).toBe("failed");
    if (out.action.kind === "failed") {
      expect(out.action.reason).toContain("graph_path");
    }
  });
});

describe("file_export protocol violation", () => {
  it("logs error and re-issues write when host sends wrong result kind", () => {
    const baseState = newPipelineState({
      run_id: "inj_file_export_wrong_result",
      feature_description: "build a feature for OAuth login",
    });
    const exportState: PipelineState = {
      ...baseState,
      current_step: "file_export",
      prd_context: "feature",
      proceed_signal: true,
      sections: [],
      written_files: [],
    };
    const wrongKindResult: ActionResult = {
      kind: "tool_result",
      correlation_id: "irrelevant",
      success: true,
      data: {},
    };

    const out = stepOnce(exportState, wrongKindResult);
    expect(out.action.kind).toBe("write_file");
    expect(out.state.errors.length).toBeGreaterThan(0);
    expect(out.state.errors[0]).toContain("unexpected result kind");
  });
});

describe("section_generation retry", () => {
  it("retries on validation failure and increments attempt", () => {
    // Postcondition: when validateSection returns violations on the draft,
    // the handler increments `attempt` and re-spawns the engineer with the
    // violations passed in as `prior_violations`. We exercise the retry
    // once (attempt 1 → 2), not the full MAX_ATTEMPTS loop.
    const seed = newPipelineState({
      run_id: "inj_section_retry",
      feature_description: "build a feature for OAuth login",
    });
    const stateMidSection: PipelineState = {
      ...seed,
      current_step: "section_generation",
      prd_context: "feature",
      proceed_signal: true,
      sections: [
        {
          section_type: "requirements",
          status: "generating",
          attempt: 1,
          violation_count: 0,
          last_violations: [],
        },
      ],
    };

    // Feed a draft that triggers fr_numbering_gaps: FR-001 then jumps to FR-099.
    const draftWithGap =
      "## Requirements\n\n" +
      "| ID | Requirement | Priority | Source |\n" +
      "|----|-------------|----------|--------|\n" +
      "| FR-001 | OAuth login | P0 | user request |\n" +
      "| FR-099 | password reset | P1 | clarification round 1 |\n";

    const out = stepOnce(stateMidSection, {
      kind: "subagent_batch_result",
      batch_id: "section_generate_requirements",
      responses: [
        {
          invocation_id: "section_generate_requirements",
          raw_text: draftWithGap,
        },
      ],
    });

    const section = out.state.sections.find(
      (s) => s.section_type === "requirements",
    );
    expect(section).toBeDefined();
    if (!section) return;
    expect(section.status).toBe("generating");
    expect(section.attempt).toBeGreaterThan(1);
    expect(section.last_violations.length).toBeGreaterThan(0);
    expect(section.last_violations.join(" ")).toContain("fr_numbering_gaps");
    expect(out.action.kind).toBe("spawn_subagents");
  });
});

describe("banner", () => {
  // Cross-audit closure (test-engineer H3, Phase 3+4 follow-up, 2026-04).
  // Pre-fix the handler had zero direct tests; only smoke runs exercised it
  // and they asserted nothing about the emitted message.

  it("emits the banner and advances to preflight", () => {
    const seed = newPipelineState({
      run_id: "inj_banner_run",
      feature_description: "x",
    });
    const out = stepOnce({ ...seed, current_step: "banner" });
    expect(out.state.current_step).toBe("preflight");
    const allText = out.messages.map((m) => m.text).join("\n");
    expect(allText).toContain("PRD Spec Generator");
    expect(allText).toContain("inj_banner_run");
  });

  it("includes the run_id and the feature description in the banner", () => {
    const seed = newPipelineState({
      run_id: "inj_banner_meta",
      feature_description: "build OAuth login",
    });
    const out = stepOnce({ ...seed, current_step: "banner" });
    const allText = out.messages.map((m) => m.text).join("\n");
    expect(allText).toContain("inj_banner_meta");
    expect(allText).toContain("build OAuth login");
  });

  it("notes when no codebase path is provided", () => {
    const seed = newPipelineState({
      run_id: "inj_banner_no_codebase",
      feature_description: "x",
    });
    const out = stepOnce({ ...seed, current_step: "banner" });
    const allText = out.messages.map((m) => m.text).join("\n");
    expect(allText).toContain("Codebase: (none provided)");
  });
});

describe("clarification proceed branch", () => {
  // Cross-audit closure (test-engineer H4, Phase 3+4 follow-up, 2026-04).
  // The proceed/continue conditional in clarification.ts:138 was previously
  // exercised only by smoke runs. A mutation swapping "proceed" with
  // "continue" in the match would survive outside smoke. Direct injection
  // pins the branch.

  it("clarification_continue with selected: ['proceed'] sets proceed_signal=true and advances", () => {
    const seed = newPipelineState({
      run_id: "inj_clar_proceed",
      feature_description: "build OAuth login",
    });
    const stateAtClarification: PipelineState = {
      ...seed,
      current_step: "clarification",
      prd_context: "feature",
      // Pretend we already collected enough rounds that the "proceed" prompt
      // is the next action — feed the user_answer directly.
      clarifications: Array.from({ length: 8 }, (_, i) => ({
        round: i + 1,
        question: `q${i + 1}`,
        rationale: "test",
        answer: `a${i + 1}`,
      })),
    };

    const out = stepOnce(stateAtClarification, {
      kind: "user_answer",
      question_id: "clarification_continue",
      selected: ["proceed"],
    });

    // Postcondition: proceed_signal flips to true, state advances away
    // from clarification.
    expect(out.state.proceed_signal).toBe(true);
    expect(out.state.current_step).not.toBe("clarification");
  });
});

describe("context_detection", () => {
  it("repeats the question when the user submits an invalid PRD context", () => {
    const seed = newPipelineState({
      run_id: "inj_invalid_prd_context",
      feature_description: "this description has no trigger words at all",
    });
    const stateAtContextDetection: PipelineState = {
      ...seed,
      current_step: "context_detection",
    };

    const out = stepOnce(stateAtContextDetection, {
      kind: "user_answer",
      question_id: "prd_context",
      selected: ["not_a_real_context_kind"],
    });

    expect(out.action).toMatchObject({ kind: "ask_user", question_id: "prd_context", description: expect.stringContaining("not one of the options") });
  });
});

describe("preflight", () => {
  // source: missing-Cortex bug found 2026-04-26 — silent per-section recall
  // failures should surface as ONE clear startup error, not as degraded
  // generation across every section.

  it("issues a Cortex memory_stats probe as the first preflight action", () => {
    const seed = newPipelineState({
      run_id: "preflight_first_action",
      feature_description: "x",
    });
    const out = stepOnce({ ...seed, current_step: "preflight" });
    expect(out.action.kind).toBe("call_cortex_tool");
    if (out.action.kind === "call_cortex_tool") {
      expect(out.action.tool_name).toBe("memory_stats");
      expect(out.action.correlation_id).toBe("preflight_cortex_probe");
    }
  });

  it("emits a `failed` action with actionable setup advice when Cortex is unreachable", () => {
    const seed = newPipelineState({
      run_id: "preflight_cortex_down",
      feature_description: "x",
    });
    const stateAtPreflight = { ...seed, current_step: "preflight" as const };
    // First step issues the probe.
    const probe = stepOnce(stateAtPreflight);
    expect(probe.action.kind).toBe("call_cortex_tool");
    if (probe.action.kind !== "call_cortex_tool") return;

    // Host returns success: false (MCP not registered).
    const after = stepOnce(probe.state, {
      kind: "tool_result",
      correlation_id: probe.action.correlation_id,
      success: false,
      error: "MCP server cortex not registered",
    });
    expect(after.action.kind).toBe("failed");
    if (after.action.kind === "failed") {
      expect(after.action.step).toBe("preflight");
      expect(after.action.reason).toMatch(/cortex/i);
      // The reason must mention how to fix it — install/marketplace/plugin.
      expect(after.action.reason.toLowerCase()).toMatch(
        /install|marketplace|plugin|skip_preflight/,
      );
    }
  });

  it("when codebase_path is set, probes ai-architect AFTER Cortex passes", () => {
    const seed = newPipelineState({
      run_id: "preflight_with_codebase",
      feature_description: "x",
      codebase_path: "/some/path",
    });
    const stateAtPreflight = { ...seed, current_step: "preflight" as const };
    const probe = stepOnce(stateAtPreflight);
    if (probe.action.kind !== "call_cortex_tool") {
      throw new Error("expected first probe to be call_cortex_tool");
    }
    // Cortex returns success.
    const afterCortex = stepOnce(probe.state, {
      kind: "tool_result",
      correlation_id: probe.action.correlation_id,
      success: true,
      data: {},
    });
    // Next probe must be ai-architect health_check.
    expect(afterCortex.action.kind).toBe("call_pipeline_tool");
    if (afterCortex.action.kind === "call_pipeline_tool") {
      expect(afterCortex.action.tool_name).toBe("health_check");
      expect(afterCortex.action.correlation_id).toBe(
        "preflight_ai_architect_probe",
      );
    }
  });

  it("when codebase_path is NOT set, probes zetetic-team-subagents right after Cortex passes (no ai-architect probe)", () => {
    const seed = newPipelineState({
      run_id: "preflight_no_codebase",
      feature_description: "x",
    });
    const stateAtPreflight = { ...seed, current_step: "preflight" as const };
    const probe = stepOnce(stateAtPreflight);
    if (probe.action.kind !== "call_cortex_tool") {
      throw new Error("expected first probe to be call_cortex_tool");
    }
    const afterCortex = stepOnce(probe.state, {
      kind: "tool_result",
      correlation_id: probe.action.correlation_id,
      success: true,
      data: {},
    });
    // source: #123 — the subagent plugin is probed before preflight passes.
    expect(afterCortex.action.kind).toBe("spawn_subagents");
    expect(afterCortex.state.current_step).toBe("preflight");
    expect(afterCortex.state.preflight_status).not.toBe("ok");
  });

  it("skip_preflight=true short-circuits the preflight step (no probes) and marks status=skipped", () => {
    const seed = newPipelineState({
      run_id: "preflight_skipped",
      feature_description: "x",
      skip_preflight: true,
    });
    const out = stepOnce({ ...seed, current_step: "preflight" });
    expect(out.state.preflight_status).toBe("skipped");
    // current_step has advanced past preflight. Whether the runner stopped
    // at context_detection or coalesced through it depends on subsequent
    // handler behavior — the load-bearing assertion is that no probe was
    // issued and the skipped status was recorded.
    expect(out.action.kind).not.toBe("call_cortex_tool");
    expect(out.action.kind).not.toBe("call_pipeline_tool");
  });
});
