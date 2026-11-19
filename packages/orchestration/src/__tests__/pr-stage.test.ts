/**
 * `pr_gate` + `pr_creation` — the trust-seam gate and PR-creation spawn
 * (design-phases-3-5.md §3, §4, §6, PR 5).
 *
 * Proves:
 *   1. `pr_gate` presents an honest summary — including an advisory FAIL
 *      verdict — and always asks (mandatory, non-skippable).
 *   2. `pr_gate` "No" is a valid TERMINAL path (not a failure): advances to
 *      `finalize` with `post_specs.pr = {pushed:false, url:null}`.
 *   3. `pr_gate` non-bypass: a replay with no matching answer ALWAYS
 *      re-asks — even when `post_specs.pr` happens to already be set (no
 *      idempotency shortcut exists for this step, unlike every other step
 *      in the loop).
 *   4. `pr_creation` nominal: one spawn_subagents (purpose "pr",
 *      subagent_type "engineer", isolation "none", SAME worktree/branch);
 *      a report with a parsable `PR_URL:` footer is stored and advances to
 *      `finalize` with `post_specs.pr = {pushed:true, url}`.
 *   5. `pr_creation` failure → degrade: a subagent error degrades
 *      (`upstream_failure` recorded, `pr.pushed=false`) and STILL advances
 *      to `finalize`.
 *   6. `pr_creation` footer absent → degrade: same degrade path when the
 *      response has no parsable `PR_URL:` footer.
 *   7. `pr_creation` idempotency: a replay after `post_specs.pr` is already
 *      recorded skips straight to `finalize` without re-spawning.
 *   8. Smoke full-traversal: a full run driven through "Implement" → PASS
 *      review → "Push + open PR" reaches `complete` with a PR URL recorded.
 *
 * source: design-phases-3-5.md §3, §4, §6, PR 5.
 */

import { expectOptionRetry } from "./expect-option-retry.js";
import { describe, expect, it } from "vitest";
import {
  makeCannedDispatcher,
  newPipelineState,
  step,
  type ActionResult,
  type PipelineState,
} from "../index.js";

/** Must match handlers/protocol-ids.ts. */
const PR_GATE_QUESTION_ID = "pr_gate";
const PR_CREATION_INV_ID = "pr_creation_engineer";

function basePostSpecs() {
  return {
    decision: "implement" as const,
    impact_queries: { done: true, index: 0, results: [] },
    implementation: {
      branch: "feat/oauth",
      worktree_path: "/tmp/engineer-worktree",
      changed_files: ["src/auth.ts"],
      raw_report: "Implemented OAuth login.",
    },
    verification: {
      step: "done" as const,
      after_graph_path: "/g/after",
      changed_symbols: ["src/auth.ts::login"],
      detect_changes: null,
      verify_semantic_diff: null,
      check_security_gates: null,
      gates_passed: true,
    },
    testing: { raw_report: "All tests pass." },
    review: { verdict: "pass" as const, findings: [] as string[], attempt: 1 },
    pr: null,
    retry_count: 0,
  };
}

function stateAtPrGate(
  opts: { reviewFailVerdict?: boolean; prAlreadyRecorded?: boolean } = {},
): PipelineState {
  const s = newPipelineState({
    run_id: "pr_001",
    feature_description: "OAuth login",
    codebase_path: "/tmp/pr-fixture",
  });
  const postSpecs = basePostSpecs();
  return {
    ...s,
    current_step: "pr_gate",
    written_files: ["prd-output/x/technical_specification.md"],
    pending_completion: {
      summary: "Self-check complete. 3/3 sections passed.",
      artifacts: ["overview: passed"],
    },
    post_specs: {
      ...postSpecs,
      review: opts.reviewFailVerdict
        ? { verdict: "fail", findings: ["fix the thing"], attempt: 4 }
        : postSpecs.review,
      pr: opts.prAlreadyRecorded ? { pushed: true, url: "https://example.com/pr/1" } : null,
    },
  };
}

function stateAtPrCreation(opts: { prAlreadyRecorded?: boolean } = {}): PipelineState {
  const s = newPipelineState({
    run_id: "pr_002",
    feature_description: "OAuth login",
    codebase_path: "/tmp/pr-fixture",
  });
  const postSpecs = basePostSpecs();
  return {
    ...s,
    current_step: "pr_creation",
    written_files: ["prd-output/x/technical_specification.md"],
    pending_completion: {
      summary: "Self-check complete. 3/3 sections passed.",
      artifacts: ["overview: passed"],
    },
    post_specs: {
      ...postSpecs,
      pr: opts.prAlreadyRecorded ? { pushed: true, url: "https://example.com/pr/prior" } : null,
    },
  };
}

// ─── pr_gate ────────────────────────────────────────────────────────────────

