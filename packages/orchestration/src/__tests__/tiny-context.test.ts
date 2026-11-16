/**
 * The `tiny` PRD context: the fast path of #119 (slice 1).
 *
 * Proves: (1) a description that declares itself tiny, as a whole word, is
 * detected as `tiny` before every other trigger ("add", "fix"), and a word
 * that only contains "tiny" declares nothing; (2) a tiny run schedules the
 * four sections #119 names; (3) clarification asks for 4 rounds, not the 8
 * of `feature`, before it offers "proceed".
 *
 * source: #119 — an audited one-line feature run went through 8 mandatory
 * clarification rounds and 11 sections.
 */

import { describe, expect, it } from "vitest";
import { PRD_CONTEXT_CONFIGS } from "@prd-gen/core";
import { newPipelineState, SECTIONS_BY_CONTEXT, step } from "../index.js";
import type { PipelineState } from "../index.js";

function atContextDetection(feature_description: string): PipelineState {
  return {
    ...newPipelineState({ run_id: "tiny_ctx", feature_description }),
    current_step: "context_detection",
  };
}

function detect(feature_description: string): PipelineState["prd_context"] {
  return step({ state: atContextDetection(feature_description) }).state.prd_context;
}

describe("tiny context detection (#119)", () => {
  it("reads a declared-tiny request as tiny, before feature and bug triggers", () => {
    expect(detect("Add a tiny copy button to the share dialog")).toBe("tiny");
    expect(detect("Fix a one-line typo in the footer")).toBe("tiny");
    expect(detect("A one line change: build the label in bold")).toBe("tiny");
    expect(detect("Trivial: implement a tooltip")).toBe("tiny");
  });

  it("matches whole words only", () => {
    // "destiny" contains "tiny"; "build" makes it a feature.
    expect(detect("build the Destiny leaderboard")).toBe("feature");
  });

  it("leaves requests that declare no size to the other triggers", () => {
    expect(detect("build a feature for OAuth login")).toBe("feature");
    expect(detect("fix the broken login redirect")).toBe("bug");
  });

  it("accepts tiny as the answer to the context question", () => {
    const out = step({
      state: atContextDetection("something unclassifiable"),
      result: {
        kind: "user_answer",
        question_id: "prd_context",
        selected: ["tiny"],
      },
    });
    expect(out.state.prd_context).toBe("tiny");
  });
});

describe("tiny section plan (#119)", () => {
  it("schedules overview, requirements, acceptance criteria and tests only", () => {
    expect(SECTIONS_BY_CONTEXT.tiny).toEqual([
      "overview",
      "requirements",
      "acceptance_criteria",
      "testing",
    ]);
    expect(SECTIONS_BY_CONTEXT.tiny.length).toBe(
      PRD_CONTEXT_CONFIGS.tiny.expectedSectionCount,
    );
  });
});

describe("tiny clarification bounds (#119)", () => {
  function answeredTurns(n: number): PipelineState["clarifications"] {
    const asked_at = "2026-11-16T00:00:00.000Z";
    const turns: PipelineState["clarifications"] = [];
    for (let round = 1; round <= n; round++) {
      turns.push({ round, question: `q${round}`, answer: `a${round}`, asked_at, answered_at: asked_at });
    }
    // The last turn is the one waiting for its answer.
    turns[n - 1] = { round: n, question: `q${n}`, asked_at };
    return turns;
  }

  function answerRound(context: "tiny" | "feature", round: number) {
    const state: PipelineState = {
      ...newPipelineState({ run_id: "tiny_clar", feature_description: "x" }),
      current_step: "clarification",
      prd_context: context,
      clarifications: answeredTurns(round),
    };
    return step({
      state,
      result: {
        kind: "user_answer",
        question_id: "clarification_answer",
        selected: [],
        freeform: `answer ${round}`,
      },
    }).action;
  }

  it("offers proceed after the 4th answer of a tiny run", () => {
    const action = answerRound("tiny", 4);
    expect(action.kind).toBe("ask_user");
    expect(action.kind === "ask_user" && action.options?.map((o) => o.label)).toEqual([
      "proceed",
      "continue",
    ]);
  });

  it("asks a 4th question after the 3rd answer of a tiny run", () => {
    expect(answerRound("tiny", 3).kind).toBe("spawn_subagents");
  });

  it("still asks a 5th question after the 4th answer of a feature run", () => {
    expect(answerRound("feature", 4).kind).toBe("spawn_subagents");
  });
});
