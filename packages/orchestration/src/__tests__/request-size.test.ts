/**
 * The size of a request, declared by the host (#119).
 *
 * Proves: (1) the description declares no size: a size word in it selects
 * nothing; (2) a run declared tiny has the four sections #119 names, whatever
 * its kind, and a run of standard size has the sections of its kind; (3) its
 * clarification asks for 4 rounds before it offers "proceed", where its kind
 * alone would ask for more, and the question composer is told the same
 * maximum; (4) an incident is never a fast path; (5) section generation
 * schedules the planned sections.
 *
 * source: #119 — an audited one-line feature run went through 8 mandatory
 * clarification rounds and 11 sections.
 */

import { describe, expect, it } from "vitest";
import {
  PRDContextSchema,
  PRD_CONTEXT_CONFIGS,
  REQUEST_SIZE_CONFIGS,
  clarificationRangeFor,
  effectiveRequestSize,
  type PRDContext,
  type RequestSize,
} from "@prd-gen/core";
import { buildClarificationPrompt } from "@prd-gen/meta-prompting";
import { newPipelineState, PipelineStateSchema, plannedSections, runRequestSize, SECTIONS_BY_CONTEXT, step } from "../index.js";
import type { PipelineState } from "../index.js";

const FAST_PATH = ["overview", "requirements", "acceptance_criteria", "testing"];
const KINDS = PRDContextSchema.options;

describe("no size is read from the description (#119)", () => {
  function detect(feature_description: string): PipelineState {
    return step({
      state: {
        ...newPipelineState({ run_id: "size_words", feature_description }),
        current_step: "context_detection",
      },
    }).state;
  }

  it("reads the kind from the words, and leaves the size standard", () => {
    for (const [description, kind] of [
      ["Build a tiny copy button for the share dialog", "feature"],
      ["Fix a one-line typo in the footer", "bug"],
      ["Implement a non-trivial OAuth feature", "feature"],
      ["Outage: a one-line config change took down checkout", "incident"],
    ] as const) {
      const state = detect(description);
      expect(state.prd_context, description).toBe(kind);
      expect(state.request_size, description).toBe("standard");
    }
  });
});

describe("the plan of a size (#119)", () => {
  it("names the four sections of the fast path and the smallest calibrated range", () => {
    expect(REQUEST_SIZE_CONFIGS.tiny.plan?.sections).toEqual(FAST_PATH);
    expect(REQUEST_SIZE_CONFIGS.tiny.plan?.clarificationRange).toEqual(PRD_CONTEXT_CONFIGS.poc.clarificationRange);
    expect(REQUEST_SIZE_CONFIGS.standard.plan).toBeNull();
  });

  it("gives a tiny run the fast path whatever its kind, except an incident", () => {
    for (const kind of KINDS) {
      const expected = kind === "incident" ? SECTIONS_BY_CONTEXT.incident : FAST_PATH;
      expect(plannedSections(kind, "tiny"), kind).toEqual(expected);
    }
  });

  it("gives a standard run the sections and the range of its kind", () => {
    for (const kind of KINDS) {
      expect(plannedSections(kind, "standard"), kind).toEqual(SECTIONS_BY_CONTEXT[kind]);
      expect(clarificationRangeFor(kind, "standard"), kind).toEqual(PRD_CONTEXT_CONFIGS[kind].clarificationRange);
    }
  });

  it("gives a tiny run the range of the fast path, and an incident its own", () => {
    expect(clarificationRangeFor("feature", "tiny")).toEqual([4, 5]);
    expect(clarificationRangeFor("incident", "tiny")).toEqual([10, 12]);
    expect(effectiveRequestSize("incident", "tiny")).toBe("standard");
    expect(effectiveRequestSize("bug", "tiny")).toBe("tiny");
  });
});