describe("pr_gate — honest summary, mandatory ask", () => {
  it("presents review verdict (including an advisory FAIL), gates_passed, changed-file count, and branch", () => {
    const out = step({ state: stateAtPrGate({ reviewFailVerdict: true }) });

    expect(out.action.kind).toBe("ask_user");
    if (out.action.kind !== "ask_user") return;
    expect(out.action.question_id).toBe(PR_GATE_QUESTION_ID);
    expect(out.action.description).toContain("FAIL");
    expect(out.action.description).toContain("fix the thing");
    expect(out.action.description).toContain("gates passed: true");
    expect(out.action.description).toContain("1");
    expect(out.action.description).toContain("feat/oauth");
    expect(out.action.options).toHaveLength(2);
    expect(out.action.options?.[0].label).toBe("Push + open PR");
    expect(out.action.options?.[1].label).toBe("No");
  });

  it("presents a PASS verdict just as plainly", () => {
    const out = step({ state: stateAtPrGate() });
    expect(out.action.kind).toBe("ask_user");
    if (out.action.kind !== "ask_user") return;
    expect(out.action.description).toContain("PASS");
  });
});

describe("pr_gate — 'No' is a valid terminal path, not a failure", () => {
  it("advances to finalize with post_specs.pr = {pushed:false, url:null}", () => {
    const issued = step({ state: stateAtPrGate() });

    const out = step({
      state: issued.state,
      result: { kind: "user_answer", question_id: PR_GATE_QUESTION_ID, selected: ["No"] },
    });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.pr).toEqual({ pushed: false, url: null });
    expect(out.state.errors.length).toBe(0);
    expect(out.action.kind).not.toBe("failed");
  });
});

describe("pr_gate — 'Push + open PR' advances to pr_creation", () => {
  it("emits pr_creation's spawn_subagents (purpose pr) without touching post_specs.pr", () => {
    const issued = step({ state: stateAtPrGate() });

    const out = step({
      state: issued.state,
      result: {
        kind: "user_answer",
        question_id: PR_GATE_QUESTION_ID,
        selected: ["Push + open PR"],
      },
    });

    expect(out.state.current_step).toBe("pr_creation");
    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") return;
    expect(out.action.purpose).toBe("pr");
    expect(out.action.invocations[0].subagent_type).toBe("engineer");
    expect(out.action.invocations[0].isolation).toBe("none");
  });
});

describe("pr_gate — non-bypass (never skipped by idempotency)", () => {
  it("re-asks on a fresh entry with no matching answer, even when post_specs.pr is already set", () => {
    const out = step({ state: stateAtPrGate({ prAlreadyRecorded: true }) });

    // NO idempotency shortcut: this gate must always ask, unlike every
    // other step in the loop.
    expect(out.action.kind).toBe("ask_user");
    if (out.action.kind !== "ask_user") return;
    expect(out.action.question_id).toBe(PR_GATE_QUESTION_ID);
  });

  it.each(["do not push", "don't push", "no push please", "push", "", undefined, "unknown"])(
    "re-asks without recording a PR decision for %s", (freeform) => {
      const issued = step({ state: stateAtPrGate() });
      const out = step({ state: issued.state, result: { kind: "user_answer", question_id: PR_GATE_QUESTION_ID, selected: [], freeform } });
      expectOptionRetry(out.action, issued.action);
      expect(out.state.post_specs).toEqual(issued.state.post_specs);
    },
  );

  it.each([[" PUSH   + OPEN PR ", "pr_creation"], ["No", "finalize"]])(
    "routes the typed label %s to %s", (freeform, next) => {
      const out = step({ state: stateAtPrGate(), result: { kind: "user_answer", question_id: PR_GATE_QUESTION_ID, selected: [], freeform } });
      expect(out.state.current_step).toBe(next);
    },
  );
});

// ─── pr_creation ────────────────────────────────────────────────────────────

describe("pr_creation — nominal spawn", () => {
  it("emits one spawn_subagents (purpose pr, subagent_type engineer, isolation none) on the SAME worktree", () => {
    const out = step({ state: stateAtPrCreation() });

    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") return;
    expect(out.action.purpose).toBe("pr");
    expect(out.action.invocations).toHaveLength(1);
    expect(out.action.invocations[0].invocation_id).toBe(PR_CREATION_INV_ID);
    expect(out.action.invocations[0].subagent_type).toBe("engineer");
    expect(out.action.invocations[0].isolation).toBe("none");
    expect(out.action.invocations[0].prompt).toContain("/tmp/engineer-worktree");
    expect(out.action.invocations[0].prompt).toContain("feat/oauth");
    expect(out.action.invocations[0].prompt).toContain("Do NOT merge");
  });

  it("a report with a parsable PR_URL: footer is stored and advances to finalize", () => {
    const issued = step({ state: stateAtPrCreation() });
    const batch_id = issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [
          {
            invocation_id: PR_CREATION_INV_ID,
            raw_text: "Pushed and opened.\n\nPR_URL: https://github.com/example/repo/pull/42",
          },
        ],
      },
    });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.pr).toEqual({
      pushed: true,
      url: "https://github.com/example/repo/pull/42",
    });
    expect(out.state.errors.length).toBe(0);
  });
});

