import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildVerifiedPlan, defineEnvelopeText, newPipelineState, PipelineStateSchema, readDefineHandoff, step,
  type NextAction, type PipelineState,
} from "../index.js";
import { REMEMBER_CORRELATION_ID } from "../handlers/finalize.js";
import { handleFileExport } from "../handlers/file-export.js";
import { handleJiraGeneration } from "../handlers/jira-generation.js";

const run_id = "run_define_tickets";
const pending: NextAction = {
  kind: "ask_user", question_id: "implementation_gate", header: "Specification verification",
  description: "Choose", multi_select: false,
  options: [{ label: "PRD only" }, { label: "Review verification findings" }],
};
const prose = { title: "Keep the commit", description: "Store the verified commit.", source: "FR-001", phase: 1, epic: "Evidence" };
const first = { id: "TICKET-001", ...prose, story_points: 3, depends_on: [], acceptance_ids: ["AC-001"] };
const second = { id: "TICKET-002", ...prose, phase: 2, story_points: 8, depends_on: ["TICKET-001"], acceptance_ids: ["AC-002", "AC-001"] };

function ready(jira?: PipelineState["jira_result"]): PipelineState {
  const sections = [
    ["requirements", "- FR-001: Keep the validated commit."],
    ["acceptance_criteria", "- AC-001: Verify the saved commit (FR-001).\n- AC-002: Replay the saved commit (FR-001)."],
    ["testing", "Replay AC-001 and AC-002 against the same commit."],
  ] as const;
  return {
    ...newPipelineState({ run_id, feature_description: "Verify the delivery" }),
    current_step: "implementation_gate",
    written_files: [`prd-output/${run_id}/01-prd.md`],
    ...(jira && { jira_result: jira }),
    sections: sections.map(([section_type, content]) => ({
      section_type, content, status: "passed", attempt: 1, violation_count: 0, last_violations: [], attempt_log: [],
    })),
    pending_completion: {
      summary: "Self-check complete.",
      artifacts: [],
      outcome: { status: "passed", reasons: [] },
      verification: {
        claims_evaluated: 3, distribution_suspicious: false, total_subjective_claims: 0,
        distribution: { PASS: 3, FAIL: 0, INCONCLUSIVE: 0, "NEEDS-RUNTIME": 0, "SPEC-COMPLETE": 0 },
        judge_verdicts: ["FR-001", "AC-001", "AC-002"].map(claim_id => ({
          claim_id, judge: { kind: "genius", name: "dijkstra" }, verdict: "PASS",
          confidence: 0.9, rationale: "Synthetic evidence.", caveats: [],
        })),
      },
    },
  };
}

const passed = (tickets = [first, second]) => ({ status: "passed" as const, tickets });

function envelope(state: PipelineState, action: NextAction | null): string {
  const read = readDefineHandoff(state, action);
  if ("error" in read) throw new Error(`${read.error.code}: ${read.error.message}`);
  return defineEnvelopeText(read.handoff);
}

const sha = (text: string) => createHash("sha256").update(text + "\n").digest("hex");

/** Answer the pending gate with "PRD only" and finish the run, as a host would. */
function finishPrdOnly(start: PipelineState) {
  const report = step({ state: start });
  if (report.action.kind !== "write_file") throw new Error("Expected the verification report");
  const asked = step({ state: report.state, result: {
    kind: "file_written", path: report.action.path, bytes: Buffer.byteLength(report.action.content),
  } });
  expect(asked.action).toMatchObject({ kind: "ask_user", question_id: "implementation_gate" });
  const answered = step({ state: asked.state, result: {
    kind: "user_answer", question_id: "implementation_gate", selected: ["PRD only"], freeform: "",
  } });
  expect(answered.action).toMatchObject({ kind: "call_cortex_tool", correlation_id: REMEMBER_CORRELATION_ID });
  const done = step({ state: answered.state, result: {
    kind: "tool_result", correlation_id: REMEMBER_CORRELATION_ID, success: true,
  } });
  expect(done.action).toMatchObject({ kind: "done" });
  return { asked, answered, done };
}

