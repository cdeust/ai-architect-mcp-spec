/**
 * Bounded-I/O contract tests for PipelineState arrays (Phase 1c).
 *
 * Proves:
 *   - clarifications and errors/error_kinds have schema-level caps so a state
 *     cannot grow past the Claude Code 100,000-char MCP response budget.
 *   - appendError performs FIFO eviction (drops oldest, keeps newest) and
 *     records the dropped count in errors_dropped — never silent loss.
 *   - the errors/error_kinds lockstep invariant survives eviction.
 */
import { describe, expect, it } from "vitest";
import {
  PipelineStateSchema,
  newPipelineState,
  appendError,
  MAX_CLARIFICATION_TURNS,
  MAX_PIPELINE_ERRORS,
  type PipelineState,
} from "../index.js";
import { ERROR_MESSAGE_CHARS } from "../types/state/bounded-io.js";
import { TRUNCATED } from "../types/state/helpers.js";

function freshState(): PipelineState {
  return newPipelineState({
    run_id: "run_test",
    feature_description: "x",
    skip_preflight: true,
  });
}

describe("PipelineState — bounded-I/O caps", () => {
  it("caps are derived from the 100,000-char MCP budget", () => {
    expect(MAX_CLARIFICATION_TURNS).toBe(50);
    expect(MAX_PIPELINE_ERRORS).toBe(50);
  });

  it("rejects a clarifications array over the cap with a ZodError", () => {
    const turns = Array.from({ length: MAX_CLARIFICATION_TURNS + 1 }, (_, i) => ({
      round: i + 1,
      question: "q",
      asked_at: "2026-06-10T00:00:00.000Z",
    }));
    const result = PipelineStateSchema.safeParse({
      ...freshState(),
      clarifications: turns,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "clarifications")).toBe(
        true,
      );
    }
  });

  it("accepts a clarifications array exactly at the cap", () => {
    const turns = Array.from({ length: MAX_CLARIFICATION_TURNS }, (_, i) => ({
      round: i + 1,
      question: "q",
      asked_at: "2026-06-10T00:00:00.000Z",
    }));
    const result = PipelineStateSchema.safeParse({
      ...freshState(),
      clarifications: turns,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a direct errors array over the cap (schema backstop)", () => {
    const errs = Array.from({ length: MAX_PIPELINE_ERRORS + 1 }, (_, i) => `e${i}`);
    const kinds = errs.map(() => "structural" as const);
    const result = PipelineStateSchema.safeParse({
      ...freshState(),
      errors: errs,
      error_kinds: kinds,
    });
    expect(result.success).toBe(false);
  });
});

describe("appendError — entry size", () => {
  it("cuts an entry longer than ERROR_MESSAGE_CHARS with a visible mark and keeps one at the limit", () => {
    const long = appendError(freshState(), "x".repeat(ERROR_MESSAGE_CHARS + 1), "structural").errors.at(-1)!;
    expect(long).toHaveLength(ERROR_MESSAGE_CHARS);
    expect(long.endsWith(TRUNCATED)).toBe(true);
    expect(long.startsWith("x".repeat(ERROR_MESSAGE_CHARS - TRUNCATED.length))).toBe(true);
    const exact = "y".repeat(ERROR_MESSAGE_CHARS);
    expect(appendError(freshState(), exact, "structural").errors.at(-1)).toBe(exact);
  });
});

describe("appendError — FIFO eviction", () => {
  it("keeps errors and error_kinds in lockstep under the cap", () => {
    let state = freshState();
    for (let i = 0; i < 10; i++) {
      state = appendError(state, `error ${i}`, "structural");
    }
    expect(state.errors).toHaveLength(10);
    expect(state.error_kinds).toHaveLength(10);
    expect(state.errors_dropped).toBe(0);
  });

  it("evicts the oldest entry once over cap and records the drop", () => {
    let state = freshState();
    // Append one more than the cap.
    for (let i = 0; i < MAX_PIPELINE_ERRORS + 1; i++) {
      state = appendError(state, `error ${i}`, "structural");
    }
    // Length stays at the cap; oldest dropped; newest retained.
    expect(state.errors).toHaveLength(MAX_PIPELINE_ERRORS);
    expect(state.error_kinds).toHaveLength(MAX_PIPELINE_ERRORS);
    expect(state.errors_dropped).toBe(1);
    expect(state.errors[0]).toBe("error 1"); // "error 0" evicted
    expect(state.errors[state.errors.length - 1]).toBe(
      `error ${MAX_PIPELINE_ERRORS}`,
    );
  });

  it("evicted state still parses against the schema (cap respected)", () => {
    let state = freshState();
    for (let i = 0; i < MAX_PIPELINE_ERRORS + 5; i++) {
      state = appendError(state, `error ${i}`, "section_failure");
    }
    expect(state.errors_dropped).toBe(5);
    expect(() => PipelineStateSchema.parse(state)).not.toThrow();
  });
});
