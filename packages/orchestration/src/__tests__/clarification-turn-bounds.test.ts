import { describe, expect, it } from "vitest";
import { newPipelineState, PipelineStateSchema, step } from "../index.js";

const seed = {
  ...newPipelineState({ run_id: "bounds", feature_description: "x", prd_context: "feature" }),
  current_step: "clarification" as const,
};
const normal = { question: "Who approves?", options: [" Owner ", "Team"], rationale: " Name the reviewer. " };
const atLimit = "a".repeat(999) + "z";
const huge = "x".repeat(5 * 1024 * 1024);

function compose(fields: object, error?: string) {
  return step({ state: seed, result: {
    kind: "subagent_batch_result", batch_id: "clarification_compose_1", responses: [{
      invocation_id: "clarification_compose_inv_1", raw_text: JSON.stringify(fields), error,
    }],
  } });
}

describe.each(["compose", "checkpoint"])("%s clarification bounds", (source) => {
  function read(fields: object) {
    if (source === "compose") {
      const issued = compose(fields);
      const turn = issued.state.clarifications[0]!;
      expect(turn.options?.length ?? 0).toBeLessThanOrEqual(4);
      expect(issued.action).toMatchObject({
        kind: "ask_user", options: turn.options?.map(label => ({ label })) ?? null,
        header: "Round 1: " + turn.question, description: turn.rationale,
      });
      return turn;
    }
    return PipelineStateSchema.parse({ ...seed, clarifications: [{
      round: 1, asked_at: "now", ...fields,
    }] }).clarifications[0]!;
  }

  it.each([
    ["100,000 options", Array(100_000).fill("label")],
    ["five options", ["a", "b", "c", "d", "e"]],
    ["one option", ["only"]],
    ["four including a blank", ["a", "b", "c", " \t"]],
    ["blank after clipping", [" ".repeat(1000) + "x", "other"]],
    ["malformed entry", ["a", 2]],
    ["non-array", "ab"],
  ])("uses freeform for %s", (_, options) => {
    expect(read({ ...normal, options }).options === null).toBe(true);
  });

  it.each([2, 3, 4])("retains %i options in order", count => {
    const options = [" a ", "b", "c", "d"].slice(0, count);
    expect(read({ ...normal, options }).options).toEqual(options);
  });

  it.each(["question", "rationale"] as const)("caps %s exactly", field => {
    for (const input of [atLimit, atLimit + "!"]) {
      expect(read({ ...normal, [field]: input })[field] === input.slice(0, 1000)).toBe(true);
    }
  });

  it.each(["question", "rationale"] as const)("clips a 5 MiB %s", field => {
    expect(read({ ...normal, [field]: huge })[field] === "x".repeat(1000)).toBe(true);
  });

  it("caps each option label exactly", () => {
    expect(read({ ...normal, options: [atLimit, atLimit + "!"] }).options).toEqual([atLimit, atLimit]);
  });
});

it("preserves a normal composed turn and replays its exact serialized action", () => {
  const issued = compose(normal);
  const turn = issued.state.clarifications[0]!;
  expect(JSON.stringify(turn)).toBe(JSON.stringify({ round: 1, ...normal, asked_at: turn.asked_at }));
  const saved = PipelineStateSchema.parse(JSON.parse(JSON.stringify(issued.state)));
  const replay = step({ state: saved, result: {
    kind: "user_answer", question_id: "clarification_continue", selected: ["proceed"],
  } });
  expect(JSON.stringify(replay.action)).toBe(JSON.stringify(issued.action));
});

it("caps the fallback question for an oversized compose error or feature description", () => {
  const failed = compose({}, huge);
  expect(failed.state.clarifications[0]!.question.length).toBe(1000);
  const fallback = step({ state: { ...seed, feature_description: huge }, result: {
    kind: "subagent_batch_result", batch_id: "clarification_compose_1", responses: [],
  } });
  expect(fallback.state.clarifications[0]!.question).toBe(('What is the most important detail about "' + huge).slice(0, 1000));
});

it("trims the composed question and uses the default description for a non-string rationale", () => {
  const issued = compose({ question: "  Who approves? \n", rationale: 42 });
  expect(issued.state.clarifications[0]).toMatchObject({
    question: "Who approves?", options: null, rationale: "",
  });
  expect(issued.action).toMatchObject({
    header: "Round 1: Who approves?", description: "Answer freeform if no options listed.",
  });
});
