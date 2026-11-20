/**
 * Integration test for `get_pipeline_state(format:"action")` — the recovery
 * path a host follows when a `start_pipeline`/`submit_action_result`
 * envelope carries a `__bounded` marker on its `spawn_subagents` action
 * (bound-envelope-action.ts). Proves the wiring end-to-end through the real
 * `registerPipelineTools` handlers (not just the pure bounding function unit
 * tests in bound-envelope-action.test.ts): the mcp-server composition root
 * caches the UNBOUNDED action on every start_pipeline/submit_action_result
 * call and serves it back via the new format selector.
 *
 * source: e2e run_mrlqa0aj_u2rh15 (2026-07-15).
 */
import { describe, expect, it, beforeAll } from "vitest";
import { z } from "zod";
import { MAX_RESPONSE_CHARS, newPipelineState } from "@prd-gen/orchestration";
import { RUNS_DIR, RunFiles } from "../run-files.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface CapturingServer {
  tool(name: string, ...rest: unknown[]): void;
}

let handlers: Map<string, ToolHandler>;
let descriptions: Map<string, unknown>;
let schemas: Map<string, z.ZodRawShape>;

beforeAll(async () => {
  const { registerPipelineTools } = await import("../pipeline-tools.js");
  handlers = new Map();
  descriptions = new Map();
  schemas = new Map();
  const server: CapturingServer = {
    tool(name, ...rest) {
      descriptions.set(name, rest[0]);
      schemas.set(name, rest[1] as z.ZodRawShape);
      const handler = rest[rest.length - 1] as ToolHandler;
      handlers.set(name, handler);
    },
  };
  registerPipelineTools(server as unknown as Parameters<typeof registerPipelineTools>[0]);
});

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text);
}

describe("get_pipeline_state format:'action'", () => {
  it("every start_pipeline/submit_action_result envelope carries a __bounded marker (empty applied when under budget)", async () => {
    const start = handlers.get("start_pipeline")!;
    const res = await start({
      feature_description: "OAuth login for the mobile app",
      skip_preflight: true,
    });
    const body = parse(res);
    expect(body.__bounded).toBeDefined();
    const bounded = body.__bounded as { applied: unknown[]; budget_chars: number };
    expect(Array.isArray(bounded.applied)).toBe(true);
    expect(bounded.budget_chars).toBe(100_000);
  });

  it("returns the exact last action (including full content) for a known run_id", async () => {
    const start = handlers.get("start_pipeline")!;
    const getState = handlers.get("get_pipeline_state")!;

    const startRes = parse(await start({
      feature_description: "OAuth login for the mobile app",
      skip_preflight: true,
    }));
    const runId = startRes.run_id as string;

    const actionRes = parse(
      await getState({ run_id: runId, format: "action" }),
    );
    expect(actionRes.run_id).toBe(runId);
    // The cached action matches what start_pipeline itself returned.
    expect(actionRes.action).toEqual(startRes.action);
    // A single-step action fits on one page; the page marker says so.
    expect(actionRes.__page).toMatchObject({ offset: 0, next_offset: null, budget_chars: 100_000 });
  });

  it("format:'action' with an invocation_offset past the last action returns a structured error", async () => {
    const start = handlers.get("start_pipeline")!;
    const getState = handlers.get("get_pipeline_state")!;
    const runId = parse(await start({
      feature_description: "OAuth login for the mobile app",
      skip_preflight: true,
    })).run_id as string;
    const res = await getState({ run_id: runId, format: "action", invocation_offset: 10_000 });
    expect(res.isError).toBe(true);
    expect(parse(res).error).toContain("out of range");
  });

  it("serves the current implementation policy for a pending saved question", async () => {
    expect(descriptions.get("get_pipeline_state")).toEqual(
      expect.stringContaining("refreshing a pending verification question"),
    );
    const run_id = "run_legacy_gate";
    const state = newPipelineState({ run_id, feature_description: "Legacy saved specification" });
    new RunFiles(RUNS_DIR).write({
      ...state,
      current_step: "implementation_gate",
      sections: [{
        section_type: "requirements", status: "passed", content: "ok",
        attempt: 1, violation_count: 0, last_violations: [], attempt_log: [],
      }],
    }, {
      kind: "ask_user", question_id: "implementation_gate", header: "Implement?",
      description: "Old decision", multi_select: false, options: [{ label: "PRD only" }, { label: "Implement" }],
    });
    const response = await handlers.get("get_pipeline_state")!({ run_id, format: "action" });
    const body = parse(response);
    expect(response.isError, JSON.stringify(body)).not.toBe(true);
    expect(body.action).toMatchObject({
      kind: "ask_user",
      question_id: "implementation_gate",
      options: [expect.objectContaining({ label: "PRD only" }), expect.objectContaining({ label: "Review verification findings" })],
    });
    const refused = await handlers.get("get_pipeline_state")!({ run_id, format: "define_handoff_v1" });
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toMatchObject({ error: { code: "define_document_invalid" } });
  });

  it("format:'action' on an unknown run_id returns a structured error, not a crash", async () => {
    const getState = handlers.get("get_pipeline_state")!;
    const res = await getState({ run_id: "run_never_started", format: "action" });
    expect(res.isError).toBe(true);
    const body = parse(res);
    expect(body.error).toContain("unknown run_id");
  });
});

