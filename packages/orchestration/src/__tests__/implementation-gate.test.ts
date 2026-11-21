/** The legacy-named gate ends specification generation and preserves its verification evidence. */

import { expectOptionRetry } from "./expect-option-retry.js";
import { describe, expect, it } from "vitest";
import { newPipelineState, refreshImplementationGateQuestion, step, type NextAction, type PipelineState } from "../index.js";

/** Must match handlers/protocol-ids.ts:IMPLEMENTATION_GATE_QUESTION_ID. */
const IMPLEMENTATION_GATE_QUESTION_ID = "implementation_gate";

function stateAtGate(): PipelineState {
  const s = newPipelineState({
    run_id: "impl_gate_001",
    feature_description: "OAuth login for the mobile app",
  });
  return {
    ...s,
    current_step: "implementation_gate",
    pending_completion: {
      summary: "Self-check complete. 3/3 sections passed.",
      artifacts: ["overview: passed"],
    },
  };
}

describe("implementation_gate — ask_user", () => {
  it("emits ask_user with exactly the safe specification options on entry", () => {
    const out = step({ state: stateAtGate() });

    expect(out.action.kind).toBe("ask_user");
    if (out.action.kind !== "ask_user") return;
    expect(out.action.question_id).toBe(IMPLEMENTATION_GATE_QUESTION_ID);
    expect(out.action.options).not.toBeNull();
    const labels = out.action.options?.map((o) => o.label) ?? [];
    expect(labels).toContain("PRD only");
    expect(labels).toContain("Review verification findings");
    expect(labels.length).toBe(2);

    // pending_completion carried forward untouched.
    expect(out.state.pending_completion).not.toBeNull();
    expect(out.state.current_step).toBe("implementation_gate");
  });
});

describe("implementation_gate — PRD only branch (zero regression)", () => {
  it('advances straight to finalize, decision="prd_only", pending_completion untouched', () => {
    const seed = stateAtGate();
    const out = step({
      state: seed,
      result: {
        kind: "user_answer",
        question_id: IMPLEMENTATION_GATE_QUESTION_ID,
        selected: ["PRD only"],
      },
    });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.decision).toBe("prd_only");
    expect(out.messages).toContainEqual({ level: "info", text: "Specification finalized." });
    // The exact payload finalize() computed is unmodified.
    expect(out.state.pending_completion).toEqual(seed.pending_completion);
    // pre_impl_grounding never runs on this branch.
    expect(out.action.kind).not.toBe("call_pipeline_tool");
  });
});

describe.each([
  { verdict: "pass", seed: stateAtGate },
  { verdict: "blocked", seed: stateAtGateWithJudgeVerdicts },
  { verdict: "needs_attention", seed: stateAtGateWithUnsampledRatio },
])(
  "implementation answer at $verdict", ({ seed }) => {
    it.each(["do not implement", "don't override", "don't override the policy", "", undefined, "unknown"])(
      "re-asks for %s and records no decision or derogation", (freeform) => {
        const issued = step({ state: seed() });
        const out = step({ state: issued.state, result: { kind: "user_answer", question_id: IMPLEMENTATION_GATE_QUESTION_ID, selected: [], freeform } });
        expectOptionRetry(out.action, issued.action);
        expect(out.state.post_specs?.decision).toBe("pending");
        expect(out.state.post_specs?.policy_derogation).toBeNull();
      },
    );
    it("accepts the typed decline label", () => {
      const issued = step({ state: seed() });
      const out = step({ state: issued.state, result: { kind: "user_answer", question_id: IMPLEMENTATION_GATE_QUESTION_ID, selected: [], freeform: " PRD   ONLY " } });
      expect(out.state.post_specs?.decision).toBe("prd_only");
    });
  },
);

function stateAtGateWithExportedPrd(): PipelineState {
  const base = stateAtGate();
  return {
    ...base,
    written_files: ["prd-output/impl_gate_001/01-prd.md"],
    sections: [
      {
        section_type: "overview",
        status: "passed",
        attempt: 1,
        violation_count: 2,
        last_violations: ["missing acceptance criteria"],
        content: "Overview content",
      },
    ],
    pending_completion: {
      summary: "Self-check complete.",
      artifacts: ["overview: passed"],
      verification: {
        claims_evaluated: 2,
        distribution: { PASS: 1, FAIL: 1 },
        distribution_suspicious: false,
        prd_graph_validation: { hallucinated_symbols: [] },
      },
    },
  };
}

