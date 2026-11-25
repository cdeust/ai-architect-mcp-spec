import { describe, expect, it } from "vitest";
import { handleJiraGeneration } from "../handlers/jira-generation.js";
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
    kind: "subagent_batch_result", batch_id: "jira_generation",
    responses: [{ invocation_id: "jira_generation_engineer", raw_text }],
  } });
}

describe("Jira generation contract", () => {
  it("requests JSON and renders the same validated tickets with computed totals", () => {
    const start = handleJiraGeneration({ state });
    expect(start.action).toMatchObject({ invocations: [{ prompt: expect.stringContaining("Output ONLY JSON") }] });
    const result = submit(JSON.stringify({ tickets: [first, second] }));
    expect(result.state).toMatchObject({ jira_result: { status: "passed", tickets: [first, second] } });
    const jira = result.state.sections.find(section => section.section_type === "jira_tickets");
    expect(jira?.status).toBe("passed");
    for (const fragment of ["## Phase 1", "## Phase 2", "Evidence (3 SP)", "TICKET-002", "Save the verified record.",
      "Acceptance Criteria:** AC-001", "Depends On:** TICKET-001", "Source:** FR-001", "| **Total** | 2 | 11 | ".trim()]) {
      expect(jira?.content).toContain(fragment);
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
  ])("refuses %s before publishing the Jira section", (_label, tickets, cause) => {
    const result = submit(JSON.stringify({ tickets }));
    expect(result.state.sections.some(section => section.section_type === "jira_tickets")).toBe(false);
    expect(result.state).toMatchObject({
      current_step: "file_export",
      jira_result: { status: "failed", reason: expect.stringContaining(cause) },
    });
    expect(result.state.jira_result).toMatchObject({ reason: expect.stringMatching(/^jira_tickets_invalid: /) });
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
      kind: "subagent_batch_result", batch_id: "jira_generation",
      responses: [{ invocation_id: "jira_generation_engineer", error: "timeout" }],
    } });
    expect(failed.state).toMatchObject({ current_step: "file_export", jira_result: { status: "failed", reason: "timeout" } });
    expect(failed.state.errors.at(-1)).toBe("[jira_generation] failed: timeout");
    expect(failed.state.error_kinds.at(-1)).toBe("upstream_failure");
    const missing = handleJiraGeneration({ state, result: { kind: "subagent_batch_result", batch_id: "jira_generation", responses: [] } });
    expect(missing.state.jira_result).toEqual({ status: "failed", reason: "no response" });
    expect(missing.action).toEqual({ kind: "emit_message", level: "warn", message: "JIRA generation failed; proceeding to file export anyway." });
  });

  it("renders phases in order, epics in first-seen order and exact totals", () => {
    const big = { ...first, id: "TICKET-003", phase: 1, epic: "Audit", story_points: 5527939700884757, depends_on: [], title: "Audit", description: "Audit it." };
    const bigger = { ...big, id: "TICKET-004", story_points: 8944394323791464 };
    const result = submit(JSON.stringify({ tickets: [second, first, big, bigger] }));
    const jira = result.state.sections.find(section => section.section_type === "jira_tickets");
    expect(jira?.content).toBe([
      "# JIRA Tickets",
      "## Phase 1 (14472334024676224 SP)",
      "### Evidence (3 SP)",
      "#### TICKET-001 — Retain the evidence\n\nSave the verified record.\n\n- **Acceptance Criteria:** AC-001\n- **Story Points:** 3\n- **Depends On:** None\n- **Source:** FR-001",
      "### Audit (14472334024676221 SP)",
      "#### TICKET-003 — Audit\n\nAudit it.\n\n- **Acceptance Criteria:** AC-001\n- **Story Points:** 5527939700884757\n- **Depends On:** None\n- **Source:** FR-001",
      "#### TICKET-004 — Audit\n\nAudit it.\n\n- **Acceptance Criteria:** AC-001\n- **Story Points:** 8944394323791464\n- **Depends On:** None\n- **Source:** FR-001",
      "## Phase 2 (8 SP)",
      "### Evidence (8 SP)",
      "#### TICKET-002 — Retain the evidence\n\nSave the verified record.\n\n- **Acceptance Criteria:** AC-001\n- **Story Points:** 8\n- **Depends On:** TICKET-001\n- **Source:** FR-001",
      "## Summary\n\n| Phase | Story Count | Total SP |\n| --- | ---: | ---: |\n| Phase 1 | 3 | 14472334024676224 |\n| Phase 2 | 1 | 8 |\n| **Total** | 4 | 14472334024676232 |",
    ].join("\n\n"));
  });

  it("refuses raw Markdown rather than treating a new result as legacy", () => {
    expect(submit("# JIRA Tickets").action).toMatchObject({
      kind: "emit_message", level: "warn", message: expect.stringContaining("jira_tickets_invalid"),
    });
  });
});
