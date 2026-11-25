import { describe, expect, it } from "vitest";
import {
  DefineHandoffV1Schema, JiraDraftSchema, JiraResultSchema, JiraTicketSchema, toHandoffTickets, unknownTicketCriterion,
  type JiraTicket,
} from "../index.js";

// Contract of architect-os 8dde031a packages/contracts/src/tickets.ts, plus the producer's prose.
const first: JiraTicket = {
  id: "TICKET-001", story_points: 3, depends_on: [], acceptance_ids: ["AC-001"],
  title: "Keep the commit", description: "Store it.", source: "FR-001", phase: 1, epic: "Evidence",
};
const second: JiraTicket = { ...first, id: "TICKET-002", story_points: 8, depends_on: ["TICKET-001"], acceptance_ids: ["AC-001", "AC-002"] };

/** The messages of a refused draft, so each refusal names its cause. */
function issues(tickets: unknown[]): string[] {
  const parsed = JiraDraftSchema.safeParse({ tickets });
  return parsed.success ? [] : parsed.error.issues.map(({ message }) => message);
}
const accepted = (tickets: unknown[]) => JiraDraftSchema.safeParse({ tickets }).success;

describe("ticket identifiers", () => {
  it.each(["TICKET-001", "TICKET-010", "TICKET-999"])("accepts %s", id => {
    expect(accepted([{ ...first, id }])).toBe(true);
  });
  it.each(["TICKET-000", "TICKET-1", "TICKET-0001", "XTICKET-001", "TICKET-001X", "ticket-001"])("refuses %s as an id and as a prerequisite", id => {
    expect(accepted([{ ...first, id }])).toBe(false);
    expect(accepted([first, { ...second, depends_on: [id] }])).toBe(false);
  });
});

describe("story points", () => {
  it.each([1, 2, 3, 5, 8, 13, 21, 34, 5527939700884757, 8944394323791464])("accepts the Fibonacci estimate %d", story_points => {
    expect(accepted([{ ...first, story_points }])).toBe(true);
  });
  it.each([0, -1, -3, 4, 6, 7, 9, 12, 14, 8944394323791465])("refuses %d", story_points => {
    expect(issues([{ ...first, story_points }])).toContain("TICKET_POINTS_INVALID");
  });
  it.each([2.5, Number.MAX_SAFE_INTEGER + 1])("refuses the non-integer or unsafe estimate %d", story_points => {
    expect(accepted([{ ...first, story_points }])).toBe(false);
  });
});

describe("links", () => {
  it("refuses duplicate prerequisites and criteria, and a ticket without criteria", () => {
    expect(issues([first, { ...second, depends_on: ["TICKET-001", "TICKET-001"] }])).toEqual(["TICKET_DEPENDENCY_DUPLICATE"]);
    expect(issues([{ ...first, acceptance_ids: ["AC-001", "AC-001"] }])).toEqual(["TICKET_ACCEPTANCE_DUPLICATE"]);
    expect(accepted([{ ...first, acceptance_ids: [] }])).toBe(false);
    expect(accepted([{ ...first, acceptance_ids: ["AC-1", "AC-2", "AC-3"] }])).toBe(true);
    expect(accepted([{ ...first, acceptance_ids: ["FR-001"] }])).toBe(false);
  });
});

describe("the ticket graph", () => {
  it("accepts a chain, a diamond and prerequisites listed after their dependents", () => {
    const third = { ...second, id: "TICKET-003", depends_on: ["TICKET-001", "TICKET-002"] };
    expect(accepted([first, second, third])).toBe(true);
    expect(accepted([third, second, first])).toBe(true);
  });

  it("names the cause of each refused graph", () => {
    expect(issues([first, first])).toEqual(["TICKET_ID_DUPLICATE"]);
    expect(issues([{ ...first, depends_on: ["TICKET-009"] }])).toEqual(["TICKET_DEPENDENCY_UNKNOWN: TICKET-001 → TICKET-009"]);
    expect(issues([first, { ...second, depends_on: ["TICKET-009"] }])).toEqual(["TICKET_DEPENDENCY_UNKNOWN: TICKET-002 → TICKET-009"]);
    expect(issues([{ ...first, depends_on: ["TICKET-001"] }])).toEqual(["TICKET_DEPENDENCY_CYCLE"]);
    expect(issues([{ ...first, depends_on: ["TICKET-002"] }, second])).toEqual(["TICKET_DEPENDENCY_CYCLE"]);
    const third = { ...second, id: "TICKET-003", depends_on: ["TICKET-002"] };
    expect(issues([first, { ...second, depends_on: ["TICKET-001", "TICKET-003"] }, third])).toEqual(["TICKET_DEPENDENCY_CYCLE"]);
  });

  it("leaves a malformed id to its item and never runs the graph on it", () => {
    for (const tickets of [
      [{ ...first, id: "TICKET-1" }, { ...second, depends_on: ["TICKET-009"] }],
      [first, { ...second, depends_on: ["TICKET-01"] }],
      [first, { ...second, depends_on: ["TICKET-009", "TICKET-01"] }],
      [{ ...first, depends_on: ["TICKET-01"] }, first],
    ]) {
      const found = issues(tickets);
      expect(found.length).toBeGreaterThan(0);
      expect(found.filter(message => message.startsWith("TICKET_"))).toEqual([]);
    }
  });

  it("checks the graph of the handoff the same way", () => {
    const handoff = {
      version: 1, run_id: "run_tickets",
      requirements: [{ id: "FR-001", text: "Keep it." }],
      acceptance: [{ id: "AC-001", text: "Read it (FR-001).", requirement_ids: ["FR-001"] }, { id: "AC-002", text: "Replay it (FR-001).", requirement_ids: ["FR-001"] }],
    };
    const handoffTickets = toHandoffTickets([first, second]);
    expect(DefineHandoffV1Schema.parse({ ...handoff, tickets: handoffTickets }).tickets).toEqual(handoffTickets);
    expect(DefineHandoffV1Schema.safeParse({ ...handoff, tickets: [] }).success).toBe(false);
    expect(DefineHandoffV1Schema.safeParse({ ...handoff, tickets: [{ ...handoffTickets[0]!, depends_on: ["TICKET-001"] }] })
      .error?.issues.map(({ message }) => message)).toEqual(["TICKET_DEPENDENCY_CYCLE"]);
    expect(DefineHandoffV1Schema.safeParse({ ...handoff, tickets: [{ ...handoffTickets[0]!, title: "x" }] }).success).toBe(false);
    expect(DefineHandoffV1Schema.safeParse({ ...handoff, tickets: [{ ...handoffTickets[0]!, acceptance_ids: ["AC-404"] }] })
      .error?.issues).toMatchObject([{ path: ["tickets"], message: "TICKET_ACCEPTANCE_UNKNOWN: TICKET-001 → AC-404" }]);
  });
});