it("revalidates an old pending checkpoint and replaces its optimistic report", () => {
  const before = stateAtGateWithExportedPrd();
  const path = "prd-output/impl_gate_001/10-verification-report.md";
  const state: PipelineState = {
    ...before,
    written_files: [...before.written_files, path],
    sections: [{ ...before.sections[0]!, section_type: "requirements", status: "failed", content: "- FR-001: Encrypt exported files." }],
    pending_completion: {
      ...before.pending_completion!,
      summary: "Self-check complete.\nDeterministic violations: 0 (0 critical, 0 advisory)\nHard-output score: 1.00 / 1.00\nMulti-judge claims: 2",
      outcome: { status: "passed", reasons: [] },
    },
  };
  const answer = (state: PipelineState, option: string) => step({
    state,
    result: { kind: "user_answer", question_id: IMPLEMENTATION_GATE_QUESTION_ID, selected: [option] },
  });
  const rejected = step({ state });
  expect(rejected.action).toMatchObject({
    kind: "ask_user",
    description: expect.stringContaining("The requirements section must define"),
  });
  expect(rejected.state.post_specs?.decision).toBe("pending");
  expect(rejected.state.pending_completion?.summary).toBe([
    "Self-check complete: NEEDS ATTENTION (The requirements section must define at least one FR or NFR statement.).",
    "Hard-output score: 0.85 / 1.00",
    "Deterministic violations: 1",
    "Multi-judge claims: 2",
  ].join("\n"));
  const approved = answer(rejected.state, "PRD only");
  expect(approved.action).toMatchObject({
    kind: "write_file",
    path,
    content: expect.stringContaining("Computed status: blocked"),
  });
  expect(approved.state.pending_completion).toBe(rejected.state.pending_completion);
  const acknowledged = step({ state: approved.state, result: { kind: "file_written", path } });
  expect(acknowledged.state.written_files.filter(file => file === path)).toHaveLength(1);
  expect(acknowledged.state.current_step).toBe("finalize");
});

it("refreshes only a stale implementation question with a current Define blocker", () => {
  const seed = stateAtGate();
  const stale: NextAction = {
    kind: "ask_user", question_id: IMPLEMENTATION_GATE_QUESTION_ID, header: "Prior question",
    description: "Prior policy", multi_select: false,
    options: [{ label: "Implement anyway (dérogation explicite)" }, { label: "PRD only" }],
  };
  const provided: PipelineState["sections"][number] = { section_type: "requirements", status: "passed", content: "ok",
    attempt: 1, violation_count: 0, last_violations: [], attempt_log: [] };
  const blocked = { ...seed, sections: [provided] };
  expect(refreshImplementationGateQuestion(seed, stale)).toMatchObject({ header: "Specification verification" });
  expect(refreshImplementationGateQuestion(blocked, null)).toBeNull();
  expect(refreshImplementationGateQuestion(blocked, { ...stale, options: null })).toMatchObject({
    options: [expect.objectContaining({ label: "PRD only" }), expect.objectContaining({ label: "Review verification findings" })],
  });
  const other: NextAction = { ...stale, question_id: "other" };
  expect(refreshImplementationGateQuestion(blocked, other)).toBe(other);
  expect(refreshImplementationGateQuestion({ ...blocked, current_step: "self_check" }, stale)).toBe(stale);
  const current = refreshImplementationGateQuestion(blocked, stale);
  expect(current).toMatchObject({
    description: expect.stringContaining("The requirements section must define"),
    options: [expect.objectContaining({ label: "PRD only" }), expect.objectContaining({ label: "Review verification findings" })],
  });
  expect(refreshImplementationGateQuestion(blocked, current)).toEqual(current);
});

describe("implementation_gate — verification-report export (root-cause fix)", () => {
  it("writes 10-verification-report.md BEFORE asking the implementation decision", () => {
    const out = step({ state: stateAtGateWithExportedPrd() });
    expect(out.action.kind).toBe("write_file");
    if (out.action.kind !== "write_file") return;
    expect(out.action.path).toBe(
      "prd-output/impl_gate_001/10-verification-report.md",
    );
    expect(out.action.content).toContain("# Verification Report");
    expect(out.action.content).toContain("Overview");
    expect(out.action.content).toContain("missing acceptance criteria");
    expect(out.action.content).toContain("Claims evaluated: 2");
    expect(out.action.content).toContain("PASS: 1");
    expect(out.action.content).toContain("hallucinated_symbols");
    // No fabricated per-claim verdicts — the honest gap notice, since
    // pending_completion.verification.judge_verdicts is not populated.
    expect(out.action.content).toContain(
      "Per-claim judge verdicts are not present",
    );
  });
});

