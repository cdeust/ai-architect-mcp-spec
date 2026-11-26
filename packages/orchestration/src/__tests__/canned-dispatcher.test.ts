/**
 * Direct routing tests for the canned dispatcher.
 *
 * Pre-fix the dispatcher's behaviour was tested only end-to-end through
 * runSmoke. A mutation that reroutes one branch to another would survive
 * the full-run tests as long as the resulting state still reaches `done`
 * (e.g. swapping the JIRA branch with the freeform fallback). These tests
 * pin each dispatch case directly.
 *
 * source: code-reviewer H7 / test-engineer H3 (Phase 3+4 cross-audit, 2026-04).
 */

import { describe, expect, it } from "vitest";
import { makeCannedDispatcher } from "../canned-dispatcher.js";
import type { ActionResult, NextAction } from "../types/actions.js";
import { JiraDraftSchema } from "@prd-gen/core";
import { buildJiraPrompt } from "@prd-gen/meta-prompting";

describe("makeCannedDispatcher routing", () => {
  const dispatch = makeCannedDispatcher({
    freeform_answer: "test-answer",
    graph_path: "/tmp/test/graph",
  });

  it("ask_user with options returns the first option's label", () => {
    const action: NextAction = {
      kind: "ask_user",
      question_id: "feasibility_focus",
      header: "h",
      description: "d",
      options: [
        { label: "alpha" },
        { label: "beta" },
      ],
      multi_select: false,
    };
    const out = dispatch(action) as Extract<ActionResult, { kind: "user_answer" }>;
    expect(out.kind).toBe("user_answer");
    expect(out.question_id).toBe("feasibility_focus");
    expect(out.selected).toEqual(["alpha"]);
  });

  it("ask_user(clarification_continue) returns ['proceed']", () => {
    const action: NextAction = {
      kind: "ask_user",
      question_id: "clarification_continue",
      header: "h",
      description: "d",
      options: null,
      multi_select: false,
    };
    const out = dispatch(action) as Extract<ActionResult, { kind: "user_answer" }>;
    expect(out.selected).toEqual(["proceed"]);
  });

  it("selects PRD only when the implementation gate offers no options", () => {
    const implement = makeCannedDispatcher({ implementation_gate_answer: "Implement" });
    expect(implement({
      kind: "ask_user",
      question_id: "implementation_gate",
      header: "Implement?",
      description: "",
      options: null,
      multi_select: false,
    })).toEqual({ kind: "user_answer", question_id: "implementation_gate", selected: ["PRD only"] });
  });

  it("ask_user without options uses the freeform_answer label", () => {
    const action: NextAction = {
      kind: "ask_user",
      question_id: "free_q",
      header: "h",
      description: "d",
      options: null,
      multi_select: false,
    };
    const out = dispatch(action) as Extract<ActionResult, { kind: "user_answer" }>;
    expect(out.freeform).toBe("test-answer");
  });

  it("call_pipeline_tool(index_codebase) echoes the configured graph_path", () => {
    const action: NextAction = {
      kind: "call_pipeline_tool",
      tool_name: "index_codebase",
      arguments: { path: "/x", output_dir: "/y" },
      correlation_id: "C-1",
    };
    const out = dispatch(action) as Extract<ActionResult, { kind: "tool_result" }>;
    expect(out.kind).toBe("tool_result");
    expect(out.correlation_id).toBe("C-1");
    expect(out.success).toBe(true);
    expect((out.data as { graph_path?: string }).graph_path).toBe(
      "/tmp/test/graph",
    );
  });

  it("call_cortex_tool(recall) returns empty results", () => {
    const action: NextAction = {
      kind: "call_cortex_tool",
      tool_name: "recall",
      arguments: { query: "anything" },
      correlation_id: "C-2",
    };
    const out = dispatch(action) as Extract<ActionResult, { kind: "tool_result" }>;
    expect(out.success).toBe(true);
    expect((out.data as { results?: unknown[]; total?: number }).results).toEqual([]);
  });

  it("spawn_subagents routes self_check_judge_* to a parseable JSON verdict", () => {
    const action: NextAction = {
      kind: "spawn_subagents",
      batch_id: "self_check_verify",
      purpose: "judge",
      invocations: [
        {
          invocation_id: "self_check_judge_0001",
          subagent_type: "zetetic-team-subagents:genius:fermi",
          description: "judge claim FR-001",
          prompt: "<claim>\nid: FR-001\ntype: fr_traceability\n</claim>\n<claim>\nid: FR-002\n</claim>",
          isolation: "none",
        },
      ],
    };
    const out = dispatch(action) as Extract<
      ActionResult,
      { kind: "subagent_batch_result" }
    >;
    expect(out.kind).toBe("subagent_batch_result");
    expect(out.responses).toHaveLength(1);
    const raw = out.responses[0].raw_text!;
    // One verdict per claim of the batched prompt (issue #119), each naming
    // its claim_id, which the self-check requires (review note 2 of #325).
    const parsed = JSON.parse(raw) as Array<{ claim_id: string; verdict: string; confidence: number }>;
    expect(parsed.map((v) => v.claim_id)).toEqual(["FR-001", "FR-002"]);
    for (const v of parsed) {
      expect(v.verdict).toBe("PASS");
      expect(v.confidence).toBeGreaterThan(0);
      expect(v.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("spawn_subagents routes section_generate_<type> through the section-draft producer", () => {
    const action: NextAction = {
      kind: "spawn_subagents",
      batch_id: "section_generate_requirements",
      purpose: "draft",
      invocations: [
        {
          invocation_id: "section_generate_requirements",
          subagent_type: "zetetic-team-subagents:engineer",
          description: "draft requirements",
          prompt: "...",
          isolation: "none",
        },
      ],
    };
    const out = dispatch(action) as Extract<
      ActionResult,
      { kind: "subagent_batch_result" }
    >;
    expect(out.responses[0].raw_text).toContain("FR-001");
  });

  it("spawn_subagents routes jira_generation_engineer to chained tickets for the source criteria", () => {
    const action: NextAction = {
      kind: "spawn_subagents",
      batch_id: "jira_generation_tickets",
      purpose: "draft",
      invocations: [
        {
          invocation_id: "jira_generation_engineer",
          subagent_type: "zetetic-team-subagents:engineer",
          description: "jira",
          prompt: buildJiraPrompt({ feature_description: "Sign-in", source_sections: [
            { section_type: "requirements", content: "- FR-001: Sign in (AC-009 is not a criterion here)." },
            { section_type: "acceptance_criteria", content: "- AC-002: Signs in.\n- AC-003: Sees an error." },
          ] }),
          isolation: "none",
        },
      ],
    };
    const out = dispatch(action) as Extract<
      ActionResult,
      { kind: "subagent_batch_result" }
    >;
    const none = dispatch({ ...action, invocations: [{ ...action.invocations[0]!, prompt: buildJiraPrompt({
      feature_description: "Sign-in", source_sections: [{ section_type: "requirements", content: "- FR-001: Sign in (AC-009)." }],
    }) }] }) as Extract<ActionResult, { kind: "subagent_batch_result" }>;
    expect(JSON.parse(none.responses[0].raw_text!)).toEqual({ tickets: [] });
    const { tickets } = JiraDraftSchema.parse(JSON.parse(out.responses[0].raw_text!));
    expect(tickets.map(({ id, acceptance_ids, depends_on }) => ({ id, acceptance_ids, depends_on }))).toEqual([
      { id: "TICKET-001", acceptance_ids: ["AC-002"], depends_on: [] },
      { id: "TICKET-002", acceptance_ids: ["AC-003"], depends_on: ["TICKET-001"] },
    ]);
  });

  it("spawn_subagents falls through to the synthetic-response default for unknown prefixes", () => {
    const action: NextAction = {
      kind: "spawn_subagents",
      batch_id: "unknown_batch",
      purpose: "draft",
      invocations: [
        {
          invocation_id: "novel_unhandled_id",
          subagent_type: "zetetic-team-subagents:engineer",
          description: "x",
          prompt: "...",
          isolation: "none",
        },
      ],
    };
    const out = dispatch(action) as Extract<
      ActionResult,
      { kind: "subagent_batch_result" }
    >;
    expect(out.responses[0].raw_text).toBe("Canned synthetic response.");
  });

  it("write_file echoes path and reports byte length", () => {
    const action: NextAction = {
      kind: "write_file",
      path: "/tmp/x/01-prd.md",
      content: "hello world",
    };
    const out = dispatch(action) as Extract<ActionResult, { kind: "file_written" }>;
    expect(out.kind).toBe("file_written");
    expect(out.path).toBe("/tmp/x/01-prd.md");
    expect(out.bytes).toBe(Buffer.byteLength("hello world", "utf8"));
  });

  it("done returns undefined (terminal action)", () => {
    expect(dispatch({ kind: "done", summary: "s", artifacts: [] })).toBeUndefined();
  });

  it("failed returns undefined (terminal action)", () => {
    expect(
      dispatch({ kind: "failed", reason: "x", step: "section_generation" }),
    ).toBeUndefined();
  });

  it("custom fake_section_draft is used when provided", () => {
    const customDispatch = makeCannedDispatcher({
      fake_section_draft: (t) => `## CUSTOM:${t}`,
    });
    const out = customDispatch({
      kind: "spawn_subagents",
      batch_id: "section_generate_requirements",
      purpose: "draft",
      invocations: [
        {
          invocation_id: "section_generate_requirements",
          subagent_type: "zetetic-team-subagents:engineer",
          description: "x",
          prompt: "...",
          isolation: "none",
        },
      ],
    }) as Extract<ActionResult, { kind: "subagent_batch_result" }>;
    expect(out.responses[0].raw_text).toBe("## CUSTOM:requirements");
  });
});