describe("criteria of the document", () => {
  it("names the first ticket citing a criterion outside the document", () => {
    const criteria = new Set(["AC-001", "AC-002"]);
    expect(unknownTicketCriterion([first, second], criteria)).toBeUndefined();
    expect(unknownTicketCriterion([first, { ...second, acceptance_ids: ["AC-001", "AC-404"] }], criteria))
      .toBe("TICKET_ACCEPTANCE_UNKNOWN: TICKET-002 → AC-404");
    expect(unknownTicketCriterion([{ ...first, acceptance_ids: ["AC-405"] }, { ...second, acceptance_ids: ["AC-404"] }], criteria))
      .toBe("TICKET_ACCEPTANCE_UNKNOWN: TICKET-001 → AC-405");
  });
});

describe("ticket prose", () => {
  it.each(["title", "source", "epic"] as const)("keeps %s on one line with no control or format character", field => {
    expect(accepted([{ ...first, [field]: "A plain line — with punctuation, ünïcode and 12 digits" }])).toBe(true);
    for (const value of ["a\nb", "a\rb", "a\u0007b", "a‮b", "a b", "a b", "\u0000"]) {
      expect(issues([{ ...first, [field]: value }])).toEqual(["TICKET_TEXT_NOT_SINGLE_LINE"]);
    }
    expect(accepted([{ ...first, [field]: "   " }])).toBe(false);
    expect(JiraTicketSchema.parse({ ...first, [field]: "  padded  " })[field]).toBe("padded");
  });

  it("keeps description lines but no other control or format character", () => {
    expect(accepted([{ ...first, description: "First line.\n\nSecond line, longer than one character." }])).toBe(true);
    for (const value of ["a\u0007b", "a\rb", "a‮b", "a b", "a\tb"]) {
      expect(issues([{ ...first, description: value }])).toEqual(["TICKET_TEXT_CONTROL_CHARACTER"]);
    }
    expect(accepted([{ ...first, description: " \n " }])).toBe(false);
  });

  it("needs a positive integer phase", () => {
    for (const phase of [0, -1, 1.5]) expect(accepted([{ ...first, phase }])).toBe(false);
    expect(accepted([{ ...first, phase: 12 }])).toBe(true);
  });

  it("refuses unknown keys in a ticket and beside the list, and an empty list", () => {
    expect(accepted([{ ...first, total_sp: 3 }])).toBe(false);
    expect(JiraDraftSchema.safeParse({ tickets: [first], total_sp: 3 }).success).toBe(false);
    expect(accepted([])).toBe(false);
    expect(JiraDraftSchema.parse({ tickets: [first, second] })).toEqual({ tickets: [first, second] });
  });
});

describe("the recorded Jira result", () => {
  it("is passed with a valid graph, or failed with a named cause", () => {
    expect(JiraResultSchema.parse({ status: "passed", tickets: [first, second] })).toEqual({ status: "passed", tickets: [first, second] });
    for (const cause of ["invalid", "missing", "skipped"]) {
      expect(JiraResultSchema.parse({ status: "failed", cause, detail: "why" })).toEqual({ status: "failed", cause, detail: "why" });
    }
    for (const value of [
      { status: "passed", tickets: [] },
      { status: "passed", tickets: [{ ...first, depends_on: ["TICKET-001"] }] },
      { status: "failed", cause: "timeout", detail: "why" },
      { status: "failed", cause: "missing" },
      { status: "failed", cause: "missing", detail: "why", reason: "why" },
      { status: "done", tickets: [first] },
    ]) {
      expect(JiraResultSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("handoff tickets", () => {
  it("keep the estimates and links in the consumer's key order, ticket order unchanged", () => {
    const handoff = toHandoffTickets([second, first]);
    expect(handoff).toEqual([
      { id: "TICKET-002", story_points: 8, depends_on: ["TICKET-001"], acceptance_ids: ["AC-001", "AC-002"] },
      { id: "TICKET-001", story_points: 3, depends_on: [], acceptance_ids: ["AC-001"] },
    ]);
    expect(handoff.map(ticket => Object.keys(ticket))).toEqual([
      ["id", "story_points", "depends_on", "acceptance_ids"], ["id", "story_points", "depends_on", "acceptance_ids"],
    ]);
  });
});