/**
 * stateAtGateWithExportedPrd() with 2 populated judge_verdicts — module scope
 * so the describe block below stays under the §4.2 50-line function cap.
 */
function stateAtGateWithJudgeVerdicts(): PipelineState {
  return {
    ...stateAtGateWithExportedPrd(),
    pending_completion: {
      summary: "Self-check complete.",
      artifacts: ["overview: passed"],
      verification: {
        claims_evaluated: 2,
        distribution: { PASS: 1, FAIL: 1 },
        distribution_suspicious: false,
        judge_verdicts: [
          {
            judge: { kind: "genius", name: "dijkstra" },
            claim_id: "FR-001",
            verdict: "PASS",
            rationale: "Requirement is fully specified and testable.",
            caveats: [],
            confidence: 0.9,
          },
          {
            judge: { kind: "genius", name: "popper" },
            claim_id: "FR-002",
            verdict: "FAIL",
            rationale: "No falsifiable acceptance criterion given.",
            caveats: ["ambiguous_scope"],
            confidence: 0.6,
          },
        ],
      },
    },
  };
}

describe("implementation_gate — verification-report per-claim judge verdicts (follow-up, e2e run_mrlqa0aj_u2rh15)", () => {
  it("blocks on entry (a FAIL verdict is present — default policy block_on), then renders real per-claim verdict rows before finishing", () => {
    const seed = stateAtGateWithJudgeVerdicts();

    // Entry: a FAIL verdict is present -> default policy (block_on:["FAIL"])
    // blocks. The report is NOT written yet (see implementation-gate.ts
    // module doc "WRITE TIMING") — the question itself already names the
    // blocking claim.
    const asked = step({ state: seed });
    expect(asked.action.kind).toBe("ask_user");
    if (asked.action.kind !== "ask_user") return;
    expect(asked.action.description).toContain("FR-002");
    const labels = asked.action.options?.map((o) => o.label) ?? [];
    expect(labels).toEqual(["PRD only", "Review verification findings"]);

    const answered = step({
      state: asked.state,
      result: {
        kind: "user_answer",
        question_id: IMPLEMENTATION_GATE_QUESTION_ID,
        selected: ["PRD only"],
      },
    });
    expect(answered.action.kind).toBe("write_file");
    if (answered.action.kind !== "write_file") return;

    // Real verdict rows replace the honest gap notice.
    expect(answered.action.content).not.toContain(
      "Per-claim judge verdicts are not present",
    );
    expect(answered.action.content).toContain("| Claim ID | Judge | Model | Verdict |");
    expect(answered.action.content).toContain("FR-001");
    expect(answered.action.content).toContain("PASS");
    expect(answered.action.content).toContain("dijkstra");
    expect(answered.action.content).toContain("FR-002");
    expect(answered.action.content).toContain("FAIL");
    expect(answered.action.content).toContain("popper");
    expect(answered.action.content).toContain(
      "No falsifiable acceptance criterion given.",
    );
    expect(answered.state.post_specs?.policy_derogation).toBeNull();

    const advanced = step({
      state: answered.state,
      result: {
        kind: "file_written",
        path: answered.action.path,
        bytes: answered.action.content.length,
      },
    });
    expect(advanced.state.current_step).toBe("finalize");
  });
});

describe("implementation_gate — verification-report write protocol", () => {
  it("records the report path and proceeds to ask_user once file_written arrives", () => {
    const seed = stateAtGateWithExportedPrd();
    const written = step({ state: seed });
    expect(written.action.kind).toBe("write_file");
    if (written.action.kind !== "write_file") return;

    const next = step({
      state: written.state,
      result: {
        kind: "file_written",
        path: written.action.path,
        bytes: written.action.content.length,
      },
    });
    expect(next.state.written_files).toContain(
      "prd-output/impl_gate_001/10-verification-report.md",
    );
    expect(next.action.kind).toBe("ask_user");
    if (next.action.kind === "ask_user") {
      expect(next.action.question_id).toBe(IMPLEMENTATION_GATE_QUESTION_ID);
    }
  });

  it("never re-writes the report once written_files already carries it", () => {
    const seed: PipelineState = {
      ...stateAtGateWithExportedPrd(),
      written_files: [
        "prd-output/impl_gate_001/01-prd.md",
        "prd-output/impl_gate_001/10-verification-report.md",
      ],
    };
    const out = step({ state: seed });
    expect(out.action.kind).toBe("ask_user");
  });
});

