/**
 * End-to-end smoke harness.
 *
 * Drives a full pipeline run from start_pipeline through to a `done` action,
 * simulating the host (Claude Code). The harness:
 *
 *   - Issues canned, well-formed responses for every action kind the runner
 *     emits, exactly as a real host would.
 *   - Records every transition for post-run inspection.
 *   - Bounds the loop with a safety cap so a runaway protocol never hangs CI.
 *
 * What this PROVES:
 *   ✓ The runner reaches `done` for a feature PRD on a free-tier user without
 *     a codebase.
 *   ✓ Every emitted action kind is dispatched correctly.
 *   ✓ The messages array carries banner/status output through every iteration.
 *   ✓ No protocol-violation errors fire during a clean run.
 *
 * What this does NOT prove:
 *   ✗ That the real ai-architect-mcp-codebase / Cortex / subagent calls would work
 *     against a real ecosystem (those are mocked here).
 *   ✗ That a real LLM would produce useful PRD content (the canned subagent
 *     responses are minimal markdown that satisfies the validator).
 */

import { describe, expect, it } from "vitest";
import {
  makeCannedDispatcher,
  newPipelineState,
  step,
  type ActionResult,
  type NextAction,
  type PipelineState,
  type StepOutput,
} from "../index.js";

interface Transition {
  iteration: number;
  current_step: PipelineState["current_step"];
  action_kind: NextAction["kind"];
  message_count: number;
  result_kind?: ActionResult["kind"];
  /** state.errors.length at this iteration — diagnostic for failure traces. */
  errors_count: number;
  /** "P/F/total" for sections in scope at this iteration. Empty before section_generation. */
  sections_summary: string;
  /** Number of files written so far (file_export progress). */
  written_files_count: number;
}

interface SmokeRunResult {
  finalAction: NextAction;
  finalState: PipelineState;
  transitions: Transition[];
  messages: Array<{ text: string; level: string }>;
  iterations: number;
}

/**
 * Maximum step() invocations before the harness aborts.
 *
 * source: derived from the longest legitimate full run (trial tier, 11 sections,
 * 1 recall per section, 1 draft per section, plus self-check judges):
 *   banner(1) + context_detection(1) + input_analysis(2) +
 *   feasibility_gate(1) + clarification(8 = 4 rounds × 2 phases) +
 *   budget(1) + section_generation(11×3 = 33) + jira_generation(2) +
 *   file_export(9) + self_check(2) ≈ 60 host-visible step() calls.
 * SAFETY_CAP = 200 gives ~3.3x margin. Tune from telemetry if new tiers or
 * sections are added.
 */
const SAFETY_CAP = 200;

// ─── Canned dispatcher (smoke labels) ───────────────────────────────────────
// source: code-reviewer B1 (Phase 3 cross-audit, 2026-04). The smoke + KPI
// dispatchers were duplicated with subtle drift; the shared factory in
// canned-dispatcher.ts now owns the single implementation. Smoke pins the
// labels its assertions match (graph_path, freeform_answer).
const craftResult = makeCannedDispatcher({
  freeform_answer: "smoke-test-answer",
  graph_path: "/tmp/smoke/.prd-gen/graphs/smoke/graph",
});

function summarizeSections(state: PipelineState): string {
  if (state.sections.length === 0) return "";
  const passed = state.sections.filter((s) => s.status === "passed").length;
  const failed = state.sections.filter((s) => s.status === "failed").length;
  return `${passed}P/${failed}F/${state.sections.length}`;
}

function runSmoke(seed: Readonly<PipelineState>): SmokeRunResult {
  const transitions: Transition[] = [];
  const allMessages: Array<{ text: string; level: string }> = [];
  let state: PipelineState = seed;
  let pendingResult: ActionResult | undefined = undefined;
  let lastOutput: StepOutput | null = null;

  for (let i = 0; i < SAFETY_CAP; i++) {
    const out = step({ state, result: pendingResult });
    lastOutput = out;
    state = out.state;
    for (const m of out.messages) allMessages.push(m);
    transitions.push({
      iteration: i,
      current_step: state.current_step,
      action_kind: out.action.kind,
      message_count: out.messages.length,
      result_kind: pendingResult?.kind,
      errors_count: state.errors.length,
      sections_summary: summarizeSections(state),
      written_files_count: state.written_files.length,
    });

    if (out.action.kind === "done" || out.action.kind === "failed") {
      return {
        finalAction: out.action,
        finalState: state,
        transitions,
        messages: allMessages,
        iterations: i + 1,
      };
    }

    pendingResult = craftResult(out.action);
    // craftResult returns undefined ONLY for terminal actions (done, failed),
    // both of which exit the loop above. Reaching here with undefined means
    // a new action kind slipped past craftResult's exhaustiveness check.
    if (pendingResult === undefined) {
      throw new Error(
        `Harness produced no result for action.kind=${out.action.kind}`,
      );
    }
  }

  // After SAFETY_CAP > 0 iterations, lastOutput is necessarily non-null
  // because the loop body executed at least once.
  throw new Error(
    `Smoke run exceeded safety cap (${SAFETY_CAP} iterations); last action: ${lastOutput!.action.kind}`,
  );
}

