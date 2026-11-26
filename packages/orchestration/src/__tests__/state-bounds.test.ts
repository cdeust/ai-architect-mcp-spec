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
import { clipChars, ERROR_MESSAGE_CHARS } from "../types/state/bounded-io.js";
import { QualityScoreRecordSchema, ReliabilityObservationRecordSchema } from "../types/state/run-records.js";
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
    expect(TRUNCATED).toBe(" …[truncated]");
    expect(long.endsWith(" …[truncated]")).toBe(true);
    expect(long.startsWith("x".repeat(ERROR_MESSAGE_CHARS - TRUNCATED.length))).toBe(true);
    const astral = appendError(freshState(), "z".repeat(ERROR_MESSAGE_CHARS - TRUNCATED.length - 1) + "😀".repeat(10), "structural").errors.at(-1)!;
    expect(astral).toBe("z".repeat(ERROR_MESSAGE_CHARS - TRUNCATED.length - 1) + TRUNCATED);
    expect(clipChars("ab😀", 3)).toBe("ab");
    expect(clipChars("ab😀", 4)).toBe("ab😀");
    expect(clipChars("abc", 2)).toBe("ab");
    expect(clipChars("ab", 2)).toBe("ab");
    // At the limit nothing is cut, even a lone high surrogate.
    expect(clipChars("a\uD83D", 2)).toBe("a\uD83D");
    // Each end of the high-surrogate range moves the cut; a low surrogate or a BMP character does not.
    expect(clipChars("a\uD800b", 2)).toBe("a");
    expect(clipChars("a\uDBFFb", 2)).toBe("a");
    expect(clipChars("a\uD7FFb", 2)).toBe("a\uD7FF");
    expect(clipChars("a\uDC00b", 2)).toBe("a\uDC00");
    const exact = "y".repeat(ERROR_MESSAGE_CHARS);
    expect(appendError(freshState(), exact, "structural").errors.at(-1)).toBe(exact);
  });
});

describe("run records", () => {
  it("keep a quality score within [0, 1] and every field", () => {
    const score = { prd_context: "feature", rules_checked: 4, rules_passed: 3, critical_violations: 0, total_score: 0.5 };
    expect(QualityScoreRecordSchema.parse(score)).toEqual(score);
    for (const total_score of [0, 1]) expect(QualityScoreRecordSchema.safeParse({ ...score, total_score }).success).toBe(true);
    for (const total_score of [-0.1, 1.1]) expect(QualityScoreRecordSchema.safeParse({ ...score, total_score }).success).toBe(false);
  });

  it("keep every field of a reliability observation", () => {
    const observation = {
      claim_id: "FR-001", judge: { kind: "genius", name: "dijkstra" }, claim_type: "correctness",
      ground_truth_is_fail: false, judge_was_correct: true,
    };
    const parsed = ReliabilityObservationRecordSchema.safeParse(observation);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data).toEqual(observation);
  });

  it("name the lockstep invariant of errors[]", () => {
    expect(PipelineStateSchema.safeParse({ ...freshState(), errors: ["x"], error_kinds: [] }).error?.issues).toMatchObject([
      { path: ["error_kinds"], message: expect.stringContaining("errors[] and error_kinds[] must have the same length") },
    ]);
  });
});

describe("a loaded jira_result", () => {
  it("refuses a failure detail longer than one error entry", () => {
    const failed = (detail: string) => ({ ...freshState(), jira_result: { status: "failed", cause: "invalid", detail } });
    expect(PipelineStateSchema.safeParse(failed("x".repeat(ERROR_MESSAGE_CHARS))).success).toBe(true);
    expect(PipelineStateSchema.safeParse(failed("x".repeat(ERROR_MESSAGE_CHARS + 1))).error?.issues).toMatchObject([
      { path: ["jira_result", "detail"], message: "jira_result.detail exceeds 500 chars" },
    ]);
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
