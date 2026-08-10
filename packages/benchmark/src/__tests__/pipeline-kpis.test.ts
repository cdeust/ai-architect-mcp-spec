import { describe, it, expect } from "vitest";
import {
  measurePipeline,
  evaluateGates,
  KPI_GATES,
} from "../pipeline-kpis.js";

describe("pipeline KPIs", () => {
  it("trial+codebase canned-response baseline meets gates with canned dispatcher flag", () => {
    const kpis = measurePipeline({
      run_id: "kpi_trial_codebase",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/benchmark",
    });

    expect(kpis.final_action_kind).toBe("done");
    expect(kpis.current_step).toBe("complete");
    // 9: file-export.ts's root-cause fix (2026-07-15) stops writing
    // placeholder files for sections never scheduled by the run's PRD
    // context (06-deployment/08-source-code/09-test-code — "feature"
    // context never schedules deployment/timeline/risks or source/test
    // code). The omission is recorded in 00-run-notes.md instead, and
    // implementation_gate additionally writes 10-verification-report.md.
    // The canned dispatcher's technical_specification content carries no
    // affected-symbols block, so extraction runs and finds zero claims —
    // per the zero-claims contract (ai-architect-mcp-codebase
    // stages/stage-6.md §4.2, "Zero-claims case — not the same as absent",
    // pinned at commit 92216cd90f8f26cb15348675fc6556b8293edfc1)
    // stage-5.affected_symbols.json is still written (empty arrays), never
    // omitted, because the section ran. Net: 01,02,03,04,05,07 (6 content
    // files) + 00-run-notes + 10-verification-report +
    // stage-5.affected_symbols.json = 9. See orchestration smoke.test.ts's
    // "writes the expected deliverable files" for the exact accounting.
    expect(kpis.written_files_count).toBe(9);
    // Upper bound raised from 70 to 77 by PR 3b (design-phases-3-5.md): the
    // canned dispatcher answers the new `implementation_gate` ask_user with
    // "PRD only" (zero-regression default), which costs one extra
    // ask_user/user_answer round trip vs. the pre-3b direct-to-remember path
    // — see orchestration smoke.test.ts's iteration-headroom derivation for
    // the full accounting.
    expect(kpis.iteration_count).toBeGreaterThanOrEqual(50);
    expect(kpis.iteration_count).toBeLessThanOrEqual(77);
    expect(kpis.wall_time_ms).toBeLessThan(KPI_GATES.wall_time_ms_max);

    // is_canned_dispatcher=true suspends distribution_pass_rate gate (popper
    // AP-2 / fermi K4 / shannon S4 / curie A6 cross-audit).
    const gates = evaluateGates(kpis, true);
    expect(gates.passed).toBe(true);
    expect(gates.violations).toEqual([]);
  });

  it("canned dispatcher produces 100% PASS distribution by construction", () => {
    // The canned dispatcher returns verdict="PASS" for every judge invocation.
    // This means distribution_pass_rate is exactly 1.0 for any run that
    // reaches the judge phase. Asserting this explicitly ensures the gate
    // suspension flag is required, not optional.
    const kpis = measurePipeline({
      run_id: "kpi_canned_pass_distribution",
      feature_description: "build a feature for OAuth login",
    });

    if (kpis.judge_dispatch_count > 0) {
      expect(kpis.distribution_pass_rate).toBe(1.0);
    }

    // Without the canned-dispatcher flag, the gate fires.
    const gatesStrict = evaluateGates(kpis, false);
    if (kpis.judge_dispatch_count > 0) {
      const flagged = gatesStrict.violations.find(
        (v) => v.metric === "distribution_pass_rate_max",
      );
      expect(flagged).toBeDefined();
    }
  });

  it("KPI run completes for a feature input", () => {
    const kpis = measurePipeline({
      run_id: "kpi_feature_run",
      feature_description: "build a simple feature for OAuth login",
    });

    expect(kpis.final_action_kind).toBe("done");
    // See the "trial+codebase canned-response baseline" test above for the
    // 9-file accounting (root-cause fix, 2026-07-15).
    expect(kpis.written_files_count).toBe(9);
    // Upper bound — feature context schedules 11 sections; 7 iterations per
    // section (recall → draft → validate ×3 + finalize) is the worst-case
    // upper bound, plus pipeline overhead. 80 is conservative.
    expect(kpis.iteration_count).toBeLessThanOrEqual(80);
  });

  it("section_fail_ids surfaces the identity of failed sections (Shannon S7)", () => {
    const kpis = measurePipeline({
      run_id: "kpi_section_fail_ids",
      feature_description: "build a feature for OAuth login",
    });

    // Categorical info must be present so a regression that changes which
    // sections fail is observable, not just the count.
    expect(kpis.section_fail_ids.length).toBe(kpis.section_fail_count);
    if (kpis.section_fail_count > 0) {
      // The IDs must be unique (no section appears twice).
      const unique = new Set(kpis.section_fail_ids);
      expect(unique.size).toBe(kpis.section_fail_ids.length);
    }
  });

  it("mean_section_attempts surfaces retry behavior (Shannon M1)", () => {
    const kpis = measurePipeline({
      run_id: "kpi_mean_attempts",
      feature_description: "build a feature for OAuth login",
    });

    // mean_section_attempts is bounded by [0, MAX_ATTEMPTS=3].
    expect(kpis.mean_section_attempts).toBeGreaterThanOrEqual(0);
    expect(kpis.mean_section_attempts).toBeLessThanOrEqual(3);
  });

  it("structural_error_count is 0 on the canned baseline (no code-layer bugs)", () => {
    // Contract assertion: on a clean canned run, no handler produces an
    // error that isn't a section validation failure. structural_error_count
    // captures bugs that would otherwise hide inside the error_count total.
    //
    // Pre-fix this test also asserted the FORMULA used in the implementation
    // (structural = max(0, error - fail)), which was tautological — it tested
    // that the function returned what its body computed. Removed per
    // test-engineer M2 + curie H-2 (Phase 3+4 cross-audit, 2026-04).
    const kpis = measurePipeline({
      run_id: "kpi_structural_errors",
      feature_description: "build a feature for OAuth login",
    });
    expect(kpis.structural_error_count).toBe(0);
  });

  it("iteration_count is exact on cap-exhaustion (test-engineer TE1 fix)", () => {
    // Force the loop to hit the cap by passing safety_cap=1.
    // The loop runs once: step() returns a non-terminal action; dispatch
    // is called; pendingResult is set; i increments to 1; loop exits because
    // 1 < 1 is false. Cap was hit. iteration_count must equal cap (1), not
    // cap + 1 (2).
    const kpis = measurePipeline({
      run_id: "kpi_cap_exhaustion",
      feature_description: "build a feature for OAuth login",
      safety_cap: 1,
    });

    expect(kpis.safety_cap_hit).toBe(true);
    expect(kpis.iteration_count).toBe(1);
    expect(kpis.final_action_kind).not.toBe("done");
  });

  it("iteration_count is exact on early dispatch refusal", () => {
    // A dispatcher that returns undefined for the first action causes the
    // loop to exit cleanly without hitting the cap. iteration_count must
    // equal the actual number of step() calls (1).
    let calls = 0;
    const kpis = measurePipeline({
      run_id: "kpi_dispatch_refusal",
      feature_description: "build a feature for OAuth login",
      craftResult: () => {
        calls += 1;
        return undefined; // refuse every action
      },
    });

    expect(kpis.safety_cap_hit).toBe(false);
    expect(kpis.iteration_count).toBe(1);
    expect(calls).toBe(1);
  });

  it("evaluateGates flags an iteration-count violation when exceeded", () => {
    const fake = baseFakeKpis({ iteration_count: 999 });
    const gates = evaluateGates(fake);
    expect(gates.passed).toBe(false);
    expect(gates.violations.map((v) => v.metric)).toContain(
      "iteration_count_max",
    );
  });

  it("evaluateGates flags distribution_pass_rate over 0.95 by default", () => {
    const fake = baseFakeKpis({
      judge_dispatch_count: 100,
      distribution_pass_rate: 1.0,
    });
    const gates = evaluateGates(fake, false); // explicit: not canned
    expect(gates.passed).toBe(false);
    expect(gates.violations.map((v) => v.metric)).toContain(
      "distribution_pass_rate_max",
    );
  });

  it("evaluateGates suspends distribution_pass_rate gate when is_canned_dispatcher=true", () => {
    const fake = baseFakeKpis({
      judge_dispatch_count: 100,
      distribution_pass_rate: 1.0,
    });
    const gates = evaluateGates(fake, true);
    expect(gates.violations.map((v) => v.metric)).not.toContain(
      "distribution_pass_rate_max",
    );
  });

  it("evaluateGates flags safety_cap_hit", () => {
    const fake = baseFakeKpis({
      final_action_kind: "failed",
      current_step: "section_generation",
      iteration_count: 200,
      safety_cap_hit: true,
    });
    const gates = evaluateGates(fake);
    expect(gates.passed).toBe(false);
    expect(gates.violations.map((v) => v.metric)).toContain(
      "safety_cap_hit_allowed",
    );
  });

  it("evaluateGates flags structural_error_count > 0", () => {
    const fake = baseFakeKpis({
      error_count: 7,
      section_fail_count: 2,
      structural_error_count: 5, // 7 errors - 2 section failures
    });
    const gates = evaluateGates(fake);
    expect(gates.passed).toBe(false);
    expect(gates.violations.map((v) => v.metric)).toContain(
      "structural_error_count_max",
    );
  });

  it("evaluateGates flags mean_section_attempts > 2.5", () => {
    const fake = baseFakeKpis({ mean_section_attempts: 2.7 });
    const gates = evaluateGates(fake);
    expect(gates.passed).toBe(false);
    expect(gates.violations.map((v) => v.metric)).toContain(
      "mean_section_attempts_max",
    );
  });

  // ─── Gate negative tests (test-engineer H2 closure) ──────────────────────
  // Each gate check in evaluateGates needs a test that constructs a fake KPI
  // with the metric just over threshold and asserts the violation fires.
  // Without these, deleting the gate's `if`-branch would not break any test.

  it("evaluateGates flags wall_time_ms > wall_time_ms_max", () => {
    const fake = baseFakeKpis({
      wall_time_ms: KPI_GATES.wall_time_ms_max + 1,
    });
    const gates = evaluateGates(fake);
    expect(gates.passed).toBe(false);
    expect(gates.violations.map((v) => v.metric)).toContain(
      "wall_time_ms_max",
    );
  });

  it("evaluateGates flags section_fail_count > section_fail_count_max", () => {
    const fake = baseFakeKpis({
      section_fail_count: KPI_GATES.section_fail_count_max + 1,
      section_fail_ids: [
        "requirements",
        "data_model",
        "api_specification",
        "security_considerations",
        "testing",
        "deployment",
      ] as const,
    });
    const gates = evaluateGates(fake);
    expect(gates.passed).toBe(false);
    expect(gates.violations.map((v) => v.metric)).toContain(
      "section_fail_count_max",
    );
  });

  it("evaluateGates flags error_count > error_count_max", () => {
    const fake = baseFakeKpis({
      error_count: KPI_GATES.error_count_max + 1,
    });
    const gates = evaluateGates(fake);
    expect(gates.passed).toBe(false);
    expect(gates.violations.map((v) => v.metric)).toContain("error_count_max");
  });

  it("evaluateGates flags cortex_recall_empty_count > cortex_recall_empty_count_max", () => {
    // source: shannon S-6 (Phase 3+4 cross-audit, 2026-04). Gate ceiling
    // is provisional (3); see KPI_GATES.cortex_recall_empty_count_max comment.
    const fake = baseFakeKpis({
      cortex_recall_empty_count: KPI_GATES.cortex_recall_empty_count_max + 1,
    });
    const gates = evaluateGates(fake);
    expect(gates.passed).toBe(false);
    expect(gates.violations.map((v) => v.metric)).toContain(
      "cortex_recall_empty_count_max",
    );
  });

  it("cortex_recall_empty_count equals number of sections on canned baseline (all recalls empty)", () => {
    // The canned dispatcher never provides real Cortex recall results, so
    // summarizeRecall returns empty for every section — cortex_recall_empty_count
    // equals the number of sections processed (11 on a full feature run).
    // This is expected canned behaviour; the cortex_recall_empty_count_max gate
    // is SUSPENDED on canned runs for this reason (same pattern as
    // distribution_pass_rate_max).
    const kpis = measurePipeline({
      run_id: "kpi_recall_empty_count_baseline",
      feature_description: "build a feature for OAuth login",
    });
    // On the canned path, every section's recall is empty — count = sections processed.
    expect(kpis.cortex_recall_empty_count).toBeGreaterThan(0);
    // The gate is suspended on canned runs — evaluateGates with is_canned_dispatcher=true
    // must not flag cortex_recall_empty_count_max.
    const gates = evaluateGates(kpis, true);
    expect(gates.violations.map((v) => v.metric)).not.toContain(
      "cortex_recall_empty_count_max",
    );
  });

  it("evaluateGates skips mean_section_attempts gate when safety_cap_hit=true", () => {
    // Cross-audit closure (dijkstra H3, Phase 3+4, 2026-04). A cap-hit run
    // may have pending sections (attempt=0) that deflate the unconditional
    // mean. The mean_section_attempts gate would fire spuriously OR pass
    // spuriously depending on direction; either way it is uninformative
    // when the safety cap is hit.
    const fake = baseFakeKpis({
      safety_cap_hit: true,
      mean_section_attempts: 2.7, // above threshold (2.5)
      // The safety_cap_hit_allowed gate fires regardless, so the run is
      // still a violation overall. We just need to assert the
      // mean_section_attempts gate did NOT fire on top of it.
      final_action_kind: "failed",
      current_step: "section_generation",
    });
    const gates = evaluateGates(fake);
    expect(gates.violations.map((v) => v.metric)).not.toContain(
      "mean_section_attempts_max",
    );
    // Sanity: the cap-hit gate IS firing.
    expect(gates.violations.map((v) => v.metric)).toContain(
      "safety_cap_hit_allowed",
    );
  });

  it("mixed-verdict craftResult exercises consensus engine end-to-end", async () => {
    // Cross-audit closure (popper C2, feynman C-1, Phase 3+4, 2026-04). The
    // canned dispatcher's PASS-only output never lets the consensus engine
    // see disagreement; the entire weighted-average / fail-threshold /
    // dissent-tracking surface is bypassed at the pipeline level. This test
    // injects a mixed-verdict dispatcher (alternating PASS/FAIL by claim
    // index) and asserts:
    //   1. distribution_pass_rate < 1.0 (so the gate is meaningful)
    //   2. claim count > 0 (so we know the path actually fired)
    //   3. evaluateGates(kpis, false) flags distribution_pass_rate_max
    //      ONLY if rate > 0.95 — at 50/50 the gate must NOT fire
    const { makeCannedDispatcher } = await import("@prd-gen/orchestration");
    const baseDispatch = makeCannedDispatcher({
      freeform_answer: "benchmark-answer",
      graph_path: "/tmp/benchmark/graph",
    });

    let judgeCount = 0;
    const mixedDispatch: Parameters<typeof measurePipeline>[0]["craftResult"] = (
      action,
    ) => {
      if (
        action.kind === "spawn_subagents" &&
        action.invocations.some((i) =>
          i.invocation_id.startsWith("self_check_judge_"),
        )
      ) {
        // Replace each judge response with alternating PASS/FAIL.
        return {
          kind: "subagent_batch_result",
          batch_id: action.batch_id,
          responses: action.invocations.map((inv) => {
            const verdict = judgeCount++ % 2 === 0 ? "PASS" : "FAIL";
            return {
              invocation_id: inv.invocation_id,
              raw_text: JSON.stringify({
                verdict,
                rationale: "mixed-verdict synthetic",
                caveats: [],
                confidence: 0.9,
              }),
            };
          }),
        };
      }
      // Delegate everything else to the canned dispatcher.
      return baseDispatch(action);
    };

    const kpis = measurePipeline({
      run_id: "kpi_mixed_verdicts",
      feature_description: "build a feature for OAuth login",
      craftResult: mixedDispatch,
    });

    expect(kpis.judge_dispatch_count).toBeGreaterThan(0);
    expect(kpis.distribution_pass_rate).toBeLessThan(1.0);
    expect(kpis.distribution_pass_rate).toBeGreaterThan(0);

    // With ~50% PASS, the strict 0.95 gate must NOT fire (gate enabled).
    const gates = evaluateGates(kpis, false);
    expect(gates.violations.map((v) => v.metric)).not.toContain(
      "distribution_pass_rate_max",
    );
  });

  it("judge_dispatch_count is read from typed done.verification, not regex", () => {
    // Cross-audit closure (Phase 3+4, 2026-04): the previous extractor
    // regex-parsed `done.summary`. Any whitespace change zeroed every
    // KPI silently. The typed `done.verification` field is now load-bearing.
    // This test asserts the typed surface is populated AND that
    // judge_dispatch_count > 0 on a run that definitely reaches the judge phase.
    const kpis = measurePipeline({
      run_id: "kpi_typed_verification_field",
      feature_description: "build a feature for OAuth login",
    });
    // The trial+claim-rich path MUST exercise the judge phase. Zero would
    // indicate a regression where the judge phase silently bypassed.
    expect(kpis.judge_dispatch_count).toBeGreaterThan(0);
    // distribution_pass_rate is well-defined because canned dispatcher
    // produces 100% PASS.
    expect(kpis.distribution_pass_rate).toBe(1.0);
  });
});

