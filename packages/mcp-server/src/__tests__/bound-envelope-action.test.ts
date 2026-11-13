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
 *   - The prompts of the longest prefix of invocations that fits are whole;
 *     every later prompt is an observable OmittedStub (never a silent
 *     truncation) whose hint names the offset to refetch from (#125).
 *   - __bounded is present on EVERY envelope (empty `applied` under budget),
 *     and `final_chars` is the size of the response as shipped (#125).
 *   - An under-budget envelope is returned with content unchanged.
 *
 * source for the #125 cases: measured 2026-11-13 on main @ efd9e2e, before
 * the change. A host needed 3 calls to hold the prompts of 3 invocations of
 * 37,000 chars, 11 for 20 and 46 for 89 (the envelope, then every page of
 * the refetch); a 99,904-char payload shipped as 100,027 chars with an empty
 * `applied`.
 */
import { describe, expect, it } from "vitest";
import { MAX_RESPONSE_CHARS } from "@prd-gen/orchestration";
import {
  boundEnvelopeResponse,
  type BoundedEnvelope,
  type EnvelopePayload,
  type PromptOmission,
} from "../bound-envelope-action.js";
import { pageActionResponse, type ActionPage } from "../page-action-response.js";

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

type Invocation = Record<string, unknown>;

function invocationsOf(value: { action: unknown }): Invocation[] {
  return (value.action as { invocations: Invocation[] }).invocations;
}

/** The size of the response as pipeline-tools.ts ships it. */
function shippedChars(bounded: BoundedEnvelope): number {
  return JSON.stringify(bounded, null, 2).length;
}

function promptOmission(bounded: BoundedEnvelope): PromptOmission {
  const record = bounded.__bounded.applied.find((d) => d.field === "action.invocations[].prompt");
  expect(record, "no prompt omission recorded").toBeDefined();
  return record as PromptOmission;
}

/** A batch whose prompts differ in size and content: sizes cycle over 23 values. */
function unevenBatchEnvelope(invocationCount: number): EnvelopePayload {
  const base = judgeBatchEnvelope(invocationCount, 1);
  const invocations = invocationsOf(base).map((inv, i) => ({
    ...inv,
    prompt: `claim ${i} "quoted"\n` + String.fromCharCode(97 + (i % 26)).repeat(350 + ((i * 397) % 23) * 90),
  }));
  return { ...base, action: { ...(base.action as object), invocations } };
}

/**
 * What a host does to hold every prompt of a batch: read the envelope, then,
 * when it records omitted prompts, follow the refetch from `next_offset`.
 * `fromZero` is the host of before #125, which read the whole batch back.
 */
function holdEveryPrompt(
  payload: EnvelopePayload,
  budgetChars = MAX_RESPONSE_CHARS,
  fromZero = false,
): { calls: number; prompts: unknown[] } {
  const bounded = boundEnvelopeResponse(payload, budgetChars);
  let calls = 1;
  if (bounded.__bounded.applied.length === 0) {
    return { calls, prompts: invocationsOf(bounded).map((inv) => inv.prompt) };
  }
  const start = fromZero ? 0 : promptOmission(bounded).next_offset;
  const prompts = invocationsOf(bounded)
    .slice(0, start)
    .map((inv) => inv.prompt);
  let offset: number | null = start;
  while (offset !== null) {
    const page = pageActionResponse(payload.run_id, payload.action, offset, budgetChars) as ActionPage;
    calls++;
    prompts.push(...invocationsOf(page).map((inv) => inv.prompt));
    offset = page.__page.next_offset;
    if (calls > 10_000) throw new Error("the refetch does not terminate");
  }
  return { calls, prompts };
}

describe("boundEnvelopeResponse — spawn_subagents envelope bounding", () => {
  it("bounds an oversized judge batch to the MCP response budget", () => {
    // 89 invocations × ~37K chars ≈ the measured 3.5MB e2e overshoot.
    const payload = judgeBatchEnvelope(89, 37_000);
    const before = JSON.stringify(payload, null, 2).length;
    expect(before).toBeGreaterThan(MAX_RESPONSE_CHARS * 10); // sanity: genuinely oversized

    const bounded = boundEnvelopeResponse(payload);
    expect(shippedChars(bounded)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(bounded.__bounded.final_chars).toBe(shippedChars(bounded));
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

  it("keeps the prompts of a prefix whole and puts an observable OmittedStub on every later one — never silent truncation", () => {
    const payload = judgeBatchEnvelope(89, 37_000);
    const bounded = boundEnvelopeResponse(payload);
    const kept = promptOmission(bounded).next_offset;
    // 88 stubs and one 37,000-char prompt fit; a second prompt does not.
    expect(kept).toBe(1);
    invocationsOf(bounded).forEach((inv, i) => {
      if (i < kept) {
        expect(inv.prompt, `prompt ${i}`).toBe(invocationsOf(payload)[i].prompt);
        return;
      }
      const prompt = inv.prompt as Record<string, unknown>;
      expect(prompt.omitted, `prompt ${i}`).toBe(true);
      expect(prompt.chars).toBe(JSON.stringify(invocationsOf(payload)[i].prompt).length);
      expect(String(prompt.hint)).toContain('format:"action"');
      expect(String(prompt.hint)).toContain(`invocation_offset: ${kept})`);
      expect(String(prompt.hint)).toContain("__page.next_offset");
    });
  });

  it("records the shed in __bounded.applied with the reclaimed chars, and recoverable prompts survive via the hint contract", () => {
    const bounded = boundEnvelopeResponse(judgeBatchEnvelope(89, 37_000));
    expect(bounded.__bounded.applied).toHaveLength(1);
    const promptShed = promptOmission(bounded);
    expect(promptShed.kind).toBe("omitted");
    // 88 prompts shed, each 37,000 chars and its two quotes.
    expect(promptShed.reclaimed_chars).toBe(88 * 37_002);
    expect(bounded.__bounded.original_chars).toBeGreaterThan(bounded.__bounded.final_chars);
    expect(bounded.__bounded.budget_chars).toBe(MAX_RESPONSE_CHARS);
  });

  it("returns an under-budget envelope unchanged, with an empty __bounded.applied", () => {
    const payload = judgeBatchEnvelope(2, 500);
    const bounded = boundEnvelopeResponse(payload);
    expect(bounded.__bounded.applied).toEqual([]);
    expect(bounded.__bounded.original_chars).toBe(JSON.stringify(payload, null, 2).length);
    expect(bounded.__bounded.final_chars).toBe(shippedChars(bounded));
    const { __bounded: _marker, ...rest } = bounded;
    expect(rest).toEqual(payload);
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
    expect(bounded.__bounded.final_chars).toBe(shippedChars(bounded));
  });
});

describe("boundEnvelopeResponse — prompts in the normal response (#125)", () => {
  it("a host holds every prompt of the audited ~112k batch in 2 calls instead of 3", () => {
    const payload = judgeBatchEnvelope(3, 37_000);
    expect(JSON.stringify(payload, null, 2).length).toBeGreaterThan(MAX_RESPONSE_CHARS);
    const original = invocationsOf(payload).map((inv) => inv.prompt);

    expect(promptOmission(boundEnvelopeResponse(payload)).next_offset).toBe(2);
    const now = holdEveryPrompt(payload);
    expect(now.prompts).toEqual(original);
    expect(now.calls).toBe(2);
    const before = holdEveryPrompt(payload, MAX_RESPONSE_CHARS, true);
    expect(before.prompts).toEqual(original);
    expect(before.calls).toBe(3);
  });

  it.each([
    [20, 10, 11],
    [89, 45, 46],
  ])("a batch of %i judge prompts of 37,000 chars takes %i calls, %i when read back from offset 0", (count, calls, fromZero) => {
    const payload = judgeBatchEnvelope(count, 37_000);
    const original = invocationsOf(payload).map((inv) => inv.prompt);
    const now = holdEveryPrompt(payload);
    expect(now.prompts).toEqual(original);
    expect(now.calls).toBe(calls);
    // A host that ignores next_offset and reads the batch back from 0 still gets it.
    const whole = holdEveryPrompt(payload, MAX_RESPONSE_CHARS, true);
    expect(whole.prompts).toEqual(original);
    expect(whole.calls).toBe(fromZero);
  });

  it("at every budget the response is within it, reports its own size, and keeps a prefix", () => {
    const payload = unevenBatchEnvelope(14);
    const original = invocationsOf(payload).map((inv) => inv.prompt);
    const stubbed = boundEnvelopeResponse(payload, 1).__bounded.final_chars;
    const whole = boundEnvelopeResponse(payload, Number.MAX_SAFE_INTEGER).__bounded.final_chars;
    let previousKept = 0;
    const seen = new Set<number>();
    // budget_chars is part of the response: it has 1 digit in `stubbed`, 16 in
    // `whole`, and 4 or 5 in the sweep, hence the margins.
    const budgets: number[] = [];
    for (let budget = stubbed + 6; budget < whole; budget += 53) budgets.push(budget);
    budgets.push(whole);
    for (const budget of budgets) {
      const bounded = boundEnvelopeResponse(payload, budget);
      expect(bounded.__bounded.final_chars, `budget ${budget}`).toBe(shippedChars(bounded));
      expect(bounded.__bounded.final_chars, `budget ${budget}`).toBeLessThanOrEqual(budget);
      const kept = bounded.__bounded.applied.length === 0 ? 14 : promptOmission(bounded).next_offset;
      seen.add(kept);
      // A larger budget never keeps fewer prompts.
      expect(kept, `budget ${budget}`).toBeGreaterThanOrEqual(previousKept);
      previousKept = kept;
      invocationsOf(bounded).forEach((inv, i) => {
        if (i < kept) expect(inv.prompt, `budget ${budget}, prompt ${i}`).toBe(original[i]);
        else expect((inv.prompt as { omitted?: unknown }).omitted, `budget ${budget}, prompt ${i}`).toBe(true);
      });
      // Envelope prefix plus refetch: every prompt once, in order.
      expect(holdEveryPrompt(payload, budget).prompts, `budget ${budget}`).toEqual(original);
    }
    // The sweep crossed every prefix length, none skipped.
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, k) => k));
  });

  it("keeps the longest prefix that fits: the budget at which one more prompt is kept is the size of that response", () => {
    const payload = unevenBatchEnvelope(14);
    const keptAt = (budget: number) => {
      const bounded = boundEnvelopeResponse(payload, budget);
      return bounded.__bounded.applied.length === 0 ? 14 : promptOmission(bounded).next_offset;
    };
    let low = boundEnvelopeResponse(payload, 1).__bounded.final_chars + 6;
    const top = boundEnvelopeResponse(payload, Number.MAX_SAFE_INTEGER).__bounded.final_chars + 6;
    expect(keptAt(low)).toBe(0);
    for (let target = 1; target <= 14; target++) {
      // Smallest budget at which `target` prompts are kept.
      let high = top;
      expect(keptAt(high)).toBeGreaterThanOrEqual(target);
      while (high - low > 1) {
        const mid = (low + high) >>> 1;
        if (keptAt(mid) >= target) high = mid;
        else low = mid;
      }
      // A shorter prefix than the budget allows would move this threshold up,
      // above the size of the response it first returns.
      const first = boundEnvelopeResponse(payload, high);
      expect(keptAt(high), `threshold for ${target}`).toBe(target);
      expect(first.__bounded.final_chars, `threshold for ${target}`).toBe(high);
      low = high;
    }
  });

  it("an envelope just under the budget does not ship over it once the marker is added", () => {
    // 1 invocation. Before #125 the payloads of 99,878 to 100,000 chars
    // (prompts of 99,348 to 99,470) shipped whole, at 100,001 to 100,125 chars
    // (measured 2026-11-13 with the code of main @ efd9e2e on this fixture).
    for (let promptChars = 99_250; promptChars <= 99_480; promptChars += 1) {
      const payload = judgeBatchEnvelope(1, promptChars);
      const bounded = boundEnvelopeResponse(payload);
      expect(shippedChars(bounded), `prompt of ${promptChars}`).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
      expect(bounded.__bounded.final_chars, `prompt of ${promptChars}`).toBe(shippedChars(bounded));
      // Either the payload fits with its marker, or its one prompt is a stub.
      const fits = bounded.__bounded.applied.length === 0;
      expect(typeof invocationsOf(bounded)[0].prompt, `prompt of ${promptChars}`).toBe(fits ? "string" : "object");
      if (!fits) expect(promptOmission(bounded).next_offset).toBe(0);
    }
    // The boundary is inside the sweep: the largest prompt that ships whole
    // makes a response of 99,999 chars (one of exactly 100,000 cannot exist:
    // writing 100000 in final_chars takes a sixth digit).
    const lastWhole = boundEnvelopeResponse(judgeBatchEnvelope(1, 99_346));
    expect(lastWhole.__bounded.applied).toEqual([]);
    expect(lastWhole.__bounded.final_chars).toBe(99_999);
    expect(boundEnvelopeResponse(judgeBatchEnvelope(1, 99_347)).__bounded.applied).toHaveLength(1);
  });

  it("sheds every prompt and shows the overshoot when the stubs alone are over the budget", () => {
    const payload = judgeBatchEnvelope(40, 900);
    const stubbed = boundEnvelopeResponse(payload, 1);
    const budget = stubbed.__bounded.final_chars - 500;
    const bounded = boundEnvelopeResponse(payload, budget);
    expect(promptOmission(bounded).next_offset).toBe(0);
    for (const inv of invocationsOf(bounded)) expect((inv.prompt as { omitted?: unknown }).omitted).toBe(true);
    expect(bounded.__bounded.final_chars).toBe(shippedChars(bounded));
    expect(bounded.__bounded.final_chars).toBeGreaterThan(budget);
  });

  it("leaves an empty or non-string prompt in place: there is nothing to refetch for it", () => {
    const base = judgeBatchEnvelope(6, 30_000);
    const invocations = invocationsOf(base).map((inv, i) =>
      i === 3 ? { ...inv, prompt: "" } : i === 4 ? { ...inv, prompt: { already: "structured" } } : inv,
    );
    const payload: EnvelopePayload = { ...base, action: { ...(base.action as object), invocations } };
    const bounded = boundEnvelopeResponse(payload);
    // Three 30,000-char prompts fit; invocations 3 and 4 have no prompt to
    // shed, so the first stub, where the refetch resumes, is invocation 5.
    expect(promptOmission(bounded).next_offset).toBe(5);
    for (const i of [0, 1, 2]) expect(invocationsOf(bounded)[i].prompt).toBe(invocationsOf(payload)[i].prompt);
    expect(invocationsOf(bounded)[3].prompt).toBe("");
    expect(invocationsOf(bounded)[4].prompt).toEqual({ already: "structured" });
    expect((invocationsOf(bounded)[5].prompt as { omitted?: unknown }).omitted).toBe(true);
    expect(shippedChars(bounded)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  });

  it("sheds the one prompt of a batch whose other invocations have none, when it does not fit", () => {
    const base = judgeBatchEnvelope(3, MAX_RESPONSE_CHARS);
    const invocations = invocationsOf(base).map((inv, i) => (i === 0 ? inv : { ...inv, prompt: "" }));
    const payload: EnvelopePayload = { ...base, action: { ...(base.action as object), invocations } };
    const bounded = boundEnvelopeResponse(payload);
    // Keeping the first prompt would shed nothing: the only bounded form has no prompt.
    expect(promptOmission(bounded).next_offset).toBe(0);
    expect((invocationsOf(bounded)[0].prompt as { omitted?: unknown }).omitted).toBe(true);
    expect(invocationsOf(bounded)[1].prompt).toBe("");
    expect(bounded.__bounded.final_chars).toBe(shippedChars(bounded));
    expect(bounded.__bounded.final_chars).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  });
});
