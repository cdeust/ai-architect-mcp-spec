/**
 * Aggregate-overshoot bounding tests for get_pipeline_state format:"full"
 * (Phase 1d).
 *
 * Proves the fix for the real bug: the Phase 1c per-field input caps each take
 * a SHARE of the 100,000-char budget, but the shares overlap — a state at all
 * three caps serializes to ~165k+, which the Claude Code host rejects.
 * boundFullStateResponse measures the pretty-printed payload and, when over
 * budget, sheds least-relevant detail first (grounding → clarifications →
 * section content) until it fits, recording every shed observably.
 *
 *   - A worst-case all-caps-full state serializes ≤ 100,000 chars.
 *   - Degradations are OBSERVABLE (__bounded.applied + omitted/elided flags).
 *   - The diagnostic skeleton (scalars + errors[]) is never shed.
 *   - Shed grounding stays reachable (omitted stub carries the re-fetch hint).
 *   - An under-budget state is returned untouched (empty applied list).
 */
import { describe, expect, it } from "vitest";
import {
  PipelineStateSchema,
  newPipelineState,
  appendError,
  MAX_CLARIFICATION_TURNS,
  MAX_PIPELINE_ERRORS,
  MAX_RESPONSE_CHARS,
  SectionTypeSchema,
  type PipelineState,
} from "@prd-gen/orchestration";
import {
  boundFullStateResponse,
  boundGroundingResponse,
} from "../bound-full-state.js";

/** Build a string of exactly `n` chars. */
function bigString(n: number): string {
  return "x".repeat(n);
}

/**
 * A worst-case state sitting at every Phase 1c input cap simultaneously:
 *   - codebase_grounding ≈ 90k (the PrdInputBundleSchema field budgets)
 *   - prd_validation     ≈ 10k
 *   - clarifications      = 50 turns (cap), each padded toward ~1k
 *   - errors/error_kinds  = 50 entries (cap), each padded toward ~500
 *   - sections            = several with full markdown content
 * Serializes far past 100,000 chars before bounding.
 */
function worstCaseState(): PipelineState {
  let state = newPipelineState({
    run_id: "run_worst",
    feature_description: "worst case",
    skip_preflight: true,
  });

  // Grounding blob ≈ 90k (matched_symbols 30k + impacted_communities 20k +
  // impacted_processes 20k + graph_stats 10k + finding 10k = 90k input cap).
  const grounding: Record<string, unknown> = {
    matched_symbols: bigString(30_000),
    impacted_communities: bigString(20_000),
    impacted_processes: bigString(20_000),
    graph_stats: bigString(10_000),
    finding: bigString(10_000),
    mode: "feature",
  };
  const prdValidation: Record<string, unknown> = {
    findings: bigString(10_000),
  };

  // 50 clarification turns at cap, each ~1k chars.
  const clarifications = Array.from(
    { length: MAX_CLARIFICATION_TURNS },
    (_, i) => ({
      round: i + 1,
      question: bigString(450),
      answer: bigString(450),
      asked_at: "2026-06-10T00:00:00.000Z",
      answered_at: "2026-06-10T00:01:00.000Z",
    }),
  );

  // Sections with full markdown bodies.
  // DISTINCT section types — a real worst-case state never repeats one, and
  // sections are keyed by section_type downstream, so six "overview" entries
  // would collapse to one and understate the payload this test must bound.
  const sections = Array.from({ length: 6 }, (_, i) => ({
    section_type: SectionTypeSchema.options[i]!,
    status: "passed" as const,
    attempt: 1,
    violation_count: 0,
    last_violations: [],
    content: bigString(5_000),
    attempt_log: [],
  }));

  state = PipelineStateSchema.parse({
    ...state,
    codebase_grounding: grounding,
    prd_validation: prdValidation,
    clarifications,
    sections,
  });

  // 50 errors at cap via appendError (FIFO, lockstep).
  for (let i = 0; i < MAX_PIPELINE_ERRORS; i++) {
    state = appendError(state, bigString(450), "section_failure");
  }
  return state;
}

/** Wire-format size, matching pipeline-tools.ts JSON.stringify(payload,null,2). */
function wireChars(payload: unknown): number {
  return JSON.stringify(payload, null, 2).length;
}

