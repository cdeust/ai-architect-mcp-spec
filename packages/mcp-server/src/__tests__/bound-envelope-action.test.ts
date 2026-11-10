/**
 * Envelope-bounding tests for `start_pipeline` / `submit_action_result`
 * responses that carry a `spawn_subagents` action (Phase 1e).
 *
 * Proves the fix for the real bug: a self_check judge-verification batch of
 * many invocations (each carrying a multi-KB prompt) can serialize a
 * `submit_action_result` response FAR past the Claude Code 100,000-char MCP
 * budget (measured 3.5MB for 89 invocations × ~37K chars,
 * e2e run_mrlqa0aj_u2rh15, 2026-07-15) — the same aggregate-overshoot class
 * of bug get_pipeline_state format:"full" already fixed via
 * boundFullStateResponse, but with NO equivalent bound on the envelope
 * boundary that `envelope()` builds.
 *
 *   - An oversized spawn_subagents envelope is bounded to <= MAX_RESPONSE_CHARS.
 *   - Every invocation keeps invocation_id/subagent_type/description/isolation.
 *   - Every invocation's prompt is replaced by an observable OmittedStub
 *     (never a silent truncation) carrying a re-fetch hint.
 *   - __bounded is present on EVERY envelope (empty `applied` under budget).
 *   - An under-budget envelope is returned with content unchanged.
 */
import { describe, expect, it } from "vitest";
import { MAX_RESPONSE_CHARS } from "@prd-gen/orchestration";
import { boundEnvelopeResponse, type EnvelopePayload } from "../bound-envelope-action.js";

/** Build a string of exactly `n` chars. */
function bigString(n: number): string {
  return "x".repeat(n);
}

function judgeBatchEnvelope(invocationCount: number, promptChars: number): EnvelopePayload {
  return {
    run_id: "run_judge_batch",
    current_step: "self_check",
    messages: [],
    action: {
      kind: "spawn_subagents",
      batch_id: "self_check_verify",
      purpose: "judge",
      invocations: Array.from({ length: invocationCount }, (_, i) => ({
        invocation_id: `self_check_judge_${String(i).padStart(4, "0")}`,
        subagent_type: "zetetic-team-subagents:dijkstra",
        description: `Judge claim ${i}`,
        prompt: bigString(promptChars),
        isolation: "none" as const,
      })),
    },
    state_summary: {
      sections: [],
      clarification_rounds: 0,
      errors: 0,
    },
  };
}

describe("boundEnvelopeResponse — spawn_subagents envelope bounding", () => {
  it("bounds an oversized judge batch to the MCP response budget", () => {
    // 89 invocations × ~37K chars ≈ the measured 3.5MB e2e overshoot.
    const payload = judgeBatchEnvelope(89, 37_000);
    const before = JSON.stringify(payload, null, 2).length;
    expect(before).toBeGreaterThan(MAX_RESPONSE_CHARS * 10); // sanity: genuinely oversized

    const bounded = boundEnvelopeResponse(payload);
    const after = JSON.stringify(bounded, null, 2).length;
    expect(after).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  });

  it("keeps invocation_id/subagent_type/description/isolation on every invocation", () => {
    const bounded = boundEnvelopeResponse(judgeBatchEnvelope(89, 37_000));
    const action = bounded.action as { invocations: Array<Record<string, unknown>> };
    expect(action.invocations).toHaveLength(89);
    for (const inv of action.invocations) {
      expect(typeof inv.invocation_id).toBe("string");
      expect(inv.subagent_type).toBe("zetetic-team-subagents:dijkstra");
      expect(typeof inv.description).toBe("string");
      expect(inv.isolation).toBe("none");
    }
  });

  it("replaces every prompt with an observable OmittedStub — never silent truncation", () => {
    const bounded = boundEnvelopeResponse(judgeBatchEnvelope(89, 37_000));
    const action = bounded.action as { invocations: Array<Record<string, unknown>> };
    for (const inv of action.invocations) {
      const prompt = inv.prompt as Record<string, unknown>;
      expect(prompt.omitted).toBe(true);
      expect(typeof prompt.chars).toBe("number");
      expect(prompt.chars).toBeGreaterThan(0);
      expect(String(prompt.hint)).toContain('format:"action"');
      expect(String(prompt.hint)).toContain("__page.next_offset");
      expect(String(prompt.hint)).toContain("invocation_offset");
    }
  });

  it("records the shed in __bounded.applied with the reclaimed chars, and recoverable prompts survive via the hint contract", () => {
    const bounded = boundEnvelopeResponse(judgeBatchEnvelope(89, 37_000));
    expect(bounded.__bounded.applied.length).toBeGreaterThan(0);
    const promptShed = bounded.__bounded.applied.find(
      (d) => d.field === "action.invocations[].prompt",
    );
    expect(promptShed).toBeDefined();
    expect(promptShed!.kind).toBe("omitted");
    expect(promptShed!.reclaimed_chars).toBeGreaterThan(89 * 37_000 * 0.9);
    expect(bounded.__bounded.original_chars).toBeGreaterThan(bounded.__bounded.final_chars);
    expect(bounded.__bounded.budget_chars).toBe(MAX_RESPONSE_CHARS);
  });

  it("returns an under-budget envelope unchanged, with an empty __bounded.applied", () => {
    const payload = judgeBatchEnvelope(2, 500);
    const bounded = boundEnvelopeResponse(payload);
    expect(bounded.__bounded.applied).toEqual([]);
    expect(bounded.__bounded.final_chars).toBe(bounded.__bounded.original_chars);
    const action = bounded.action as { invocations: Array<Record<string, unknown>> };
    expect(typeof action.invocations[0].prompt).toBe("string");
    expect((action.invocations[0].prompt as string).length).toBe(500);
  });

  it("leaves non-spawn_subagents actions unbounded but observes the overshoot (no bounding strategy applies)", () => {
    const payload: EnvelopePayload = {
      run_id: "run_no_strategy",
      current_step: "done",
      messages: [],
      action: { kind: "done", summary: bigString(MAX_RESPONSE_CHARS + 1_000), artifacts: [] },
      state_summary: {},
    };
    const bounded = boundEnvelopeResponse(payload);
    // No shedding strategy for `done` — content preserved, overshoot recorded.
    expect(bounded.__bounded.applied).toEqual([]);
    expect(bounded.__bounded.final_chars).toBeGreaterThan(MAX_RESPONSE_CHARS);
  });
});
