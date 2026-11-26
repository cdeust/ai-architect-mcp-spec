import { describe, expect, it } from "vitest";
import { handleJiraGeneration } from "../handlers/jira-generation.js";
import { parseJiraDraft, renderJiraTickets } from "../handlers/jira-ticket-draft.js";
import { ERROR_MESSAGE_CHARS } from "../types/state/bounded-io.js";
import { buildJiraPrompt } from "@prd-gen/meta-prompting";
import { newPipelineState } from "../index.js";

const first = {
  id: "TICKET-001", title: "Retain the evidence", description: "Save the verified record.",
  source: "FR-001", phase: 1, epic: "Evidence", story_points: 3, depends_on: [], acceptance_ids: ["AC-001"],
};
const second = { ...first, id: "TICKET-002", phase: 2, story_points: 8, depends_on: [first.id] };
const state = {
  ...newPipelineState({ run_id: "run_jira_contract", feature_description: "Evidence" }),
  current_step: "jira_generation" as const,
  sections: [{
    section_type: "acceptance_criteria" as const, status: "passed" as const, attempt: 1, violation_count: 0,
    last_violations: [], attempt_log: [], content: "- AC-001: Read the saved evidence (FR-001).",
  }],
};

function submit(raw_text: string) {
  return handleJiraGeneration({ state, result: {
    kind: "subagent_batch_result", batch_id: "jira_generation_tickets",
    responses: [{ invocation_id: "jira_generation_engineer", raw_text }],
  } });
}

