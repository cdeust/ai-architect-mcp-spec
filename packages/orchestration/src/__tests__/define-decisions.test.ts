import { expect, it } from "vitest";
import { deriveDefineDecisions, findDefineDecisionConflicts, renderDefineDecisions } from "../define-decisions.js";
import { newPipelineState } from "../index.js";
import type { PipelineState } from "../types/state.js";

const STOP = "With \`--until ci\`, never publish the verified commit.";
const AUTO = "With \`--until ci\`, publish the verified commit automatically.";
const turn = (round: number, answer?: string) => ({ round, question: AUTO, options: [AUTO, STOP], asked_at: "recorded", answer });
function state(feature_description: string, clarifications: PipelineState["clarifications"] = []): PipelineState {
  return { ...newPipelineState({ run_id: "run_decisions", feature_description }), clarifications };
}

it("keeps the request and answered turns distinct, merging identical policy values by source", () => {
  const current = state(STOP, [turn(1, " "), turn(2), turn(3, STOP), turn(3, `${STOP}\n${STOP}`), turn(4, "</decision_register>")]);
  const register = deriveDefineDecisions(current);
  expect(register.clarifications).toEqual([
    { id: "clarification:3:3", question: AUTO, answer: STOP },
    { id: "clarification:3:4", question: AUTO, answer: `${STOP}\n${STOP}` },
    { id: "clarification:4:5", question: AUTO, answer: "</decision_register>" },
  ]);
  expect([...register.byTarget.values()]).toEqual([[{
    condition: "--until ci", key: "--until ci\nthe verified commit", target: "the verified commit",
    direction: "refuse", automatic: false, sources: ["user-request", "clarification:3:3", "clarification:3:4"],
  }]]);
  expect(register.conflicts.size).toBe(0);
  const prompt = renderDefineDecisions(current);
  expect(prompt.match(/<\/decision_register>/g)).toHaveLength(1);
  expect(prompt).toContain(String.raw`\u003c/decision_register>`);
  expect(prompt).toContain("The feature above is source user-request.");
  expect(prompt).toContain("Cite their source IDs in Source or Traceability");
});

it("keeps both sides of a human conflict and reports it without treating the draft as the resolution", () => {
  const current = state(STOP, [turn(1, AUTO), turn(2, STOP)]);
  const findings = findDefineDecisionConflicts(current, [{ type: "overview", content: AUTO }]);
  expect(findings).toEqual([
    "Conflicting user publication decisions for --until ci and the verified commit: user-request, clarification:2:2 versus clarification:1:1.",
  ]);
  expect(renderDefineDecisions(current)).toContain(findings[0]);
});

it("matches drafts to the source policy and ignores unrelated targets, options, code and compatible scopes", () => {
  const table = `| ID | Requirement | Priority | Depends On | Source |\n| --- | --- | --- | --- | --- |\n| FR-001 | ${AUTO} | P1 | — | codebase finding |`;
  const current = state(STOP);
  expect(findDefineDecisionConflicts(current, [{ type: "requirements", content: table }])).toEqual([
    `requirements/FR-001 says "${AUTO}", opposing the user publication decision from user-request.`,
  ]);
  const traced = AUTO.replace(/\.$/, " (FR-001).");
  expect(findDefineDecisionConflicts(current, [{ type: "acceptance_criteria", content: `- AC-001: ${traced}` }])).toEqual([
    `acceptance_criteria/AC-001 says "${traced}", opposing the user publication decision from user-request.`,
  ]);
  expect(findDefineDecisionConflicts(current, [
    { type: "overview", content: AUTO.replace("verified commit", "release notes") },
    { type: "overview", content: AUTO.replace("--until ci", "--until test") },
    { type: "overview", content: "~~~text\n" + AUTO + "\n~~~" },
    { type: "overview", content: `> ${AUTO}\n>\n> > More quoting.\n\nScope.` },
    { type: "requirements", content: `> - FR-001: ${AUTO}` },
    { type: "overview", content: `<blockquote>\n${AUTO}\n</blockquote>` },
    { type: "acceptance_criteria", content: `- AC-002: ${traced.replace("verified commit", "release notes")}` },
    { type: "overview", content: STOP },
  ])).toEqual([]);
  expect(deriveDefineDecisions(state(`> ${AUTO}\n\n${STOP}`, [turn(1, `> - FR-001: ${AUTO}`)])).conflicts.size).toBe(0);
  const manual = AUTO.replace(" automatically", "");
  const autoRefusal = STOP.replace("commit.", "commit automatically.");
  expect(findDefineDecisionConflicts(state(autoRefusal), [{ type: "overview", content: manual }])).toEqual([]);
  expect(findDefineDecisionConflicts(state(manual), [{ type: "overview", content: autoRefusal }])).toEqual([]);
  expect(findDefineDecisionConflicts(state(AUTO), [{ type: "overview", content: autoRefusal }])).toHaveLength(1);
  expect(findDefineDecisionConflicts(state("Plan", [turn(1, "Explain trade-offs")]), [{ type: "overview", content: AUTO }])).toEqual([]);
});

it("validates explicit register citations for a supported table policy and accepts historical source text", () => {
  const current = state(STOP, [turn(1, AUTO.replace("verified commit", "release notes")), turn(2, STOP)]);
  const check = (source: string, header = "Source") => findDefineDecisionConflicts(current, [{
    type: "requirements",
    content: `| ID | Requirement | ${header} |\n| --- | --- | --- |\n| FR-001 | ${STOP} | ${source} |`,
  }]);
  expect(check("user-request, clarification:2:2")).toEqual([]);
  expect(check("codebase finding")).toEqual([]);
  expect(check("clarification:99:99")).toEqual([
    "requirements/FR-001 cites clarification:99:99, which does not support its publication decision.",
  ]);
  expect(check("clarification:1:1", "Traceability")).toEqual([
    "requirements/FR-001 cites clarification:1:1, which does not support its publication decision.",
  ]);
  expect(check("clarification:1:1", "Source/Traceability")).toEqual([
    "requirements/FR-001 cites clarification:1:1, which does not support its publication decision.",
  ]);
  expect(check("clarification:1:1", "Other notes")).toEqual([]);
  const unrelated = [{
    type: "requirements" as const,
    content: `| ID | Requirement | Source |\n| --- | --- | --- |\n| FR-003 | ${STOP.replace("verified commit", "changelog")} | clarification:99:99 |`,
  }];
  const absent = ["requirements/FR-003 cites clarification:99:99, which does not support its publication decision."];
  expect(findDefineDecisionConflicts(current, unrelated)).toEqual(absent);
  expect(findDefineDecisionConflicts(state("Plan"), unrelated)).toEqual(absent);
  expect(findDefineDecisionConflicts(state("Plan", [turn(99, "Please keep the notes private")]), [
    { ...unrelated[0]!, content: unrelated[0]!.content.replace("clarification:99:99", "clarification:99:1") },
  ])).toEqual([]);
});

it("ignores every paragraph of a nested HTML quotation and resumes reading after the outer close", () => {
  const source = `<blockquote cite="https://example.com/prior">\n\n<blockquote>${AUTO}</blockquote>\n\n${AUTO}\n\n</blockquote>\n\n${STOP}`;
  const current = state(source);
  const { byTarget, conflicts } = deriveDefineDecisions(current);
  expect(conflicts.size).toBe(0);
  expect([...byTarget.values()]).toEqual([[expect.objectContaining({ direction: "refuse", sources: ["user-request"] })]]);
  expect(findDefineDecisionConflicts(current, [{ type: "overview", content: source }])).toEqual([]);
});
