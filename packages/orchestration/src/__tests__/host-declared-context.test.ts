/**
 * The kind of PRD: declared by the host at start_pipeline, read from the
 * words of the description, or answered by the user (#119).
 *
 * A declared kind is kept as it is: the server reads no trigger word and
 * asks no question. The three ways to a kind end in the same step and say
 * which one it was.
 */

import { expectOptionRetry } from "./expect-option-retry.js";
import { describe, expect, it } from "vitest";
import { newPipelineState, step } from "../index.js";
import type { PipelineState } from "../index.js";

function atContextDetection(
  feature_description: string,
  prd_context?: PipelineState["prd_context"],
  request_size?: PipelineState["request_size"],
): PipelineState {
  return {
    ...newPipelineState({ run_id: "host_ctx", feature_description, prd_context, request_size }),
    current_step: "context_detection",
  };
}

describe("the kind of PRD of a run (#119)", () => {
  it("keeps the declared kind over the trigger words of the description", () => {
    // "build" and "feature" would detect `feature`.
    const out = step({ state: atContextDetection("build a feature: copy button", "bug") });
    expect(out.state.prd_context).toBe("bug");
    // The run goes on to the next step and says which kind it kept.
    expect(out.state.current_step).toBe("input_analysis");
    expect(out.messages).toEqual([{ text: "PRD context: Bug Fix", level: "info" }]);
    expect(out.action.kind).not.toBe("failed");
  });

  it("asks no context question for a description that names no trigger", () => {
    const out = step({ state: atContextDetection("something unclassifiable", "incident") });
    expect(out.state.prd_context).toBe("incident");
    expect(out.action.kind).not.toBe("ask_user");
    expect(out.messages.map((m) => m.text)).toEqual(["PRD context: Incident"]);
  });

  it("says the size of a run declared tiny, and that an incident does not take it", () => {
    const tiny = step({ state: atContextDetection("x", "bug", "tiny") });
    expect(tiny.messages.map((m) => m.text)).toEqual(["PRD context: Bug Fix. Request size: Tiny change."]);
    expect(tiny.state.request_size).toBe("tiny");

    const incident = step({ state: atContextDetection("x", "incident", "tiny") });
    expect(incident.messages.map((m) => m.text)).toEqual([
      'PRD context: Incident. The declared size "tiny" is not applied: a run of this kind keeps the rounds and sections of its kind.',
    ]);
    // What the host declared stays on record; the plan is the incident's.
    expect(incident.state.request_size).toBe("tiny");
  });

  it("reads each kind from its trigger word when the host declares nothing", () => {
    const kinds = {
      proposal: ["a pitch for the board", "Proposal"],
      feature: ["implement dark mode", "Feature"],
      bug: ["the login redirect is broken", "Bug Fix"],
      incident: ["outage of the checkout", "Incident"],
      poc: ["a spike on vector search", "Proof of Concept"],
      mvp: ["the minimum viable onboarding", "MVP"],
      release: ["production launch of billing", "Release"],
      cicd: ["deploy automation for the api", "CI/CD Pipeline"],
    } as const;
    for (const [context, [description, name]] of Object.entries(kinds)) {
      const out = step({ state: atContextDetection(description) });
      expect(out.state.prd_context, description).toBe(context);
      expect(out.messages[0]?.text, description).toBe(`PRD context detected: ${name} (from trigger words)`);
    }
    expect(step({ state: atContextDetection("build a feature: copy button", null) }).state.prd_context).toBe("feature");
  });

  it("reads an incident before every other kind, so that no size shortens it", () => {
    // "fix" names a bug; the outage makes it an incident.
    const out = step({ state: atContextDetection("Outage: a one-line fix took down checkout", null, "tiny") });
    expect(out.state.prd_context).toBe("incident");
    expect(out.messages.map((m) => m.text)).toEqual([
      'PRD context detected: Incident (from trigger words). The declared size "tiny" is not applied: a run of this kind keeps the rounds and sections of its kind.',
    ]);
    expect(step({ state: atContextDetection("Outage: fix checkout") }).state.prd_context).toBe("incident");
  });

  it("says the size of a run declared tiny whose kind is detected or answered", () => {
    const detected = step({ state: atContextDetection("fix the footer typo", null, "tiny") });
    // A kind read from the words is a guess, and the fast path leaves out what an incident needs: the run says so.
    expect(detected.messages.map((m) => m.text)).toEqual([
      'PRD context detected: Bug Fix (from trigger words). Request size: Tiny change. The kind was read from the words of the description, not declared: if this request is an incident, start again with prd_context "incident", which keeps the plan of its kind.',
    ]);
    // An incident whose words do not name it is read as another kind, and takes the fast path: the limit the message is for.
    const unnamed = step({ state: atContextDetection("Checkout returns 500 since the deploy, fix it", null, "tiny") });
    expect(unnamed.state.prd_context).toBe("bug");
    expect(unnamed.messages[0].text).toContain('start again with prd_context "incident"');
    // Of ordinary size, a detected kind says nothing of it.
    expect(step({ state: atContextDetection("fix the footer typo") }).messages.map((m) => m.text)).toEqual(["PRD context detected: Bug Fix (from trigger words)"]);
    const answered = step({
      state: atContextDetection("something unclassifiable", null, "tiny"),
      result: { kind: "user_answer", question_id: "prd_context", selected: ["feature"] },
    });
    expect(answered.messages.map((m) => m.text)).toEqual(["PRD context: Feature. Request size: Tiny change."]);
  });

  it("asks which kind when no word names one, with the kinds as options", () => {
    const out = step({ state: atContextDetection("something unclassifiable") });
    expect(out.state.prd_context).toBeNull();
    expect(out.state.current_step).toBe("context_detection");
    expect(out.action).toMatchObject({
      kind: "ask_user",
      question_id: "prd_context",
      header: "Which kind of PRD?",
      multi_select: false,
    });
    if (out.action.kind !== "ask_user") return;
    // The protocol allows four options: the first four kinds.
    expect(out.action.options?.map((o) => o.label)).toEqual(["proposal", "feature", "bug", "incident"]);
    expect(out.action.description).toContain("Showing 4 of 8 kinds. You can also type any allowed kind: proposal, feature, bug, incident, poc, mvp, release, cicd.");
  });

  function answer(result: { selected: string[]; freeform?: string }, question_id = "prd_context") {
    return step({
      state: atContextDetection("something unclassifiable"),
      result: { kind: "user_answer", question_id, ...result },
    });
  }

  it("takes the answer to its question, picked or typed, whatever its case and the spaces around it", () => {
    const picked = answer({ selected: ["bug"] });
    expect(picked.state.prd_context).toBe("bug");
    expect(picked.messages.map((m) => m.text)).toEqual(["PRD context: Bug Fix"]);
    // A kind the four options do not list is typed.
    expect(answer({ selected: [], freeform: "  Release " }).state.prd_context).toBe("release");
    for (const kind of ["poc", "mvp", "release", "cicd"]) {
      const label = `  ${kind.toUpperCase()}  `;
      expect(answer({ selected: [label] }).state.prd_context).toBe(kind);
      expect(answer({ selected: [], freeform: label }).state.prd_context).toBe(kind);
    }
  });

  it("repeats the offered choices for unknown kinds", () => {
    for (const result of [{ selected: ["epic"] }, { selected: [], freeform: "tiny" }, { selected: [] }]) {
      const out = answer(result);
      expect(out.state.prd_context).toBeNull();
      expectOptionRetry(out.action, step({ state: atContextDetection("something unclassifiable") }).action, "proposal, feature, bug, incident, poc, mvp, release, cicd");
    }
  });

  it("does not read the answer to another question as the kind", () => {
    const out = answer({ selected: ["bug"] }, "clarification_answer");
    expect(out.state.prd_context).toBeNull();
    expect(out.action.kind).toBe("ask_user");
  });

  it.each([
    { name: "an answer to another question", result: { kind: "user_answer" as const, question_id: "clarification_answer", selected: ["feature"] } },
    { name: "a file_written result", result: { kind: "file_written" as const, path: "prd.md", bytes: 0 } },
    { name: "no result", result: undefined },
  ])("detects the bug from the description with $name", ({ result }) => {
    const out = step({ state: atContextDetection("fix the login bug"), result });
    expect(out.state.prd_context).toBe("bug");
    expect(out.state.current_step).toBe("input_analysis");
    expect(out.messages[0]?.text).toBe("PRD context detected: Bug Fix (from trigger words)");
  });
});
