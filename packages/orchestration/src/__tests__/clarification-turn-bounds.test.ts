import { expect, it } from "vitest";
import { MAX_PIPELINE_ERRORS, newPipelineState, PipelineStateSchema, step } from "../index.js";

const seed = {
  ...newPipelineState({ run_id: "bounds", feature_description: "x", prd_context: "feature" }),
  current_step: "clarification" as const,
};
const normal = { question: " Who approves? ", options: [" Owner ", "Team"], rationale: " Name the reviewer. " };
const atLimit = "a".repeat(1000);
const huge = "UNTRUSTED".padEnd(5 * 1024 * 1024, "x");

function submit(raw_text: string, state = seed, error?: string) {
  return step({ state, result: {
    kind: "subagent_batch_result", batch_id: "clarification_compose_1", responses: [{
      invocation_id: "clarification_compose_inv_1", raw_text, error,
    }],
  } });
}

function compose(fields: object) {
  return submit(JSON.stringify(fields));
}

const fallback = 'What is the most important detail about "x" that should drive this PRD?';
const explanation = "Subagent did not return a parseable question; using fallback.";

function expectRejected(issued: ReturnType<typeof compose>, detail: string) {
  expect(issued.state.errors).toEqual([`Clarification compose: ${detail}`]);
  expect(issued.state.error_kinds).toEqual(["upstream_failure"]);
  expect(issued.state.clarifications).toEqual([{
    round: 1, asked_at: expect.any(String), question: fallback, options: null, rationale: explanation,
  }]);
  expect(issued.action).toMatchObject({
    kind: "ask_user", header: "Round 1: " + fallback, description: explanation, options: null,
  });
  expect(JSON.stringify(issued).includes("UNTRUSTED")).toBe(false);
}

it.each(["question", "options[1]", "rationale"])("accepts the exact %s ceiling unchanged", field => {
  const fields = field === "options[1]" ? { ...normal, options: ["first", atLimit] } : { ...normal, [field]: atLimit };
  const issued = compose(fields);
  expect(issued.state.errors).toEqual([]);
  expect(PipelineStateSchema.parse(issued.state).clarifications[0]).toMatchObject(fields);
  expect(issued.action).toMatchObject({
    header: "Round 1: " + fields.question, description: fields.rationale, options: fields.options.map(label => ({ label })),
  });
});

it.each(["question", "options[1]", "rationale"])("rejects %s one character over", field => {
  const value = "UNTRUSTED".padEnd(1001, " ");
  const fields = field === "options[1]" ? { options: ["first", value] } : { [field]: value };
  expectRejected(compose({ ...normal, ...fields }), `${field} has 1001 UTF-16 code units (maximum 1000)`);
});

it.each(["rationale", "question"])("rejects a 5 MiB %s", field => {
  expectRejected(compose({ ...normal, [field]: huge }), `${field} has ${huge.length} UTF-16 code units (maximum 1000)`);
});

it.each([0, 1, 5, 100_000])("rejects an entire list of %i options", count => {
  expectRejected(compose({ ...normal, options: Array(count).fill("UNTRUSTED") }), `options has ${count} entries (expected 2 to 4)`);
});

it.each([
  [{ question: "  " }, "question is blank (2 UTF-16 code units)"],
  [{ question: false }, "question must be a string"],
  [{ options: ["a", "  "] }, "options[1] is blank (2 UTF-16 code units)"],
  [{ options: ["a", false] }, "options[1] must be a string"],
  [{ options: "ab" }, "options must be an array or null"],
  [{ rationale: null }, "rationale must be a string"],
] as const)("rejects malformed fields %j", (fields, detail) => {
  expectRejected(compose({ ...normal, ...fields }), detail);
});

it.each([2, 4])("keeps all %i options", count => {
  const options = Array.from({ length: count }, (_, i) => ` choice ${i} `);
  const issued = compose({ ...normal, options });
  expect(issued.state.errors).toEqual([]);
  expect(PipelineStateSchema.parse(issued.state).clarifications[0]?.options).toEqual(options);
  expect(issued.action).toMatchObject({ options: options.map(label => ({ label })) });
});

it.each([{}, { options: null }])("accepts freeform %j with omitted rationale", fields => {
  const issued = compose({ question: "Which?", ...fields });
  expect(issued.state.errors).toEqual([]);
  expect(issued.state.clarifications[0]).toMatchObject({ question: "Which?", options: null, rationale: "" });
  expect(issued.action).toMatchObject({ options: null, description: "Answer freeform if no options listed." });
});

it("records unreadable compose text without echoing it or the upstream error", () => {
  expectRejected(submit("UNTRUSTED", seed, huge), "no parseable question object (9 UTF-16 code units)");
});

it("keeps a contextual fallback exactly at the ceiling", () => {
  const description = "x".repeat(1000 - fallback.length + 1);
  const issued = submit("", { ...seed, feature_description: description });
  expect(issued.state.clarifications[0]?.question).toBe(fallback.replace('"x"', `"${description}"`));
});

it("records a missing matching invocation as zero characters", () => {
  const issued = step({ state: seed, result: { kind: "subagent_batch_result", batch_id: "clarification_compose_1",
    responses: [{ invocation_id: "other", raw_text: JSON.stringify(normal) }],
  } });
  expectRejected(issued, "no parseable question object (0 UTF-16 code units)");
});

it("uses a complete generic fallback when the feature would overflow its question", () => {
  const issued = submit("", { ...seed, feature_description: huge });
  expect(issued.state.clarifications[0]?.question).toBe("What is the most important detail that should drive this PRD?");
  expect(issued.state.errors).toEqual(["Clarification compose: no parseable question object (0 UTF-16 code units)"]);
});

it("evicts the oldest error and kind and increments the existing dropped count", () => {
  const errors = Array.from({ length: MAX_PIPELINE_ERRORS }, (_, i) => `prior ${i}`);
  const issued = submit("{}", { ...seed, errors, error_kinds: errors.map(() => "structural"), errors_dropped: 7 });
  expect(issued.state.errors).toEqual([...errors.filter((_, i) => i > 0), "Clarification compose: question must be a string"]);
  expect(issued.state.error_kinds).toEqual([...Array(MAX_PIPELINE_ERRORS - 1).fill("structural"), "upstream_failure"]);
  expect(issued.state.errors_dropped).toBe(8);
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