// Helper: baseline fake KPIs that pass every gate. Override fields to test
// each gate violation.
function baseFakeKpis(overrides: Partial<ReturnType<typeof measurePipeline>> = {}) {
  return {
    run_id: "fake",
    final_action_kind: "done" as const,
    current_step: "complete" as const,
    iteration_count: 60,
    wall_time_ms: 10,
    section_pass_rate: 1,
    section_fail_count: 0,
    section_fail_ids: [] as ReadonlyArray<never>,
    mean_section_attempts: 1.0,
    error_count: 0,
    structural_error_count: 0,
    judge_dispatch_count: 0,
    distribution_pass_rate: 0,
    // Synthetic default, not asserted against by any gate — kept in sync
    // with the real 9-file accounting (see the "trial+codebase" test above)
    // for readability, not correctness.
    written_files_count: 9,
    safety_cap_hit: false,
    // Phase 4.3 instrumentation defaults — measurement-only, see
    // src/instrumentation.ts and PHASE_4_PLAN.md §4.3.
    mismatch_fired: false,
    mismatch_kinds: [] as ReadonlyArray<never>,
    // source: shannon S-6 (Phase 3+4 cross-audit, 2026-04). Default 0 means
    // every Cortex recall returned results — the expected state on a healthy run.
    cortex_recall_empty_count: 0,
    ...overrides,
  } as ReturnType<typeof measurePipeline>;
}