describe("boundFullStateResponse — aggregate overshoot fix", () => {
  it("a worst-case all-caps-full state exceeds the budget BEFORE bounding", () => {
    const state = worstCaseState();
    // Sanity: the bug is real — the raw state overshoots the host ceiling.
    expect(wireChars(state)).toBeGreaterThan(MAX_RESPONSE_CHARS);
  });

  it("bounds the worst-case state to ≤ 100,000 wire chars", () => {
    const bounded = boundFullStateResponse(worstCaseState());
    expect(wireChars(bounded)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(bounded.__bounded.final_chars).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  });

  it("records every degradation observably with reclaimed chars", () => {
    const bounded = boundFullStateResponse(worstCaseState());
    expect(bounded.__bounded.applied.length).toBeGreaterThan(0);
    for (const d of bounded.__bounded.applied) {
      expect(d.reclaimed_chars).toBeGreaterThan(0);
      expect(["omitted", "elided"]).toContain(d.kind);
    }
    // original > final, and original is recorded for the caller.
    expect(bounded.__bounded.original_chars).toBeGreaterThan(
      bounded.__bounded.final_chars,
    );
  });

  it("sheds grounding FIRST (lowest priority) with a re-fetch hint", () => {
    const bounded = boundFullStateResponse(worstCaseState());
    const grounding = bounded.state.codebase_grounding as Record<string, unknown>;
    expect(grounding.omitted).toBe(true);
    expect(grounding.chars).toBeGreaterThan(0);
    expect(String(grounding.hint)).toContain('format:"grounding"');
    // grounding shed must appear in applied.
    expect(
      bounded.__bounded.applied.some((d) => d.field === "codebase_grounding"),
    ).toBe(true);
  });

  it("NEVER sheds the diagnostic skeleton: errors[] and scalars survive intact", () => {
    const original = worstCaseState();
    const bounded = boundFullStateResponse(original);
    expect(bounded.state.errors).toEqual(original.errors);
    expect(bounded.state.error_kinds).toEqual(original.error_kinds);
    expect(bounded.state.run_id).toBe(original.run_id);
    expect(bounded.state.current_step).toBe(original.current_step);
    // No degradation may target errors.
    expect(
      bounded.__bounded.applied.some((d) => d.field.startsWith("errors")),
    ).toBe(false);
  });

  it("keeps the NEWEST clarification turns when eliding (oldest dropped first)", () => {
    const bounded = boundFullStateResponse(worstCaseState());
    const elision = bounded.__bounded.applied.find(
      (d) => d.field === "clarifications",
    );
    if (elision) {
      // If clarifications were elided, the surviving array must keep the newest
      // round (highest round number), proving front-drop not back-drop.
      const kept = bounded.state.clarifications as Array<{ round: number }>;
      const rounds = kept.map((t) => t.round);
      expect(Math.max(...rounds)).toBe(MAX_CLARIFICATION_TURNS);
      expect(elision.dropped).toBeGreaterThan(0);
    }
  });

  it("leaves an under-budget state untouched with an empty applied list", () => {
    const small = newPipelineState({
      run_id: "run_small",
      feature_description: "tiny",
      skip_preflight: true,
    });
    const bounded = boundFullStateResponse(small);
    expect(bounded.__bounded.applied).toEqual([]);
    expect(bounded.state.codebase_grounding).toBe(null);
    expect(bounded.__bounded.original_chars).toBe(wireChars({ state: small }));
    // final_chars is the size of the response as shipped, __bounded included.
    expect(bounded.__bounded.final_chars).toBe(wireChars(bounded));
    expect(wireChars(bounded)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  });

  it("reports the shipped size once degraded", () => {
    const bounded = boundFullStateResponse(worstCaseState());
    expect(bounded.__bounded.final_chars).toBe(wireChars(bounded));
  });

  it("a state just under the budget does not ship over it once final_chars is written (#125)", () => {
    // One section whose content brings the response to the budget, one char
    // at a time. Before #125 the size was compared with final_chars at 0 and
    // shipped with final_chars written: up to 5 chars more, 100,003 measured
    // at the file_export step of a run with 7,250-char sections.
    const stateWith = (contentChars: number): PipelineState => {
      const base = newPipelineState({
        run_id: "run_boundary",
        feature_description: "boundary",
        skip_preflight: true,
      });
      return PipelineStateSchema.parse({
        ...base,
        sections: [
          {
            section_type: SectionTypeSchema.options[0]!,
            status: "passed" as const,
            attempt: 1,
            violation_count: 0,
            last_violations: [],
            content: bigString(contentChars),
            attempt_log: [],
          },
        ],
      });
    };
    const empty = wireChars(boundFullStateResponse(stateWith(0)));
    const edge = MAX_RESPONSE_CHARS - empty;
    let whole = 0;
    let degraded = 0;
    for (let contentChars = edge - 30; contentChars <= edge + 30; contentChars++) {
      const bounded = boundFullStateResponse(stateWith(contentChars));
      expect(wireChars(bounded), `content of ${contentChars}`).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
      expect(bounded.__bounded.final_chars, `content of ${contentChars}`).toBe(wireChars(bounded));
      if (bounded.__bounded.applied.length === 0) whole++;
      else degraded++;
    }
    // The sweep crosses the boundary: states that fit whole, then states degraded.
    expect(whole).toBeGreaterThan(0);
    expect(degraded).toBeGreaterThan(0);
  });

  it("bounds format:'grounding' when grounding+validation overshoot together", () => {
    const state = worstCaseState();
    const bounded = boundGroundingResponse(state);
    // grounding alone ≈ 90k fits; the pair ≈ 100,257 does not, so validation
    // must be shed to a re-fetch stub.
    expect(wireChars(bounded)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const validation = bounded.prd_validation as Record<string, unknown>;
    expect(validation.omitted).toBe(true);
    expect(String(validation.hint)).toContain('format:"validation"');
    // codebase_grounding (the named purpose of this selector) is kept intact.
    expect(bounded.codebase_grounding).toBe(state.codebase_grounding);
    expect(
      bounded.__bounded.applied.some((d) => d.field === "prd_validation"),
    ).toBe(true);
  });

  it("format:'grounding' keeps both blobs when they fit together", () => {
    const state = newPipelineState({
      run_id: "run_g",
      feature_description: "x",
      skip_preflight: true,
    });
    const withSmallBlobs = PipelineStateSchema.parse({
      ...state,
      codebase_grounding: { matched_symbols: "abc", mode: "feature" },
      prd_validation: { findings: "none" },
    });
    const bounded = boundGroundingResponse(withSmallBlobs);
    expect(bounded.__bounded.applied).toEqual([]);
    expect(bounded.prd_validation).toEqual({ findings: "none" });
    expect(wireChars(bounded)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  });

  it("does not mutate the input state (no aliasing)", () => {
    const original = worstCaseState();
    const groundingRef = original.codebase_grounding;
    boundFullStateResponse(original);
    // The input's grounding object is the same reference, unmodified.
    expect(original.codebase_grounding).toBe(groundingRef);
    expect((original.codebase_grounding as Record<string, unknown>).omitted).toBe(
      undefined,
    );
  });
});
