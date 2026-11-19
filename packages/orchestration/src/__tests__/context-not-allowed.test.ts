/**
 * A kind the capability set does not allow is refused on each of the three
 * ways to a kind: declared, answered, detected (#119 review). The shipped
 * capability set allows every kind, so this file narrows it to see the rule.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@prd-gen/core", async (original) => {
  const core = await original<typeof import("@prd-gen/core")>();
  return { ...core, CAPABILITIES: { ...core.CAPABILITIES, allowedContextTypes: ["feature"] } };
});

const { newPipelineState, step } = await import("../index.js");
type State = ReturnType<typeof newPipelineState>;

function atContextDetection(feature_description: string, prd_context?: State["prd_context"]): State {
  return {
    ...newPipelineState({ run_id: "not_allowed", feature_description, prd_context }),
    current_step: "context_detection",
  };
}

describe("a kind of PRD that is not allowed", () => {
  it("is refused when the host declares it", () => {
    const out = step({ state: atContextDetection("x", "bug") });
    expect(out.action).toEqual({ kind: "failed", reason: "PRD context not allowed: bug", step: "context_detection" });
  });

  it("re-asks with the allowed kind when the user answers with a disallowed kind", () => {
    const out = step({
      state: atContextDetection("something unclassifiable"),
      result: { kind: "user_answer", question_id: "prd_context", selected: ["bug"] },
    });
    expect(out.action).toMatchObject({ kind: "ask_user", options: [{ label: "feature" }], description: expect.stringContaining("not one of the options") });
  });

  it("is not taken from the words of the description: the allowed kinds are asked", () => {
    const out = step({ state: atContextDetection("the login redirect is broken") });
    expect(out.state.prd_context).toBeNull();
    expect(out.action.kind).toBe("ask_user");
    if (out.action.kind !== "ask_user") return;
    expect(out.action.description).toBe("I couldn't infer the PRD type from your request. Pick the closest match: it sets what the PRD covers, and its clarification depth and sections unless the declared request size sets them.");
    expect(out.action.options?.map((o) => o.label)).toEqual(["feature"]);
  });

  it("is still taken when it is the allowed one", () => {
    const out = step({ state: atContextDetection("x", "feature") });
    expect(out.state.prd_context).toBe("feature");
    // Not refused: a refusal would keep the declared kind in the state too.
    expect(out.action.kind).not.toBe("failed");
    expect(out.state.current_step).not.toBe("context_detection");
  });
});