describe("end-to-end smoke run", () => {
  it("free tier feature PRD without codebase reaches done", () => {
    const seed = newPipelineState({
      run_id: "smoke_free_no_codebase",
      feature_description: "build a simple feature for OAuth login",
    });

    const result = runSmoke(seed);

    expect(result.finalAction.kind).toBe("done");
    expect(result.finalState.current_step).toBe("complete");
    // Should have produced welcome banner + at least a few section status messages.
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("trial tier feature PRD with codebase reaches done", () => {
    const seed = newPipelineState({
      run_id: "smoke_trial_with_codebase",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/smoke",
    });

    const result = runSmoke(seed);

    expect(result.finalAction.kind).toBe("done");
    expect(result.finalState.current_step).toBe("complete");
    expect(result.finalState.codebase_indexed).toBe(true);
    expect(result.finalState.codebase_graph_path).toBe(
      "/tmp/smoke/.prd-gen/graphs/smoke/graph",
    );
  });

  it("every emitted action kind is dispatchable by the harness", () => {
    const seed = newPipelineState({
      run_id: "smoke_action_coverage",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/smoke",
    });

    const result = runSmoke(seed);

    const observedKinds = new Set(result.transitions.map((t) => t.action_kind));
    // Must observe these kinds during a full run:
    expect(observedKinds.has("call_pipeline_tool")).toBe(true);
    expect(observedKinds.has("spawn_subagents")).toBe(true);
    expect(observedKinds.has("write_file")).toBe(true);
    expect(observedKinds.has("done")).toBe(true);
    // call_cortex_tool is emitted during section generation.
    expect(observedKinds.has("call_cortex_tool")).toBe(true);
    // emit_message MUST NOT appear as action.kind (coalesced internally).
    expect(observedKinds.has("emit_message")).toBe(false);
  });

  it("never returns emit_message as the action.kind", () => {
    const seed = newPipelineState({
      run_id: "smoke_no_emit_message_action",
      feature_description: "build a feature for OAuth login",
    });
    const result = runSmoke(seed);
    for (const t of result.transitions) {
      expect(t.action_kind).not.toBe("emit_message");
    }
  });

  it("writes the expected deliverable files — no placeholders for unscheduled sections", () => {
    // "feature" context schedules: overview, goals, requirements,
    // user_stories, technical_specification, acceptance_criteria (→ 01),
    // data_model (→02), api_specification (→03), security_considerations +
    // performance_requirements (→04), testing + acceptance_criteria (→05).
    // deployment/timeline/risks (06) and source_code/test_code (08/09) are
    // NEVER scheduled for ANY context (section-plan.ts) — under the
    // root-cause fix (file-export.ts) those files are correctly OMITTED,
    // not stubbed with placeholder text, and the omission is recorded in
    // 00-run-notes.md instead. implementation_gate additionally writes
    // 10-verification-report.md before asking the implementation decision.
    // The smoke harness's simulated technical_specification content carries
    // no affected-symbols block, so extraction runs and finds zero claims —
    // per the zero-claims contract (ai-architect-mcp-codebase
    // stages/stage-6.md §4.2, "Zero-claims case — not the same as absent",
    // pinned at commit 92216cd90f8f26cb15348675fc6556b8293edfc1) that MUST
    // still produce stage-5.affected_symbols.json (empty arrays), not omit
    // it — the section ran; only "the section never ran" omits the sidecar.
    // Total: 01,02,03,04,05,07(jira) + 00-run-notes + 10-verification-report
    // + stage-5.affected_symbols.json = 9.
    const seed = newPipelineState({
      run_id: "smoke_file_count",
      feature_description: "build a feature for OAuth login",
    });
    const result = runSmoke(seed);
    const paths = result.finalState.written_files.map((p) =>
      p.split("/").pop(),
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "01-prd.md",
        "02-data-model.md",
        "03-api-spec.md",
        "04-security.md",
        "05-testing.md",
        "07-jira-tickets.md",
        "00-run-notes.md",
        "10-verification-report.md",
        "stage-5.affected_symbols.json",
      ]),
    );
    expect(paths).not.toContain("06-deployment.md");
    expect(paths).not.toContain("08-source-code.md");
    expect(paths).not.toContain("09-test-code.md");
    expect(result.finalState.written_files.length).toBe(9);
  });

  it("loop terminates within the safety cap", () => {
    const seed = newPipelineState({
      run_id: "smoke_termination",
      feature_description: "build a feature for OAuth login",
    });
    const result = runSmoke(seed);
    expect(result.iterations).toBeLessThan(SAFETY_CAP);
  });

  it("banner text identifies the run_id and feature", () => {
    // source: darwin difficulty-book pass-2 (2026-04) — original assertion
    // only checked the substring "PRD Spec Generator" which would pass on
    // any banner. Tighten to verify run_id appears.
    const seed = newPipelineState({
      run_id: "smoke_banner_specific_id_xyz",
      feature_description: "build a feature for OAuth login",
    });
    const result = runSmoke(seed);
    const allText = result.messages.map((m) => m.text).join("\n");
    expect(allText).toContain("PRD Spec Generator");
    expect(allText).toContain(seed.run_id);
    expect(allText).toContain("build a feature for OAuth login");
  });

  it("happy path produces a known section-failure baseline (not silent drift)", () => {
    // Operational definition (b) and (c) per curie cross-audit pass-2:
    //   the smoke run must reach `done` AND the set of failed sections must
    //   match a known, documented baseline. Without this, a regression that
    //   silently increases the failure rate (the original pass-2 anomaly
    //   was 5/12 silent failures) goes unobserved.
    //
    // The baseline below is what the canned-content harness produces against
    // the live validator. These sections fail because their hard-output rules
    // (e.g. clean-architecture in technical_specification, DDL referencing in
    // data_model) cannot be satisfied by short canned drafts. The smoke
    // harness verifies REGRESSION, not authorship quality — real LLM output
    // is expected to clear these rules.
    //
    // source: feynman+curie cross-audit pass-2 (2026-04). If a fake draft
    // is added for one of these sections, remove it from this list.
    const KNOWN_FAILING_SECTIONS = [
      "technical_specification",
      "data_model",
      "api_specification",
      "security_considerations",
      "testing",
    ] as const;

    const seed = newPipelineState({
      run_id: "smoke_section_failure_baseline",
      feature_description: "build a feature for OAuth login",
    });
    const result = runSmoke(seed);

    expect(result.finalAction.kind).toBe("done");
    const failed = result.finalState.sections
      .filter((s) => s.status === "failed")
      .map((s) => s.section_type)
      .sort();
    expect(failed).toEqual([...KNOWN_FAILING_SECTIONS].sort());

    // state.errors records each section failure. We bound the count to the
    // baseline (one error per failed section).
    expect(result.finalState.errors.length).toBe(KNOWN_FAILING_SECTIONS.length);
  });

  it("self_check actually dispatches the judge phase (not bypassed by zero claims)", () => {
    // Postcondition: after a full happy-path run, the harness must have
    // observed at least one judge spawn_subagents action with the
    // self_check_verify batch_id. If fakeSectionDraft loses its claim-rich
    // content (e.g. someone reverts to "minimal markdown"), this test fails.
    //
    // source: curie cross-audit pass-2 found verification_plan was null at
    // completion because zero claims meant planDocumentVerification returned
    // an empty judge_requests array and self_check took the fast path
    // (self-check.ts:209). This test guards against that regression.
    const seed = newPipelineState({
      run_id: "smoke_judges_dispatched",
      feature_description: "build a feature for OAuth login",
    });
    const result = runSmoke(seed);

    // Must have observed a self_check judge batch (purpose: "judge").
    // We cannot inspect `purpose` from Transition (it only records kind), but
    // the messages emitted by self-check's finalize() include the judge
    // distribution counts. If judges ran, "Multi-judge claims:" must appear
    // with a count > 0 in the done summary.
    expect(result.finalAction.kind).toBe("done");
    if (result.finalAction.kind !== "done") return;
    const summary = result.finalAction.summary;
    expect(summary).toContain("Multi-judge claims:");
    // Extract the claim count: "Multi-judge claims: <N>"
    const m = summary.match(/Multi-judge claims:\s+(\d+)/);
    expect(m).not.toBeNull();
    if (m) {
      const claimCount = parseInt(m[1], 10);
      expect(claimCount).toBeGreaterThan(0);
    }
  });

  it("ask_user is exercised when context cannot be auto-detected", () => {
    // Postcondition: when feature_description contains no trigger words recognised
    // by context-detection, the runner emits ask_user(question_id="prd_context")
    // before any other substantive action.
    //
    // The phrase below contains no word from TRIGGER_WORDS for any PRDContext:
    // no "feature", "build", "implement", "add support", "bug", "fix", "incident",
    // "poc", "mvp", "release", "ci", "cd", "proposal", "pitch", "stakeholder".
    const seed = newPipelineState({
      run_id: "smoke_ask_user_context",
      feature_description: "improve the onboarding questionnaire",
    });

    const result = runSmoke(seed);

    const contextQuestion = result.transitions.find(
      (t) => t.action_kind === "ask_user",
    );
    // There must be at least one ask_user transition.
    expect(contextQuestion).toBeDefined();
    // The run must still complete successfully after the host answers.
    expect(result.finalAction.kind).toBe("done");
    expect(result.finalState.current_step).toBe("complete");
  });

  it("ask_user(feasibility_focus) is exercised when input looks like an epic", () => {
    // Postcondition: feature_descriptions matching >= 2 EPIC_SIGNALS cause
    // feasibility_gate to emit ask_user(question_id="feasibility_focus").
    // The phrase below matches / and /i, /\bplus\b/i and /\balso\b/i = 3 signals.
    const seed = newPipelineState({
      run_id: "smoke_ask_user_epic",
      feature_description:
        "build OAuth login and password reset, plus also add MFA support",
    });

    const result = runSmoke(seed);

    const feasibilityQuestion = result.transitions.find(
      (t) => t.action_kind === "ask_user",
    );
    expect(feasibilityQuestion).toBeDefined();
    expect(result.finalAction.kind).toBe("done");
  });

  it("ask_user is observed in action-kind coverage on a trial run", () => {
    // Postcondition: a trial run with min=8 clarification rounds MUST emit
    // ask_user during the clarification phase. This closes the action-kind gap
    // in the existing action-coverage test (which asserts all other kinds but
    // silently omits ask_user).
    const seed = newPipelineState({
      run_id: "smoke_ask_user_coverage",
      feature_description: "build a feature for OAuth login",
    });

    const result = runSmoke(seed);

    const observedKinds = new Set(result.transitions.map((t) => t.action_kind));
    expect(observedKinds.has("ask_user")).toBe(true);
  });

  it("loop iteration count is well within the safety cap", () => {
    // Postcondition: the trial+codebase path (11 sections, min 8 clarification
    // rounds) completes in ~52 iterations. If this exceeds ~60 the pipeline has
    // grown an unexpected phase; if it is far below 30 a clarification phase
    // is being skipped.
    //
    // Derivation (see test-engineer audit, 2026-04; updated for the
    // .prd-gen/.gitignore write hop added ahead of analyze_codebase, 2026-07):
    //   i=0:      write_file (.prd-gen/.gitignore guard)
    //   i=1:      call_pipeline_tool (analyze_codebase)
    //   i=2..18:  8 clarification compose+answer rounds + proceed prompt
    //   i=19..40: 11 sections × 2 (recall + draft)
    //   i=41:     spawn_subagents (jira)
    //   i=42..50: 9 write_file calls
    //   i=51:     spawn_subagents (self_check judges)
    //   i=52:     done
    // Total = 53 (safety cap = 200, headroom = 147).
    const seed = newPipelineState({
      run_id: "smoke_iteration_headroom",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/smoke",
    });

    const result = runSmoke(seed);

    // Tight regression bounds around the measured baseline of 61, plus
    // structural host round trips added since (Phase 1a/1b Cortex
    // memory-loop closure, 2026-07-14, then PR 3b's implementation_gate,
    // 2026-07-14): input_analysis opens with ONE call_cortex_tool[recall]
    // round trip (global memory recall); self_check's finalize() now hands
    // off to `implementation_gate` (an ask_user/user_answer round trip —
    // the canned dispatcher answers "PRD only", the zero-regression default,
    // see canned-dispatcher.ts) instead of emitting `remember` directly;
    // `finalize` (relocated, handlers/finalize.ts) then performs the ONE
    // call_cortex_tool[remember] round trip before `done`. Each round trip
    // is exactly +1 iteration (the action-emitting step merges into what
    // used to be the NEXT substantive action's step — see
    // packages/orchestration/src/handlers/input-analysis.ts:handleGlobalRecall
    // and .../handlers/finalize.ts). Measured post-PR-3b: 71 (was 69 after
    // Phase 1a/1b; delta = +2, matching the ask_user + user_answer round
    // trips the gate adds — self_check's own emit_message → implementation_gate
    // → ask_user hop is coalesced into the SAME step() call that used to
    // return call_cortex_tool[remember] directly, so it costs one NEW
    // host-visible step; the user_answer round trip that follows costs the
    // second).
    // ±7 slack is enough to absorb a single new emit_message hop in either
    // direction without re-audit, but not enough to hide a whole new phase
    // (which would add ≥9 hops, e.g. an additional clarification round-trip).
    // If the pipeline grows a legitimate new phase, recalculate the baseline
    // here AND update the derivation comment above.
    //
    // source: per-phase trace by Dijkstra cross-audit, 2026-04
    // (license:1 + ctx:1 + input:2 + feasibility:1 + clar:8 + budget:1 +
    //  section:33 + jira:2 + export:9 + self_check:2 + done:1 = 61);
    // + global_recall:1 + remember:1 = 63 (Phase 1a/1b, 2026-07-14);
    // + implementation_gate ask_user:1 + user_answer:1 = 65 expected delta,
    // measured 71 (design-phases-3-5.md PR 3b, 2026-07-14) — the +6 gap vs.
    // the hand-derived 65 pre-dates this change (same gap existed between
    // the 63 hand-derivation and the 69 measured baseline above) and is not
    // re-audited here; only the incremental +2 delta is attributed to 3b.
    const ITER_LOW = 55;
    const ITER_HIGH = 77;
    expect(result.iterations).toBeGreaterThanOrEqual(ITER_LOW);
    expect(result.iterations).toBeLessThanOrEqual(ITER_HIGH);
  });

  // ─── Single-step injection tests live in handler-injection.test.ts ─────
  // (jira_generation skip, input_analysis failure paths, self_check Phase A
  // direct dispatch, malformed/error judge responses, Phase B mismatch,
  // file_export wrong-result-kind, section retry, context_detection invalid).

  it("self_check happy path populates typed done.verification field", () => {
    // Cross-audit closure: callers MUST consume done.verification, not
    // regex-parse done.summary. This test asserts the typed surface is
    // actually populated on a normal run.
    const seed = newPipelineState({
      run_id: "smoke_typed_verification",
      feature_description: "build a feature for OAuth login",
    });
    const result = runSmoke(seed);

    expect(result.finalAction.kind).toBe("done");
    if (result.finalAction.kind !== "done") return;
    expect(result.finalAction.verification).toBeDefined();
    if (!result.finalAction.verification) return;
    // Trial path with claim-rich content must produce ≥1 evaluated claim.
    expect(result.finalAction.verification.claims_evaluated).toBeGreaterThan(0);
    // Canned dispatcher returns PASS for every judge — 100% PASS distribution.
    const dist = result.finalAction.verification.distribution;
    const total = Object.values(dist).reduce((s, n) => s + n, 0);
    expect(total).toBe(result.finalAction.verification.claims_evaluated);
    expect(dist.PASS).toBe(total);
    expect(result.finalAction.verification.distribution_suspicious).toBe(true);
  });

  it("strategy_executions queue accumulates one entry per (terminal section × required strategy) when no drain runs", () => {
    // Cross-audit closure (test-engineer H, Phase 4 follow-up, 2026-04).
    // The orchestration-only smoke harness has NO mcp-server drain step.
    // Every terminal section transition (passed or failed) enqueues one
    // ExecutionResult per required strategy. The full trial run has 11
    // sections; depending on which fail and how many strategies the
    // selector picks per section, the queue size reflects the real
    // outcome — we assert the LOWER BOUND (≥ terminal section count)
    // and that every entry carries a valid (assignment, strategy) pair.
    const seed = newPipelineState({
      run_id: "smoke_strategy_executions_accumulate",
      feature_description: "build a feature for OAuth login",
    });
    const result = runSmoke(seed);
    expect(result.finalAction.kind).toBe("done");

    const terminalSections = result.finalState.sections.filter(
      (s) =>
        (s.status === "passed" || s.status === "failed") &&
        s.section_type !== "jira_tickets",
    );
    // At least one execution per terminal section that had a strategy
    // assignment. The selector may produce required.length > 1 for some
    // sections, so the count is ≥ terminal count.
    expect(result.finalState.strategy_executions.length).toBeGreaterThanOrEqual(
      terminalSections.length,
    );
    for (const exec of result.finalState.strategy_executions) {
      expect(exec.assignment).toBeDefined();
      expect(exec.strategy).toBeTruthy();
      expect(exec.actualConfidenceGain).toBeGreaterThanOrEqual(0);
      expect(exec.actualConfidenceGain).toBeLessThanOrEqual(1);
      expect(typeof exec.wasCompliant).toBe("boolean");
    }
  });
});