describe("clarification bounds of a size (#119)", () => {
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

  function answerRound(prd_context: PRDContext, request_size: RequestSize, round: number) {
    const state: PipelineState = {
      ...newPipelineState({ run_id: "size_clar", feature_description: "x", prd_context, request_size }),
      current_step: "clarification",
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
    });
  }

  it("offers proceed after the 4th answer of a tiny feature run, with the bounds of the fast path", () => {
    const { action } = answerRound("feature", "tiny", 4);
    expect(action.kind).toBe("ask_user");
    if (action.kind !== "ask_user") return;
    expect(action.options?.map((o) => o.label)).toEqual(["proceed", "continue"]);
    expect(action.description).toBe("Min for this run: 4. Max: 5. 'proceed' to generate the PRD, 'continue' for more questions.");
  });

  it("reports four completed rounds when the user proceeds", () => {
    const { state } = answerRound("feature", "tiny", 4);
    const out = step({ state, result: { kind: "user_answer", question_id: "clarification_continue", selected: ["proceed"] } });
    expect(out.messages).toContainEqual({ level: "info", text: "Clarification complete (4 rounds)." });
  });

  it("requests round five when the user continues after four answers", () => {
    const { state } = answerRound("feature", "tiny", 4);
    const out = step({ state, result: { kind: "user_answer", question_id: "clarification_continue", selected: ["continue"] } });
    expect(out.action).toMatchObject({ kind: "spawn_subagents", batch_id: "clarification_compose_5" });
  });

  it("asks a 4th question after the 3rd answer of a tiny run", () => {
    expect(answerRound("feature", "tiny", 3).action.kind).toBe("spawn_subagents");
  });

  it("still asks a 5th question after the 4th answer of a standard feature run", () => {
    expect(answerRound("feature", "standard", 4).action.kind).toBe("spawn_subagents");
  });

  it("still asks a 5th question after the 4th answer of an incident declared tiny", () => {
    expect(answerRound("incident", "tiny", 4).action.kind).toBe("spawn_subagents");
  });

  it("tells the question composer the maximum of the size", () => {
    const prompt = (request_size?: RequestSize) =>
      buildClarificationPrompt({
        feature_description: "x",
        prd_context: "feature",
        request_size,
        round: 1,
        prior_qa: [],
        recall_summary: "",
      });
    expect(prompt("tiny")).toContain("<round>1 of 5</round>");
    expect(prompt("standard")).toContain("<round>1 of 10</round>");
    expect(prompt()).toContain("<round>1 of 10</round>");
  });

  it("hands the size of the run to the question composer", () => {
    const state: PipelineState = {
      ...newPipelineState({ run_id: "size_compose", feature_description: "x", prd_context: "feature", request_size: "tiny" }),
      current_step: "clarification",
    };
    const action = step({ state }).action;
    expect(action.kind).toBe("spawn_subagents");
    if (action.kind !== "spawn_subagents") return;
    expect(action.invocations[0].prompt).toContain("<round>1 of 5</round>");
  });
});

describe("section generation of a size (#119)", () => {
  function scheduled(prd_context: PRDContext, request_size: RequestSize): string[] {
    const state: PipelineState = {
      ...newPipelineState({ run_id: "size_sections", feature_description: "x", prd_context, request_size }),
      current_step: "section_generation",
      preflight_status: "skipped",
    };
    return step({ state }).state.sections.map((s) => s.section_type);
  }

  it("schedules the four sections of the fast path for a tiny bug fix", () => {
    expect(scheduled("bug", "tiny")).toEqual(FAST_PATH);
  });

  it("schedules the sections of the kind for a standard run and for an incident declared tiny", () => {
    expect(scheduled("bug", "standard")).toEqual([...SECTIONS_BY_CONTEXT.bug]);
    expect(scheduled("incident", "tiny")).toEqual([...SECTIONS_BY_CONTEXT.incident]);
  });
});

describe("a run kept before the size existed (#119)", () => {
  it("is read as a run of standard size", () => {
    const { request_size: _dropped, ...kept } = newPipelineState({ run_id: "kept", feature_description: "x" });
    expect(PipelineStateSchema.parse(kept).request_size).toBe("standard");
    expect(PipelineStateSchema.safeParse({ ...kept, request_size: "huge" }).success).toBe(false);
  });
});

describe("the size a run says it has (#119)", () => {
  it("is the declared size while the kind is not known, then the one the kind takes", () => {
    expect(runRequestSize({ prd_context: null, request_size: "tiny" })).toBe("tiny");
    expect(runRequestSize({ prd_context: null, request_size: "standard" })).toBe("standard");
    expect(runRequestSize({ prd_context: "bug", request_size: "tiny" })).toBe("tiny");
    expect(runRequestSize({ prd_context: "incident", request_size: "tiny" })).toBe("standard");
    expect(runRequestSize({ prd_context: "bug", request_size: "standard" })).toBe("standard");
  });
});

describe("the header of the exported PRD (#119)", () => {
  function prdHeader(request_size: RequestSize): string {
    const section = (section_type: "overview") => ({
      section_type,
      status: "passed" as const,
      attempt: 1,
      violation_count: 0,
      last_violations: [],
      attempt_log: [],
      content: "overview content",
    });
    let state: PipelineState = {
      ...newPipelineState({ run_id: "size_header", feature_description: "x", prd_context: "bug", request_size }),
      current_step: "file_export",
      sections: [section("overview")],
    };
    let out = step({ state });
    for (let i = 0; i < 20 && out.action.kind === "write_file"; i++) {
      if (out.action.path.endsWith("01-prd.md")) return out.action.content;
      out = step({ state, result: { kind: "file_written", path: out.action.path, bytes: 1 } });
      state = out.state;
    }
    throw new Error("01-prd.md was not written");
  }

  it("says the kind and the size the run was held to", () => {
    expect(prdHeader("tiny")).toContain("\nContext: bug\nRequest size: tiny\n");
    expect(prdHeader("standard")).toContain("\nContext: bug\nRequest size: standard\n");
  });
});