/**
 * stateAtGateWithExportedPrd() with an unsampled subjective claim (0 of 4
 * subjective claims received a verdict) — triggers `needs_attention` under
 * `DEFAULT_VERIFICATION_POLICY.on_unsampled_below_ratio === "ask"`, distinct
 * from the `blocked` (FAIL) case exercised above.
 */
function stateAtGateWithUnsampledRatio(): PipelineState {
  return {
    ...stateAtGateWithExportedPrd(),
    pending_completion: {
      summary: "Self-check complete.",
      artifacts: ["overview: passed"],
      verification: {
        claims_evaluated: 0,
        distribution: {},
        distribution_suspicious: false,
        total_subjective_claims: 4,
      },
    },
  };
}

describe("implementation_gate — policy-shaped gate (needs_attention)", () => {
  it("choosing 'PRD only' under needs_attention records NO derogation, but the (still non-'pass') decision is written to the report before advancing", () => {
    const asked = step({ state: stateAtGateWithUnsampledRatio() });
    const answered = step({
      state: asked.state,
      result: {
        kind: "user_answer",
        question_id: IMPLEMENTATION_GATE_QUESTION_ID,
        selected: ["PRD only"],
      },
    });
    // The report was never written pre-decision (status was not "pass") —
    // it is written now, once, carrying the recorded "prd_only" decision.
    expect(answered.action.kind).toBe("write_file");
    if (answered.action.kind !== "write_file") return;
    expect(answered.action.content).toContain(
      'Human decision: prd_only (no derogation — implementation not selected).',
    );
    expect(answered.state.post_specs?.decision).toBe("prd_only");
    expect(answered.state.post_specs?.policy_derogation).toBeNull();
    expect(answered.state.current_step).toBe("implementation_gate");

    const advanced = step({
      state: answered.state,
      result: {
        kind: "file_written",
        path: answered.action.path,
        bytes: answered.action.content.length,
      },
    });
    expect(advanced.state.current_step).toBe("finalize");
  });
});

/**
 * stateAtGateWithExportedPrd() carrying ONE verdict whose free-text fields
 * are hostile to a GFM table. Judge rationales are LLM-generated, so they are
 * untrusted input to the renderer (§13.1 D2). Module scope keeps the describe
 * below under the §4.2 50-line function cap.
 */
function stateAtGateWithHostileRationale(): PipelineState {
  return {
    ...stateAtGateWithExportedPrd(),
    pending_completion: {
      summary: "Self-check complete.",
      artifacts: ["overview: passed"],
      verification: {
        claims_evaluated: 1,
        distribution: { PASS: 1 },
        distribution_suspicious: false,
        judge_verdicts: [
          {
            judge: { kind: "genius", name: "dijkstra" },
            claim_id: "FR-001",
            verdict: "PASS",
            // A trailing backslash before a pipe, plus a newline: the two
            // shapes that escape a naive `.replace(/\|/g, "\\|")`.
            rationale: "escaped\\|pipe then\nnewline and a raw | pipe",
            caveats: [],
            confidence: 0.9,
          },
        ],
      },
    },
  };
}

describe("implementation_gate — judge rationale cannot break out of its table cell", () => {
  it("escapes backslash before pipe and neutralizes newlines (js/incomplete-sanitization)", () => {
    // Precondition: a rationale containing `\|`, a newline, and a bare `|`.
    // Postcondition: the verdict row is exactly ONE line whose cell count is
    //   the header's (6 columns => 7 pipe-delimited fields), i.e. no column
    //   or row injection. Regression: pre-fix, `escaped\|pipe` rendered as
    //   `escaped\\|pipe` (literal backslash + UNESCAPED delimiter) and the
    //   newline split the row in two.
    const seed = stateAtGateWithHostileRationale();
    const written = step({ state: seed });
    expect(written.action.kind).toBe("write_file");
    if (written.action.kind !== "write_file") return;

    const rows = written.action.content
      .split("\n")
      .filter((l) => l.startsWith("| FR-001 "));
    expect(rows).toHaveLength(1);

    // Count only UNESCAPED pipes — the ones GFM treats as cell delimiters.
    const delimiters = (rows[0].match(/(?<!\\)\|/g) ?? []).length;
    const headerLine = written.action.content
      .split("\n")
      .find((l) => l.startsWith("| Claim ID |"));
    expect(headerLine).toBeDefined();
    const headerDelimiters = (headerLine!.match(/(?<!\\)\|/g) ?? []).length;
    expect(delimiters).toBe(headerDelimiters);

    // The newline became a GFM in-cell break, not a row terminator.
    expect(rows[0]).toContain("<br>");
    expect(rows[0]).not.toContain("\n");
  });
});