describe("Define v1 tickets", () => {
  it("serves the consumer's ticket keys, in its order, after the criteria", () => {
    expect(envelope(ready(passed()), pending)).toBe(JSON.stringify({ handoff: {
      version: 1, run_id,
      requirements: [{ id: "FR-001", text: "Keep the validated commit." }],
      acceptance: [
        { id: "AC-001", text: "Verify the saved commit (FR-001).", requirement_ids: ["FR-001"] },
        { id: "AC-002", text: "Replay the saved commit (FR-001).", requirement_ids: ["FR-001"] },
      ],
      tickets: [
        { id: "TICKET-001", story_points: 3, depends_on: [], acceptance_ids: ["AC-001"] },
        { id: "TICKET-002", story_points: 8, depends_on: ["TICKET-001"], acceptance_ids: ["AC-002", "AC-001"] },
      ],
    } }));
  });

  it("leaves tickets absent for a checkpoint of the Markdown-only generator", () => {
    const text = envelope(ready(), pending);
    expect(JSON.parse(text).handoff).not.toHaveProperty("tickets");
    expect(text).not.toContain('"tickets"');
  });

  it("refuses a run whose generated tickets were refused instead of publishing it without them", () => {
    const failed = { status: "failed" as const, reason: "jira_tickets_invalid: TICKET_DEPENDENCY_CYCLE" };
    expect(readDefineHandoff(ready(failed), pending)).toEqual({ error: {
      code: "define_not_ready", message: "jira_tickets_invalid: jira_tickets_invalid: TICKET_DEPENDENCY_CYCLE",
    } });
    const broken = ready(failed);
    broken.sections = broken.sections.filter(section => section.section_type !== "acceptance_criteria");
    expect(readDefineHandoff(broken, pending)).toMatchObject({ error: { code: "define_document_invalid" } });
  });

  it("refuses tickets whose criterion left the document after generation", () => {
    const state = ready(passed());
    state.sections[1]!.content = "- AC-001: Verify the saved commit (FR-001).";
    expect(readDefineHandoff(state, pending)).toMatchObject({ error: {
      code: "define_document_invalid", message: expect.stringContaining("TICKET_ACCEPTANCE_UNKNOWN: TICKET-002 → AC-002"),
    } });
  });

  it("binds the estimates into the Define digest of the verified plan", () => {
    const plan = (tickets: typeof first[]) => {
      const read = readDefineHandoff(ready(passed(tickets)), pending);
      if ("error" in read) throw new Error(read.error.message);
      const built = buildVerifiedPlan(read.handoff, read.intent, "delivery");
      if ("error" in built) throw new Error(built.error.message);
      expect(built.verified_plan.define_sha256).toBe(sha(defineEnvelopeText(read.handoff)));
      return built.verified_plan;
    };
    const original = plan([first, second]);
    const changed = plan([first, { ...second, story_points: 13 }]);
    expect(changed.define_sha256).not.toBe(original.define_sha256);
    expect(changed.proposal).toEqual(original.proposal);
    expect(changed.plan_sha256).not.toBe(original.plan_sha256);
  });
});