describe("pr_creation — subagent failure degrades, does not abort", () => {
  it("a subagent error records upstream_failure, sets pr.pushed=false, and STILL advances to finalize", () => {
    const issued = step({ state: stateAtPrCreation() });
    const batch_id = issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [{ invocation_id: PR_CREATION_INV_ID, error: "push rejected: no permission" }],
      },
    });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.pr).toEqual({ pushed: false, url: null });
    expect(out.state.errors.some((e) => e.includes("pr_creation subagent failed"))).toBe(true);
    expect(out.state.error_kinds[out.state.errors.length - 1]).toBe("upstream_failure");
    expect(out.action.kind).not.toBe("failed");
  });
});

describe("pr_creation — footer absent degrades, does not abort", () => {
  it("a response with no parsable PR_URL: footer degrades to pr.pushed=false and STILL advances to finalize", () => {
    const issued = step({ state: stateAtPrCreation() });
    const batch_id = issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";

    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [
          { invocation_id: PR_CREATION_INV_ID, raw_text: "Pushed the branch. Opened a PR." },
        ],
      },
    });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.pr).toEqual({ pushed: false, url: null });
    expect(
      out.state.errors.some((e) => e.includes("did not include a parsable PR_URL")),
    ).toBe(true);
    expect(out.state.error_kinds[out.state.errors.length - 1]).toBe("upstream_failure");
    expect(out.action.kind).not.toBe("failed");
  });
});

describe("pr_creation — idempotency", () => {
  it("a replay after post_specs.pr is already recorded skips to finalize without re-spawning", () => {
    const out = step({ state: stateAtPrCreation({ prAlreadyRecorded: true }) });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.pr).toEqual({ pushed: true, url: "https://example.com/pr/prior" });
    if (out.action.kind === "spawn_subagents") {
      expect(out.action.purpose).not.toBe("pr");
    }
  });
});

// ─── smoke: full traversal through to the PR ───────────────────────────────

describe("smoke — full traversal reaches the PR via Implement → PASS review → Push + open PR", () => {
  it("terminates with a recorded PR URL, never infinite-loops", () => {
    const SAFETY_CAP = 200;
    const dispatch = makeCannedDispatcher({
      implementation_gate_answer: "Implement",
      pr_gate_answer: "Push + open PR",
    });
    const seed = newPipelineState({
      run_id: "pr_smoke_full",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/pr-smoke-fixture",
    });

    let state: PipelineState = seed;
    let pendingResult: ActionResult | undefined = undefined;
    let iterations = 0;

    for (let i = 0; i < SAFETY_CAP; i++) {
      iterations = i + 1;
      const out = step({ state, result: pendingResult });
      state = out.state;
      if (out.action.kind === "done" || out.action.kind === "failed") {
        expect(out.action.kind).toBe("done");
        break;
      }
      pendingResult = dispatch(out.action);
      if (pendingResult === undefined) {
        throw new Error(`no canned result for action.kind=${out.action.kind}`);
      }
    }

    expect(iterations).toBeLessThan(SAFETY_CAP);
    expect(state.current_step).toBe("complete");
    expect(state.post_specs?.review?.verdict).toBe("pass");
    expect(state.post_specs?.pr).toEqual({
      pushed: true,
      url: "https://github.com/example/canned/pull/1",
    });
  });

  it("declining the pr_gate ('No') still reaches complete, with pr.pushed=false", () => {
    const SAFETY_CAP = 200;
    const dispatch = makeCannedDispatcher({
      implementation_gate_answer: "Implement",
      pr_gate_answer: "No",
    });
    const seed = newPipelineState({
      run_id: "pr_smoke_decline",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/pr-smoke-decline-fixture",
    });

    let state: PipelineState = seed;
    let pendingResult: ActionResult | undefined = undefined;

    for (let i = 0; i < SAFETY_CAP; i++) {
      const out = step({ state, result: pendingResult });
      state = out.state;
      if (out.action.kind === "done" || out.action.kind === "failed") {
        expect(out.action.kind).toBe("done");
        break;
      }
      pendingResult = dispatch(out.action);
      if (pendingResult === undefined) {
        throw new Error(`no canned result for action.kind=${out.action.kind}`);
      }
    }

    expect(state.current_step).toBe("complete");
    expect(state.post_specs?.pr).toEqual({ pushed: false, url: null });
  });
});