it("preserves the existing state formats when the v1 selector is added", () => {
  const args = z.object(schemas.get("get_pipeline_state")!);
  for (const format of ["full", "summary", "grounding", "validation", "action", "define_handoff_v1"]) {
    expect(args.parse({ run_id: "run_define_small", format }).format).toBe(format);
  }
  expect(args.parse({ run_id: "run_define_small" }).format).toBe("summary");
});

it.each([MAX_RESPONSE_CHARS, MAX_RESPONSE_CHARS + 1])("enforces the complete Define response at %s chars", async size => {
  expect(descriptions.get("get_pipeline_state")).toEqual(expect.stringContaining("format:'define_handoff_v1'"));
  const oversized = size > MAX_RESPONSE_CHARS;
  const run_id = oversized ? "run_define_large" : "run_define_small";
  const requirement = "Retain the verified receipt.";
  const criterion = "Verify the saved receipt (FR-001).";
  const fixed = JSON.stringify({ handoff: {
    version: 1, run_id, requirements: [{ id: "FR-001", text: requirement }],
    acceptance: [{ id: "AC-001", text: criterion, requirement_ids: ["FR-001"] }],
  } }).length;
  const text = requirement + "x".repeat(size - fixed);
  const sections = [
    ["requirements", `- FR-001: ${text}`],
    ["acceptance_criteria", `- AC-001: ${criterion}`],
    ["testing", "Replay AC-001."],
  ] as const;
  new RunFiles(RUNS_DIR).write({
    ...newPipelineState({ run_id, feature_description: "Verify the saved receipt" }),
    current_step: "implementation_gate",
    sections: sections.map(([section_type, content]) => ({
      section_type, content, status: "passed", attempt: 1, violation_count: 0, last_violations: [], attempt_log: [],
    })),
    pending_completion: {
      summary: "Passed",
      artifacts: [],
      outcome: { status: "passed", reasons: [] },
      verification: {
        claims_evaluated: 2, distribution_suspicious: false, total_subjective_claims: 0,
        distribution: { PASS: 2, FAIL: 0, INCONCLUSIVE: 0, "NEEDS-RUNTIME": 0, "SPEC-COMPLETE": 0 },
        judge_verdicts: ["FR-001", "AC-001"].map(claim_id => ({
          claim_id, judge: { kind: "genius", name: "dijkstra" }, verdict: "PASS",
          confidence: 0.9, rationale: "Synthetic evidence.", caveats: [],
        })),
      },
    },
  }, {
    kind: "ask_user", question_id: "implementation_gate", header: "Implement?",
    description: "Decide", multi_select: false, options: [{ label: "PRD only" }, { label: "Implement" }],
  });
  const response = await handlers.get("get_pipeline_state")!({ run_id, format: "define_handoff_v1" });
  expect(response.isError).toBe(oversized);
  if (oversized) {
    expect(parse(response)).toEqual({
      error: { code: "define_response_too_large", message: "The complete Define result exceeds the MCP response budget." },
    });
  } else {
    expect(response.content[0]?.text).toHaveLength(MAX_RESPONSE_CHARS);
    expect(parse(response)).toMatchObject({ handoff: { version: 1, run_id } });
  }
});

it.each([
  { kind: "legacy stage", current_step: "implementation" as const, selected: ["PRD only"] },
  { kind: "retired answer", current_step: "implementation_gate" as const, selected: ["Implement"] },
])("refuses $kind through the in-process MCP tools", async ({ current_step, selected }) => {
  const run_id = current_step === "implementation" ? "run_boundary_stage" : "run_boundary_answer";
  const state = { ...newPipelineState({ run_id, feature_description: "Resume execution" }), current_step };
  new RunFiles(RUNS_DIR).write(state, {
    kind: "ask_user", question_id: "implementation_gate", header: "Implement?",
    description: "Saved question", options: [{ label: "PRD only" }, { label: "Implement" }], multi_select: false,
  });
  if (current_step === "implementation") {
    const recovered = await handlers.get("get_pipeline_state")!({ run_id, format: "action", invocation_offset: 1 });
    expect(recovered.isError).toBe(true);
    expect(parse(recovered)).toEqual({ error: {
      code: "architect_os_required",
      message: "Implementation belongs to architect-os. Use a validated Define handoff and an independently approved execution plan.",
    } });
  }
  const response = await handlers.get("submit_action_result")!({ run_id, result: {
    kind: "user_answer", question_id: "implementation_gate", selected,
  } });
  expect(response.isError).toBe(true);
  expect(parse(response).error).toMatchObject({ code: "architect_os_required" });
});

it("stores a legacy handoff refusal through the in-process MCP tools", async () => {
  const run_id = "run_boundary_override";
  new RunFiles(RUNS_DIR).write({
    ...newPipelineState({ run_id, feature_description: "Review an old specification" }),
    current_step: "implementation_gate",
  }, {
    kind: "ask_user", question_id: "implementation_gate", header: "Override?",
    description: "Old verification policy", options: [{ label: "PRD only" }, { label: "Override policy (explicit)" }],
    multi_select: false,
  });
  const submit = await handlers.get("submit_action_result")!({ run_id, result: {
    kind: "user_answer", question_id: "implementation_gate", selected: ["Review verification findings"],
  } });
  expect(submit.isError).toBeFalsy();
  const state = await handlers.get("get_pipeline_state")!({ run_id, format: "full" });
  expect(parse(state)).toMatchObject({ state: { post_specs: { legacy_define_refusal: true, decision: "pending" } } });
});