describe("the passed Define snapshot", () => {
  it("serves the same bytes at the pending gate and after PRD only", () => {
    const { asked, answered, done } = finishPrdOnly(ready(passed()));
    const atGate = envelope(asked.state, asked.action);
    expect(done.state.current_step).toBe("complete");
    expect(done.state.passed_define).toEqual({ handoff: JSON.parse(atGate).handoff, intent: "Verify the delivery" });
    expect(envelope(answered.state, answered.action)).toBe(atGate);
    expect(envelope(done.state, done.action)).toBe(atGate);
    expect(envelope(done.state, null)).toBe(atGate);
  });

  it("does not serve a finished checkpoint that kept no snapshot", () => {
    const { done } = finishPrdOnly(ready(passed()));
    expect(readDefineHandoff({ ...done.state, passed_define: undefined }, done.action)).toEqual({
      error: { code: "define_not_pending", message: "Define requires a pending implementation decision." },
    });
  });

  it("keeps no snapshot of a refused specification", () => {
    const failed = finishPrdOnly(ready({ status: "failed", reason: "no response" }));
    expect(failed.done.state.passed_define).toBeUndefined();
    expect(readDefineHandoff(failed.done.state, failed.done.action)).toMatchObject({ error: { code: "define_not_pending" } });
  });

  it("refuses a snapshot the finished checkpoint no longer projects", () => {
    const { done } = finishPrdOnly(ready(passed()));
    const estimate = { ...done.state, jira_result: passed([first, { ...second, story_points: 5 }]) };
    const intent = { ...done.state, feature_description: "Another delivery" };
    for (const changed of [estimate, intent]) {
      expect(readDefineHandoff(changed, done.action)).toEqual({ error: {
        code: "define_not_ready", message: "The checkpoint no longer projects the Define kept when the run finished.",
      } });
    }
    const withoutCriteria = {
      ...done.state, sections: done.state.sections.filter(section => section.section_type !== "acceptance_criteria"),
    };
    expect(readDefineHandoff(withoutCriteria, done.action)).toMatchObject({ error: { code: "define_document_invalid" } });
    if (done.action.kind !== "done") throw new Error("Expected terminal action");
    expect(readDefineHandoff(done.state, { ...done.action, outcome: { status: "needs_attention", reasons: ["Blocked"] } }))
      .toMatchObject({ error: { code: "define_not_ready", message: expect.stringContaining("disagree") } });
  });

  it("refuses to load a snapshot of another run", () => {
    const { done } = finishPrdOnly(ready(passed()));
    const foreign = { ...done.state.passed_define!, handoff: { ...done.state.passed_define!.handoff, run_id: "run_other" } };
    expect(PipelineStateSchema.safeParse(done.state).success).toBe(true);
    expect(PipelineStateSchema.safeParse({ ...done.state, passed_define: foreign }).error?.issues).toMatchObject([
      { path: ["passed_define"], message: "PipelineState: passed_define belongs to another run." },
    ]);
  });
});

describe("the 07 deliverable of a refused ticket result", () => {
  const atJira = (): PipelineState => ({ ...ready(), current_step: "jira_generation", written_files: [] });
  const submit = (raw_text: string) => handleJiraGeneration({ state: atJira(), result: {
    kind: "subagent_batch_result", batch_id: "jira_generation",
    responses: [{ invocation_id: "jira_generation_engineer", raw_text }],
  } }).state;
  /** Drive file_export as a host would and return its run notes. */
  const runNotes = (start: PipelineState) => {
    let out = handleFileExport({ state: start });
    for (let writes = 0; writes < 20; writes++) {
      if (out.action.kind !== "write_file") break;
      if (out.action.path.endsWith("00-run-notes.md")) return out.action.content;
      out = handleFileExport({ state: out.state, result: {
        kind: "file_written", path: out.action.path, bytes: Buffer.byteLength(out.action.content),
      } });
    }
    throw new Error("file_export wrote no run notes");
  };
  const jiraNote = (state: PipelineState) =>
    runNotes(state).split("\n").find(line => line.includes("07-jira-tickets.md"));

  it("reads a fenced or prefaced ticket object", () => {
    const fenced = submit(`Here are the tickets:\n\`\`\`json\n${JSON.stringify({ tickets: [first] })}\n\`\`\``);
    expect(fenced.jira_result).toEqual(passed([first]));
    expect(jiraNote(fenced)).toBeUndefined();
  });

  it("reports 07 as failed validation, not as nothing to build from", () => {
    const refused = submit(JSON.stringify({ tickets: [{ ...first, story_points: 4 }] }));
    expect(refused.jira_result).toMatchObject({ status: "failed", reason: expect.stringContaining("TICKET_POINTS_INVALID") });
    expect(refused.errors.at(-1)).toMatch(/^\[jira_generation\] failed: jira_tickets_invalid: /);
    expect(jiraNote(refused)).toContain("failed validation");
    // The reason is read from jira_result, not from an error the FIFO cap may evict.
    expect(jiraNote({ ...refused, errors: [], error_kinds: [] })).toContain("failed validation");
  });

  it("records a skipped generation as such", () => {
    const none = handleJiraGeneration({ state: { ...atJira(), sections: [] } }).state;
    expect(none.jira_result).toEqual({ status: "failed", reason: "no source sections" });
    expect(jiraNote(none)).toContain("not generated in this run");
  });
});