describe("Jira generation contract", () => {
  it("requests JSON and renders the same validated tickets with computed totals", () => {
    const start = handleJiraGeneration({ state });
    expect(start.action).toMatchObject({ invocations: [{ prompt: expect.stringContaining("Output ONLY JSON") }] });
    const result = submit(JSON.stringify({ tickets: [first, second] }));
    expect(result.state).toMatchObject({ jira_result: { status: "passed", tickets: [first, second] } });
    // The checkpoint keeps the tickets once; file_export renders 07 from them.
    expect(result.state.sections.some(section => section.section_type === "jira_tickets")).toBe(false);
    const rendered = renderJiraTickets([first, second]);
    for (const fragment of ["## Phase 1", "## Phase 2", "Evidence (3 SP)", "TICKET-002", "> Save the verified record.",
      "Acceptance Criteria:** AC-001", "Depends On:** TICKET-001", "Source:** FR-001", "| **Total** | 2 | 11 |"]) {
      expect(rendered).toContain(fragment);
    }
  });

  it.each([
    ["extra key", [{ ...first, extra: true }], "Unrecognized key"],
    ["wrong ID", [{ ...first, id: "TICKET-1" }], "tickets[0].id"],
    ["empty description", [{ ...first, description: "  " }], "tickets[0].description"],
    ["empty title", [{ ...first, title: "" }], "tickets[0].title"],
    ["empty epic", [{ ...first, epic: " " }], "tickets[0].epic"],
    ["invalid phase", [{ ...first, phase: 0 }], "tickets[0].phase"],
    ["fractional phase", [{ ...first, phase: 1.5 }], "tickets[0].phase"],
    ["empty source", [{ ...first, source: "" }], "tickets[0].source"],
    ["no tickets", [], "tickets"],
    ["duplicate ticket", [first, first], "TICKET_ID_DUPLICATE"],
    ["unknown prerequisite", [{ ...first, depends_on: [second.id] }], "TICKET_DEPENDENCY_UNKNOWN: TICKET-001 → TICKET-002"],
    ["duplicate prerequisite", [first, { ...second, depends_on: [first.id, first.id] }], "TICKET_DEPENDENCY_DUPLICATE"],
    ["self-dependency", [{ ...first, depends_on: [first.id] }], "TICKET_DEPENDENCY_CYCLE"],
    ["cycle", [{ ...first, depends_on: [second.id] }, second], "TICKET_DEPENDENCY_CYCLE"],
    ["cycle behind a valid root", [first, { ...second, depends_on: [first.id, "TICKET-003"] },
      { ...second, id: "TICKET-003", depends_on: [second.id] }], "TICKET_DEPENDENCY_CYCLE"],
    ["non-Fibonacci estimate", [{ ...first, story_points: 4 }], "TICKET_POINTS_INVALID"],
    ["non-Fibonacci estimate between 8 and 13", [{ ...first, story_points: 9 }], "TICKET_POINTS_INVALID"],
    ["zero estimate", [{ ...first, story_points: 0 }], "TICKET_POINTS_INVALID"],
    ["negative estimate", [{ ...first, story_points: -1 }], "TICKET_POINTS_INVALID"],
    ["fractional estimate", [{ ...first, story_points: 2.5 }], "tickets[0].story_points"],
    ["non-safe estimate", [{ ...first, story_points: Number.MAX_SAFE_INTEGER + 1 }], "tickets[0].story_points"],
    ["unknown criterion", [{ ...first, acceptance_ids: ["AC-404"] }], "TICKET_ACCEPTANCE_UNKNOWN: TICKET-001 → AC-404"],
    ["unknown criterion beside a known one", [first, { ...second, acceptance_ids: ["AC-001", "AC-404"] }],
      "TICKET_ACCEPTANCE_UNKNOWN: TICKET-002 → AC-404"],
    ["duplicate criterion", [{ ...first, acceptance_ids: ["AC-001", "AC-001"] }], "TICKET_ACCEPTANCE_DUPLICATE"],
    ["no criteria", [{ ...first, acceptance_ids: [] }], "tickets[0].acceptance_ids"],
    ["four-digit ID", [{ ...first, id: "TICKET-0001" }], "tickets[0].id"],
    ["ticket zero", [{ ...first, id: "TICKET-000" }], "tickets[0].id"],
    ["prerequisite zero", [{ ...first, depends_on: ["TICKET-000"] }], "tickets[0].depends_on[0]"],
    ["prefixed ID", [{ ...first, id: "XTICKET-001" }], "tickets[0].id"],
    ["malformed prerequisite", [{ ...first, depends_on: ["TICKET-01"] }], "tickets[0].depends_on[0]"],
    ["multi-line title", [{ ...first, title: "x\n## Phase 9 (0 SP)" }], "TICKET_TEXT_NOT_SINGLE_LINE"],
    ["multi-line epic", [{ ...first, epic: "E\n## Summary" }], "TICKET_TEXT_NOT_SINGLE_LINE"],
    ["multi-line source", [{ ...first, source: "FR-001\n- **Story Points:** 1" }], "TICKET_TEXT_NOT_SINGLE_LINE"],
    ["invisible format character in a title", [{ ...first, title: "Keep\u202Eit" }], "TICKET_TEXT_NOT_SINGLE_LINE"],
    ["control character in a description", [{ ...first, description: "a\u0007b" }], "TICKET_TEXT_CONTROL_CHARACTER"],
  ])("refuses %s before publishing the Jira section", (_label, tickets, cause) => {
    const result = submit(JSON.stringify({ tickets }));
    expect(result.state).toMatchObject({
      current_step: "file_export",
      jira_result: { status: "failed", cause: "invalid", detail: expect.stringContaining(cause) },
    });
    expect(result.state.errors.at(-1)).toMatch(/^\[jira_generation\] failed: invalid: /);
    expect(result.action).toMatchObject({ kind: "emit_message", level: "warn", message: expect.stringContaining("jira_tickets_invalid") });
  });

  it.each([1, 2, 3, 5, 8, 13, 21, 5527939700884757])("accepts the Fibonacci estimate %d", story_points => {
    expect(submit(JSON.stringify({ tickets: [{ ...first, story_points }] })).state.jira_result).toMatchObject({ status: "passed" });
  });

  it("accepts prerequisites listed after their dependents", () => {
    expect(submit(JSON.stringify({ tickets: [second, first] })).state.jira_result).toEqual({ status: "passed", tickets: [second, first] });
  });

  it("records a missing or failed engineer response as a failed result", () => {
    const failed = handleJiraGeneration({ state, result: {
      kind: "subagent_batch_result", batch_id: "jira_generation_tickets",
      responses: [{ invocation_id: "jira_generation_engineer", error: "timeout" }],
    } });
    expect(failed.state).toMatchObject({ current_step: "file_export", jira_result: { status: "failed", cause: "missing", detail: "timeout" } });
    expect(failed.state.errors.at(-1)).toBe("[jira_generation] failed: missing: timeout");
    expect(failed.state.error_kinds.at(-1)).toBe("upstream_failure");
    const missing = handleJiraGeneration({ state, result: { kind: "subagent_batch_result", batch_id: "jira_generation_tickets", responses: [] } });
    expect(missing.state.jira_result).toEqual({ status: "failed", cause: "missing", detail: "no response" });
    expect(missing.action).toEqual({ kind: "emit_message", level: "warn", message: "JIRA generation failed; proceeding to file export anyway." });
  });

  it("renders phases in order, epics in first-seen order and exact totals", () => {
    const big = { ...first, id: "TICKET-003", phase: 1, epic: "Audit", story_points: 5527939700884757, depends_on: [], title: "Audit", description: "Audit it." };
    const bigger = { ...big, id: "TICKET-004", story_points: 8944394323791464 };
    const result = submit(JSON.stringify({ tickets: [second, first, big, bigger] }));
    if (result.state.jira_result?.status !== "passed") throw new Error("Expected passed tickets");
    expect(renderJiraTickets(result.state.jira_result.tickets)).toBe([
      "# JIRA Tickets",
      "## Phase 1 (14472334024676224 SP)",
      "### Evidence (3 SP)",
      "#### TICKET-001 — Retain the evidence\n\n> Save the verified record.\n\n- **Acceptance Criteria:** AC-001\n- **Story Points:** 3\n- **Depends On:** None\n- **Source:** FR-001",
      "### Audit (14472334024676221 SP)",
      "#### TICKET-003 — Audit\n\n> Audit it.\n\n- **Acceptance Criteria:** AC-001\n- **Story Points:** 5527939700884757\n- **Depends On:** None\n- **Source:** FR-001",
      "#### TICKET-004 — Audit\n\n> Audit it.\n\n- **Acceptance Criteria:** AC-001\n- **Story Points:** 8944394323791464\n- **Depends On:** None\n- **Source:** FR-001",
      "## Phase 2 (8 SP)",
      "### Evidence (8 SP)",
      "#### TICKET-002 — Retain the evidence\n\n> Save the verified record.\n\n- **Acceptance Criteria:** AC-001\n- **Story Points:** 8\n- **Depends On:** TICKET-001\n- **Source:** FR-001",
      "## Summary\n\n| Phase | Story Count | Total SP |\n| --- | ---: | ---: |\n| Phase 1 | 3 | 14472334024676224 |\n| Phase 2 | 1 | 8 |\n| **Total** | 4 | 14472334024676232 |",
    ].join("\n\n"));
  });

  it("refuses raw Markdown rather than treating a new result as legacy", () => {
    const refused = submit("# JIRA Tickets");
    expect(refused.action).toEqual({
      kind: "emit_message", level: "warn",
      message: "jira_tickets_invalid: the generated tickets were refused; proceeding to file export without them.",
    });
    expect(refused.state.jira_result).toEqual({
      status: "failed", cause: "invalid",
      detail: "Expected a JSON object containing tickets: no JSON object found in response",
    });
  });

  it("refuses keys beside the ticket list", () => {
    expect(submit(JSON.stringify({ tickets: [first], total_sp: 3 })).state.jira_result)
      .toMatchObject({ status: "failed", detail: expect.stringContaining("total_sp") });
  });

  it("bounds the refusal of a large malformed reply to one error entry", () => {
    const wrong = Array.from({ length: 300 }, (_, index) => ({ id: `TICKET-${String(index).padStart(3, "0")}`, points: 3, summary: "x" }));
    const refused = submit(JSON.stringify({ tickets: wrong })).state;
    if (refused.jira_result?.status !== "failed") throw new Error("Expected a refusal");
    expect(refused.jira_result.detail.length).toBeLessThanOrEqual(ERROR_MESSAGE_CHARS);
    expect(refused.jira_result.detail).toMatch(/\(and \d+ more issue\(s\)\)$/);
    expect(refused.errors.every(error => error.length <= ERROR_MESSAGE_CHARS)).toBe(true);
    const empty = (id: string) => ({ ...first, id, title: "" });
    const three = submit(JSON.stringify({ tickets: [empty("TICKET-001"), empty("TICKET-002"), empty("TICKET-003")] })).state.jira_result;
    expect(three).toMatchObject({ detail: expect.not.stringContaining("more issue") });
    const four = submit(JSON.stringify({ tickets: ["TICKET-001", "TICKET-002", "TICKET-003", "TICKET-004"].map(empty) })).state.jira_result;
    expect(four).toMatchObject({ detail: expect.stringMatching(/\n\(and 1 more issue\(s\)\)$/) });
    // A few issues can still be long: a refused key is named in full by the validator.
    const longKey = submit(JSON.stringify({ tickets: [{ ...first, ["k".repeat(2_000)]: 1 }] })).state;
    expect(longKey.jira_result).toMatchObject({ detail: expect.stringContaining("kkkk") });
    if (longKey.jira_result?.status !== "failed") throw new Error("Expected a refusal");
    expect(longKey.jira_result.detail).toHaveLength(ERROR_MESSAGE_CHARS);
    const timeout = handleJiraGeneration({ state, result: {
      kind: "subagent_batch_result", batch_id: "jira_generation_tickets",
      responses: [{ invocation_id: "jira_generation_engineer", error: "e".repeat(2_000) }],
    } }).state.jira_result;
    expect(timeout).toEqual({ status: "failed", cause: "missing", detail: "e".repeat(ERROR_MESSAGE_CHARS) });
  });

  it("never echoes a malformed prerequisite from the graph check", () => {
    const long = `TICKET-${"9".repeat(5_000)}`;
    const refused = submit(JSON.stringify({ tickets: [{ ...first, depends_on: [long] }] })).state.jira_result;
    expect(refused).toMatchObject({ status: "failed", detail: expect.stringContaining("tickets[0].depends_on[0]") });
    if (refused?.status !== "failed") throw new Error("Expected a refusal");
    expect(refused.detail).not.toContain("9".repeat(20));
    expect(refused.detail).not.toContain("TICKET_DEPENDENCY_UNKNOWN");
  });

  it("does not take a criterion from a failed acceptance draft", () => {
    const withFailed = { ...state, sections: [...state.sections, {
      section_type: "acceptance_criteria" as const, status: "failed" as const, attempt: 3, violation_count: 1,
      last_violations: [], attempt_log: [], content: "- AC-002: A rejected criterion (FR-001).",
    }] };
    const refused = handleJiraGeneration({ state: withFailed, result: {
      kind: "subagent_batch_result", batch_id: "jira_generation_tickets",
      responses: [{ invocation_id: "jira_generation_engineer", raw_text: JSON.stringify({ tickets: [{ ...first, acceptance_ids: ["AC-002"] }] }) }],
    } }).state.jira_result;
    expect(refused).toMatchObject({ status: "failed", detail: "TICKET_ACCEPTANCE_UNKNOWN: TICKET-001 → AC-002" });
  });

  it.each(["TICKET-001", "TICKET-999"])("accepts the ticket ID %s", id => {
    expect(submit(JSON.stringify({ tickets: [{ ...first, id }] })).state.jira_result).toMatchObject({ status: "passed" });
  });

  it("keeps the Markdown reply of a request made before the structured one", () => {
    const markdown = handleJiraGeneration({ state, result: {
      kind: "subagent_batch_result", batch_id: "jira_generation",
      responses: [{ invocation_id: "jira_generation_engineer", raw_text: "  # Saved tickets\n" }],
    } });
    expect(markdown.state.jira_result).toBeUndefined();
    expect(markdown.state.current_step).toBe("file_export");
    expect(markdown.state.sections.at(-1)).toEqual({
      section_type: "jira_tickets", status: "passed", attempt: 1, violation_count: 0,
      last_violations: [], attempt_log: [], content: "# Saved tickets",
    });
    // Only the engineer's reply is the ticket document.
    const foreignFirst = handleJiraGeneration({ state, result: {
      kind: "subagent_batch_result", batch_id: "jira_generation",
      responses: [{ invocation_id: "other", raw_text: "# Not tickets" }, { invocation_id: "jira_generation_engineer", raw_text: "# Saved tickets" }],
    } });
    expect(foreignFirst.state.sections.at(-1)).toMatchObject({ content: "# Saved tickets" });
    expect(markdown.action).toEqual({ kind: "emit_message", message: "JIRA tickets generated. Writing files." });
    for (const responses of [[], [{ invocation_id: "jira_generation_engineer", raw_text: "  " }]]) {
      const empty = handleJiraGeneration({ state, result: { kind: "subagent_batch_result", batch_id: "jira_generation", responses } });
      expect(empty.state.jira_result).toBeUndefined();
      expect(empty.state.sections.some(section => section.section_type === "jira_tickets")).toBe(false);
      expect(empty.state.errors.at(-1)).toBe("[jira_generation] failed: no response");
      expect(empty.state.error_kinds.at(-1)).toBe("upstream_failure");
      expect(empty.state.current_step).toBe("file_export");
      expect(empty.action).toEqual({ kind: "emit_message", level: "warn", message: "JIRA generation failed; proceeding to file export anyway." });
    }
    // A failed reply is not a deliverable, even with partial text.
    const partial = handleJiraGeneration({ state, result: {
      kind: "subagent_batch_result", batch_id: "jira_generation",
      responses: [{ invocation_id: "jira_generation_engineer", raw_text: "# Half a document", error: "timeout" }],
    } });
    expect(partial.state.sections.some(section => section.section_type === "jira_tickets")).toBe(false);
    expect(partial.state.errors.at(-1)).toBe("[jira_generation] failed: timeout");
    expect(partial.state.jira_result).toBeUndefined();
    const errorOnly = handleJiraGeneration({ state, result: {
      kind: "subagent_batch_result", batch_id: "jira_generation",
      responses: [{ invocation_id: "jira_generation_engineer", error: "timeout" }],
    } });
    expect(errorOnly.state.errors.at(-1)).toBe("[jira_generation] failed: timeout");
    expect(handleJiraGeneration({ state }).action).toMatchObject({ batch_id: "jira_generation_tickets" });
  });

  it("ignores a result of another batch and asks the engineer", () => {
    const other = handleJiraGeneration({ state, result: {
      kind: "subagent_batch_result", batch_id: "section_generate_requirements",
      responses: [{ invocation_id: "jira_generation_engineer", raw_text: JSON.stringify({ tickets: [first] }) }],
    } });
    expect(other.state.jira_result).toBeUndefined();
    expect(other.action).toMatchObject({ kind: "spawn_subagents", batch_id: "jira_generation_tickets" });
  });

  it("records an empty engineer error as no response", () => {
    const empty = handleJiraGeneration({ state, result: {
      kind: "subagent_batch_result", batch_id: "jira_generation_tickets",
      responses: [{ invocation_id: "jira_generation_engineer", error: "" }],
    } });
    expect(empty.state.jira_result).toEqual({ status: "failed", cause: "missing", detail: "no response" });
  });

  it("cuts a long detail without splitting a character", () => {
    const astral = handleJiraGeneration({ state, result: {
      kind: "subagent_batch_result", batch_id: "jira_generation_tickets",
      responses: [{ invocation_id: "jira_generation_engineer", error: "e".repeat(ERROR_MESSAGE_CHARS - 1) + "😀😀" }],
    } }).state.jira_result;
    expect(astral).toEqual({ status: "failed", cause: "missing", detail: "e".repeat(ERROR_MESSAGE_CHARS - 1) });
  });

  it("accepts a diamond graph", () => {
    const third = { ...second, id: "TICKET-003", depends_on: ["TICKET-001", "TICKET-002"] };
    expect(submit(JSON.stringify({ tickets: [first, second, third] })).state.jira_result).toMatchObject({ status: "passed" });
  });

  it("reads the example of its own prompt as valid tickets", () => {
    const prompt = buildJiraPrompt({ feature_description: "x", source_sections: [] });
    const example = /Output ONLY JSON in this form, with no other keys, preamble or fences: (\{.*\})$/m.exec(prompt)![1]!;
    expect(parseJiraDraft(example, new Set(["AC-001"]))).toHaveProperty("tickets");
  });
});

describe("the rendered 07 deliverable", () => {
  it("lists every link, quotes the description and sorts phases numerically", () => {
    const linked = { ...first, id: "TICKET-002", phase: 10, acceptance_ids: ["AC-001", "AC-002"], depends_on: ["TICKET-001", "TICKET-003"],
      description: "First line.\n\n## Not a heading" };
    const rendered = renderJiraTickets([linked, { ...first, phase: 2 }, { ...first, id: "TICKET-003", phase: 2 }]);
    expect(rendered).toContain("- **Acceptance Criteria:** AC-001, AC-002");
    expect(rendered).toContain("- **Depends On:** TICKET-001, TICKET-003");
    expect(rendered).toContain("> First line.\n>\n> ## Not a heading");
    expect(rendered.indexOf("## Phase 2 ")).toBeLessThan(rendered.indexOf("## Phase 10 "));
    expect(rendered.split("\n").filter(line => line.startsWith("## Phase"))).toEqual(["## Phase 2 (6 SP)", "## Phase 10 (3 SP)"]);
  });
});
