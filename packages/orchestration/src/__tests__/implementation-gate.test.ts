/**
 * `implementation_gate` — the human gate between self_check's PRD
 * deliverables and the post-specs implementation loop.
 *
 * Proves:
 *   1. On entry (no result), emits ask_user(question_id="implementation_gate")
 *      with exactly the "PRD only" / "Implement" options.
 *   2. Answering "PRD only" advances straight to `finalize`, preserving
 *      `state.pending_completion` untouched — today's exact behavior (zero
 *      regression is the acceptance criterion for this branch,
 *      design-phases-3-5.md §5, PR 3b).
 *   3. Answering "Implement" advances to `pre_impl_grounding`, then coalesces
 *      through to `implementation` (PR 4a wiring).
 *   4. An unrecognized or empty answer repeats the policy-shaped question.
 *
 * source: design-phases-3-5.md §2.2, §3 "implementation_gate".
 */

import { expectOptionRetry } from "./expect-option-retry.js";
import { describe, expect, it } from "vitest";
import { newPipelineState, step, type PipelineState } from "../index.js";

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
  it("emits ask_user with exactly PRD-only/Implement options on entry", () => {
    const out = step({ state: stateAtGate() });

    expect(out.action.kind).toBe("ask_user");
    if (out.action.kind !== "ask_user") return;
    expect(out.action.question_id).toBe(IMPLEMENTATION_GATE_QUESTION_ID);
    expect(out.action.options).not.toBeNull();
    const labels = out.action.options?.map((o) => o.label) ?? [];
    expect(labels).toContain("PRD only");
    expect(labels).toContain("Implement");
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
    // The exact payload finalize() computed is unmodified.
    expect(out.state.pending_completion).toEqual(seed.pending_completion);
    // pre_impl_grounding never runs on this branch.
    expect(out.action.kind).not.toBe("call_pipeline_tool");
  });
});

describe("implementation_gate — Implement branch", () => {
  it('routes through pre_impl_grounding into implementation, decision="implement"', () => {
    const out = step({
      state: stateAtGate(),
      result: {
        kind: "user_answer",
        question_id: IMPLEMENTATION_GATE_QUESTION_ID,
        selected: ["Implement"],
      },
    });

    expect(out.state.post_specs?.decision).toBe("implement");
    // Coalesces into pre_impl_grounding, which (no graph/no affected-symbols
    // sidecar in this fixture) immediately advances to implementation (see
    // pre-impl-grounding.test.ts for the grounding loop itself when a graph
    // and claims ARE present); implementation then emits a SUBSTANTIVE
    // spawn_subagents action, which stops the coalescing chain.
    expect(out.state.current_step).toBe("implementation");
    expect(out.state.post_specs?.impact_queries.done).toBe(true);
    expect(out.action.kind).toBe("spawn_subagents");
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

describe("multiple selections at the blocked implementation gate", () => {
  const override = "Override policy (explicit)";
  it.each(["PRD only", override, "not an option"])("counts an override plus %s without recording a derogation", (extra) => {
    const issued = step({ state: stateAtGateWithJudgeVerdicts() });
    const answer = { kind: "user_answer" as const, question_id: IMPLEMENTATION_GATE_QUESTION_ID, selected: [override, extra] };
    let saved = issued.state;
    for (const count of [1, 2]) {
      const out = step({ state: saved, result: answer });
      expectOptionRetry(out.action, issued.action);
      expect(out.state.unmatched_answers).toEqual({ implementation_gate: count });
      expect(out.state.post_specs).toMatchObject({ decision: "pending", policy_derogation: null });
      saved = out.state;
    }
    const third = step({ state: saved, result: answer });
    expect(third.state.post_specs).toMatchObject({ decision: "prd_only", policy_derogation: null });
    expect(third.messages).toContainEqual({ level: "warn", text: 'implementation_gate: 3 unmatched answers. Using "PRD only".' });
  });

  it.each(["", " \t "])("records an explicit override accompanied by %j", (blank) => {
    const out = step({ state: stateAtGateWithJudgeVerdicts(), result: {
      kind: "user_answer", question_id: IMPLEMENTATION_GATE_QUESTION_ID, selected: [override, blank],
    } });
    expect(out.action.kind).toBe("write_file");
    expect(out.state.post_specs).toMatchObject({ decision: "implement", policy_derogation: { policy_status: "blocked" } });
  });
});

it("re-asks for a bare Implement when the policy is blocked", () => {
  const issued = step({ state: stateAtGateWithJudgeVerdicts() });
  const out = step({ state: issued.state, result: { kind: "user_answer", question_id: IMPLEMENTATION_GATE_QUESTION_ID, selected: ["Implement"] } });
  expectOptionRetry(out.action, issued.action);
  expect(out.state.post_specs?.policy_derogation).toBeNull();
});

/**
 * A run directory is derivable (state.written_files carries 01-prd.md) —
 * this is the case buildVerificationReportFile actually produces a file for.
 * stateAtGate() alone (no written_files) exercises the graceful degrade
 * already proven by the "ask_user on entry" test above.
 *
 * Module-scope (not nested inside a describe): shared by both the
 * report-content describe block and the write-protocol describe block below
 * (split to keep each describe under coding-standards.md §4.2's 50-line
 * function cap — craftsmanship-checker.sh FUNCTION_TOO_LONG).
 */
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
  it("blocks on entry (a FAIL verdict is present — default policy block_on), then renders real per-claim verdict rows after the override", () => {
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
    expect(labels).toEqual(["PRD only", "Override policy (explicit)"]);

    const answered = step({
      state: asked.state,
      result: {
        kind: "user_answer",
        question_id: IMPLEMENTATION_GATE_QUESTION_ID,
        selected: ["Override policy (explicit)"],
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
    // The recorded derogation is rendered in the same report.
    expect(answered.action.content).toContain("derogation granted by user at gate");
    expect(answered.state.post_specs?.policy_derogation?.policy_status).toBe("blocked");

    const advanced = step({
      state: answered.state,
      result: {
        kind: "file_written",
        path: answered.action.path,
        bytes: answered.action.content.length,
      },
    });
    expect(advanced.state.post_specs?.decision).toBe("implement");
    // Coalesces through pre_impl_grounding (no graph/sidecar in this
    // fixture) into implementation — mirrors the "Implement branch" test.
    expect(advanced.state.current_step).toBe("implementation");
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
  it("offers the derogation-framed options and records the derogation on 'Implement anyway'", () => {
    const asked = step({ state: stateAtGateWithUnsampledRatio() });
    expect(asked.action.kind).toBe("ask_user");
    if (asked.action.kind !== "ask_user") return;
    const labels = asked.action.options?.map((o) => o.label) ?? [];
    expect(labels).toEqual(["Implement anyway (dérogation explicite)", "PRD only"]);
    expect(asked.action.description).toContain("0%");

    const answered = step({
      state: asked.state,
      result: {
        kind: "user_answer",
        question_id: IMPLEMENTATION_GATE_QUESTION_ID,
        selected: ["Implement anyway (de\u0301rogation explicite)"],
      },
    });
    expect(answered.action.kind).toBe("write_file");
    if (answered.action.kind !== "write_file") return;
    expect(answered.action.content).toContain("derogation granted by user at gate");
    expect(answered.state.post_specs?.policy_derogation?.policy_status).toBe(
      "needs_attention",
    );
    expect(answered.state.post_specs?.decision).toBe("implement");
  });

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
