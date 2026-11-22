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
import { describe, expect, it, beforeAll, vi } from "vitest";
import { z } from "zod";
import { buildVerifiedPlan, MAX_RESPONSE_CHARS, newPipelineState, type NextAction } from "@prd-gen/orchestration";
import { RUNS_DIR, RunFiles } from "../run-files.js";
import { prepareImplementationReview } from "../implementation-review.js";

vi.mock("../implementation-review.js", () => ({ prepareImplementationReview: vi.fn() }));

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
  for (const format of ["full", "summary", "grounding", "validation", "action", "define_handoff_v1", "verified_plan_v1", "implementation_review_v1"]) {
    expect(args.parse({ run_id: "run_define_small", format }).format).toBe(format);
  }
  expect(args.parse({ run_id: "run_define_small" }).format).toBe("summary");
  expect(schemas.get("get_pipeline_state")?.plan_step).toHaveProperty("description", expect.stringContaining("Step name"));
  expect(schemas.get("get_pipeline_state")?.review_id).toHaveProperty("description", expect.stringContaining("review dossier"));
  expect(descriptions.get("get_pipeline_state")).toEqual(expect.stringContaining("format:'implementation_review_v1'"));
});

function saveReadyDefine(
  run_id: string, intent: string, requirements: { id: string; text: string }[],
  acceptance: { id: string; text: string; requirement_ids: string[] }[],
) {
  const sections = [
    ["requirements", requirements.map(({ id, text }) => `- ${id}: ${text}`).join("\n")],
    ["acceptance_criteria", acceptance.map(({ id, text }) => `- ${id}: ${text}`).join("\n")],
    ["testing", acceptance.map(({ id }) => `Replay ${id}.`).join("\n")],
  ] as const;
  new RunFiles(RUNS_DIR).write({
    ...newPipelineState({ run_id, feature_description: intent }),
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
}

it.each([
  { format: "define_handoff_v1", size: MAX_RESPONSE_CHARS },
  { format: "define_handoff_v1", size: MAX_RESPONSE_CHARS + 1 },
  { format: "verified_plan_v1", size: MAX_RESPONSE_CHARS },
  { format: "verified_plan_v1", size: MAX_RESPONSE_CHARS + 1 },
  { format: "verified_plan_v1", size: MAX_RESPONSE_CHARS + 1, oversizedSource: true },
])("enforces the complete $format response at $size chars (oversized source: $oversizedSource)", async ({ format, size, oversizedSource }) => {
  expect(descriptions.get("get_pipeline_state")).toEqual(expect.stringContaining(`format:'${format}'`));
  const oversized = size > MAX_RESPONSE_CHARS;
  const plan = format === "verified_plan_v1";
  const run_id = oversizedSource ? "run_plan_cross" : `run_${plan ? "plan" : "define"}_${oversized ? "large" : "small"}`;
  const intent = "Verify the saved receipt";
  const plan_step = "delivery";
  const requirements = Array.from({ length: oversizedSource ? 32 : 1 }, (_, index) => ({
    id: `FR-${String(index + 1).padStart(3, "0")}`,
    text: `Retain the verified receipt for record ${index + 1}.`,
  }));
  const acceptance = requirements.map(({ id }, index) => ({
    id: `AC-${String(index + 1).padStart(3, "0")}`,
    text: `Verify the saved receipt for record ${index + 1} (${id}).`,
    requirement_ids: [id],
  }));
  const handoff = { version: 1 as const, run_id, requirements, acceptance };
  const baseline = plan && !oversizedSource ? buildVerifiedPlan(handoff, intent, plan_step) : { handoff };
  requirements[0]!.text += "x".repeat(size - JSON.stringify(baseline).length);
  saveReadyDefine(run_id, intent, requirements, acceptance);
  if (oversizedSource) {
    expect(JSON.stringify({ handoff })).toHaveLength(MAX_RESPONSE_CHARS + 1);
    expect(JSON.stringify(buildVerifiedPlan(handoff, intent, plan_step)).length).toBeLessThan(MAX_RESPONSE_CHARS);
  }
  const response = await handlers.get("get_pipeline_state")!({ run_id, format, plan_step: plan ? plan_step : undefined });
  expect(response.isError).toBe(oversized);
  if (oversized) {
    expect(parse(response)).toEqual({
      error: plan && !oversizedSource
        ? { code: "plan_response_too_large", message: "The complete verified plan exceeds the MCP response budget." }
        : { code: "define_response_too_large", message: "The complete Define result exceeds the MCP response budget." },
    });
  } else {
    expect(response.content[0]?.text).toHaveLength(MAX_RESPONSE_CHARS);
    expect(parse(response)).toMatchObject({ [plan ? "verified_plan" : "handoff"]: { version: 1, run_id } });
    if (plan) {
      const missingStep = await handlers.get("get_pipeline_state")!({ run_id, format });
      expect(missingStep.isError).toBe(true);
      expect(parse(missingStep)).toMatchObject({ error: { code: "plan_step_invalid" } });
    }
  }
});

it("bounds the implementation review response independently from its plan", async () => {
  const run_id = "run_review_budget";
  const intent = "Keep receipts";
  const requirements = [{ id: "FR-001", text: "Keep a receipt." }];
  const acceptance = [{ id: "AC-001", text: "Find it (FR-001).", requirement_ids: ["FR-001"] }];
  saveReadyDefine(run_id, intent, requirements, acceptance);
  const request = { run_id, plan_step: "delivery", format: "implementation_review_v1", review_id: "candidate" };
  const dossier = {
    implementation_review: {
      version: 1, status: "ready_for_review", review_id: "candidate", run_id, step: "delivery",
      repository_id: "fixture/review", base_revision: "a".repeat(40), reviewed_revision: "b".repeat(40),
      plan_sha256: "1".repeat(64), approval_sha256: "2".repeat(64), diff_sha256: "3".repeat(64),
      acceptance: [{ ...acceptance[0]!, status: "evidence_required" }], diff: "",
    },
  };
  const prepare = vi.mocked(prepareImplementationReview);
  const keys = {
    PRD_GEN_REVIEW_AUTHORITY: "/owner/approval.json", PRD_GEN_REVIEW_REPOSITORY: "/checkout",
    PRD_GEN_REVIEW_REPOSITORY_ID: "fixture/review", PRD_GEN_REVIEW_GIT: "/trusted/git",
  };
  for (const [key, value] of Object.entries(keys)) vi.stubEnv(key, value);
  try {
    const fixed = JSON.stringify(dossier).length;
    dossier.implementation_review.diff = "x".repeat(MAX_RESPONSE_CHARS - fixed);
    prepare.mockResolvedValueOnce(dossier);
    const fits = await handlers.get("get_pipeline_state")!(request);
    expect(fits.isError).toBe(false);
    expect(fits.content[0]?.text).toBe(JSON.stringify(dossier));
    expect(prepare).toHaveBeenLastCalledWith({
      authority: keys.PRD_GEN_REVIEW_AUTHORITY, repository: keys.PRD_GEN_REVIEW_REPOSITORY,
      repositoryId: keys.PRD_GEN_REVIEW_REPOSITORY_ID, git: keys.PRD_GEN_REVIEW_GIT,
    }, "candidate", expect.objectContaining({ run_id, proposal: expect.objectContaining({ step: "delivery" }) }),
    expect.objectContaining({ run_id, requirements, acceptance }));

    dossier.implementation_review.diff += "x";
    prepare.mockResolvedValueOnce(dossier);
    const tooLarge = await handlers.get("get_pipeline_state")!(request);
    expect(tooLarge.isError).toBe(true);
    expect(parse(tooLarge)).toEqual({ error: {
      code: "review_response_too_large", message: "The complete implementation review exceeds the MCP response budget.",
    } });

    const invalidPlan = await handlers.get("get_pipeline_state")!({ ...request, plan_step: "" });
    expect(invalidPlan.isError).toBe(true);
    expect(parse(invalidPlan)).toMatchObject({ error: { code: "plan_step_invalid" } });
    expect(prepare).toHaveBeenCalledTimes(2);

    const error = { code: "review_authority_unavailable", message: "The implementation review dossier could not be prepared." };
    prepare.mockResolvedValueOnce({ error });
    const refused = await handlers.get("get_pipeline_state")!(request);
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toEqual({ error });
  } finally {
    vi.unstubAllEnvs();
    prepare.mockReset();
  }
});

it("preserves a Define refusal when a verified plan is requested before the gate", async () => {
  const run_id = "run_plan_pending";
  new RunFiles(RUNS_DIR).write(newPipelineState({ run_id, feature_description: "Verify receipts" }), null);
  const response = await handlers.get("get_pipeline_state")!({ run_id, format: "verified_plan_v1", plan_step: "delivery" });
  expect(response.isError).toBe(true);
  expect(parse(response)).toMatchObject({ error: { code: "define_not_pending" } });
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

it("keeps the terminal automatic outcome after a duplicate submission", async () => {
  const run_id = "run_review_finished";
  const source = newPipelineState({ run_id, feature_description: "Check exact delivery", semantic_review: true });
  const action: NextAction = {
    kind: "done", summary: "Original review outcome.", artifacts: [],
    outcome: { status: "needs_attention", reasons: ["Indeterminate scope"] },
  };
  new RunFiles(RUNS_DIR).write({ ...source, current_step: "complete" }, action);
  const reply = parse(await handlers.get("submit_action_result")!({
    run_id, result: { kind: "subagent_batch_result", batch_id: "old", responses: [] },
  }));
  expect(reply.action).toEqual(action);
  expect(reply.messages).toEqual([]);
  const saved = parse(await handlers.get("get_pipeline_state")!({ run_id, format: "action" }));
  expect(saved.action).toEqual(action);
});

it("still consumes the pending completion action of a running automatic review", async () => {
  const run_id = "run_review_finalizing";
  const state = newPipelineState({ run_id, feature_description: "Check exact delivery", semantic_review: true });
  const saved: NextAction = {
    kind: "call_cortex_tool", tool_name: "remember", arguments: {}, correlation_id: "self_check_remember",
  };
  new RunFiles(RUNS_DIR).write({
    ...state, current_step: "finalize",
    pending_completion: { summary: "Recorded verification", artifacts: [] },
  }, saved);
  const reply = parse(await handlers.get("submit_action_result")!({
    run_id, result: { kind: "tool_result", correlation_id: saved.correlation_id, success: true },
  }));
  expect(reply).toMatchObject({ current_step: "complete", action: { kind: "done" } });
});

it("keeps the response for a legacy completed run", async () => {
  const run_id = "run_legacy_finished";
  const state = newPipelineState({ run_id, feature_description: "Finished legacy run" });
  new RunFiles(RUNS_DIR).write({ ...state, current_step: "complete" }, {
    kind: "done", summary: "The earlier completion message.", artifacts: [],
  });
  const reply = parse(await handlers.get("submit_action_result")!({
    run_id, result: { kind: "subagent_batch_result", batch_id: "old", responses: [] },
  }));
  expect(reply).toMatchObject({
    current_step: "complete", action: { kind: "done", summary: "Pipeline already complete." },
  });
});
