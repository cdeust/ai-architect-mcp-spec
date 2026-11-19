/**
 * Canned-response dispatcher: shared between the smoke harness, the
 * pipeline-KPI benchmark, and any future integration test that needs to drive
 * the reducer end-to-end without real LLM/MCP/host wiring.
 *
 * source: code-reviewer B1 (Phase 3 cross-audit, 2026-04). Three-use rule
 * met (smoke + KPI + future integration tests). Pre-extraction the dispatch
 * was duplicated with subtle behavioural drift (different freeform answers,
 * graph_paths, missing JIRA invocation path on the KPI side).
 *
 * Dispatch is by `action.kind` ONLY. Subagent routing within
 * `spawn_subagents` is by `invocation_id` prefix — NEVER by `purpose`, which
 * is an observability label per actions.ts SpawnSubagentsActionSchema and
 * MUST NOT be consumed by the host.
 *
 * The `default: never` exhaustiveness arm makes adding a new NextAction kind
 * a compile error rather than a silent runtime miss.
 *
 * Usage:
 *   const dispatch = makeCannedDispatcher();           // sensible defaults
 *   const dispatch = makeCannedDispatcher({            // smoke-test labels
 *     freeform_answer: "smoke-test-answer",
 *     graph_path: "/tmp/smoke/.prd-gen/graphs/smoke/graph",
 *     fake_section_draft: customDraftFn,
 *   });
 */

import {
  GATE_OPTION_IMPLEMENT, GATE_OPTION_IMPLEMENT_ANYWAY, GATE_OPTION_OVERRIDE_POLICY, GATE_OPTION_PRD_ONLY,
} from "./handlers/verification-policy.js";
import type { ActionResult, NextAction } from "./types/actions.js";
import {
  QUESTION_ID_CONTINUE as CLARIFICATION_CONTINUE_QID,
  CLARIFICATION_COMPOSE_INV_PREFIX,
  SECTION_GENERATE_INV_PREFIX,
  SELF_CHECK_JUDGE_INV_PREFIX,
  JIRA_GENERATION_INV_ID,
  GIT_HISTORY_INV_ID,
  IMPLEMENTATION_GATE_QUESTION_ID,
  IMPLEMENTATION_INV_ID,
  TESTING_INV_ID,
  REVIEW_INV_PREFIX,
  PR_GATE_QUESTION_ID,
  PR_CREATION_INV_ID,
} from "./handlers/protocol-ids.js";
import {
  defaultFakeSectionDraft,
  fakeClarificationQuestion,
  fakeImplementationReport,
  fakeJudgeVerdict,
  fakePrCreationReport,
  fakeReviewReport,
  fakeTestingReport,
} from "./canned-responses.js";
import { claimIdsInJudgePrompt } from "@prd-gen/verification";

export interface CannedDispatcherOptions {
  /**
   * Freeform fallback for ask_user when the question carries no enumerated
   * options. Smoke tests use "smoke-test-answer"; benchmark uses
   * "benchmark-answer". Default: "canned-answer".
   */
  readonly freeform_answer?: string;
  /**
   * Synthetic graph_path returned for index_codebase. Some tests assert on
   * the exact value, so callers may want to pin it. Default:
   * "/tmp/canned/graph".
   */
  readonly graph_path?: string;
  /**
   * Custom draft producer for section_generate_* invocations. The argument
   * is the section_type extracted from the invocation_id suffix.
   * Default: synthetic markdown with claim-extractor-friendly content per
   * section (FR/AC tables, NFR sentences, security/architecture keywords)
   * so planDocumentVerification yields claims and the judge phase fires.
   */
  readonly fake_section_draft?: (section_type: string) => string;
  /** Allow "Implement" to select the explicit override offered for a non-pass verdict. */
  readonly override_policy?: boolean;
  /**
   * Defaults to "PRD only". "Implement" selects implementation on a pass.
   * A non-pass verdict keeps "PRD only" unless override_policy is true.
   */
  readonly implementation_gate_answer?: "PRD only" | "Implement";
  /**
   * Per-attempt verdict producer for the `review` step (PR 4b). Default:
   * always "pass" — the zero-regression default matching implementation's
   * nominal report contract. Tests exercising the FAIL→retry→PASS or
   * FAIL×N→advisory loop pass a custom function, e.g.
   * `(attempt) => (attempt < 3 ? "fail" : "pass")`.
   */
  readonly review_verdict_for_attempt?: (attempt: number) => "pass" | "fail";
  /**
   * Answer for the `pr_gate` ask_user (PR 5, design-phases-3-5.md §3).
   * Default "No" — the zero-risk terminal default (never pushes/opens a PR
   * unless a test explicitly opts in). Set to "Push + open PR" to drive the
   * `pr_creation` spawn in a full smoke run.
   */
  readonly pr_gate_answer?: "Push + open PR" | "No";
  /**
   * Whether the canned `pr_creation` engineer response includes a parsable
   * `PR_URL:` footer. Default true (nominal path). Set to false to exercise
   * pr-creation.ts's "footer absent → degrade" path in a full smoke run.
   */
  readonly pr_creation_footer_present?: boolean;
}

export type CannedDispatcher = (action: NextAction) => ActionResult | undefined;

/**
 * Build a canned dispatcher with the given options. Returns a function that
 * maps NextAction → ActionResult (or undefined for terminal actions, which
 * the loop driver treats as the cue to stop).
 */
export function makeCannedDispatcher(
  opts: CannedDispatcherOptions = {},
): CannedDispatcher {
  const freeform_answer = opts.freeform_answer ?? "canned-answer";
  const graph_path = opts.graph_path ?? "/tmp/canned/graph";
  const fake_section_draft = opts.fake_section_draft ?? defaultFakeSectionDraft;
  const implementation_gate_answer = opts.implementation_gate_answer ?? "PRD only";
  const review_verdict_for_attempt = opts.review_verdict_for_attempt ?? (() => "pass" as const);
  const pr_gate_answer = opts.pr_gate_answer ?? "No";
  const pr_creation_footer_present = opts.pr_creation_footer_present ?? true;

  function pickFakeAgentResponse(invocation_id: string, prompt: string): string {
    if (invocation_id.startsWith(SELF_CHECK_JUDGE_INV_PREFIX)) {
      return fakeJudgeVerdict(claimIdsInJudgePrompt(prompt));
    }
    if (invocation_id.startsWith(CLARIFICATION_COMPOSE_INV_PREFIX)) {
      return fakeClarificationQuestion();
    }
    if (invocation_id.startsWith(SECTION_GENERATE_INV_PREFIX)) {
      const section_type = invocation_id.slice(
        SECTION_GENERATE_INV_PREFIX.length,
      );
      return fake_section_draft(section_type);
    }
    if (invocation_id === JIRA_GENERATION_INV_ID) {
      return "## JIRA Tickets\n\nCanned JIRA placeholder.";
    }
    if (invocation_id === GIT_HISTORY_INV_ID) {
      return "History is silent within the searched space (canned git-historian response).";
    }
    if (invocation_id === IMPLEMENTATION_INV_ID) {
      return fakeImplementationReport();
    }
    if (invocation_id === TESTING_INV_ID) {
      return fakeTestingReport();
    }
    if (invocation_id.startsWith(REVIEW_INV_PREFIX)) {
      const attempt = Number(invocation_id.slice(REVIEW_INV_PREFIX.length));
      return fakeReviewReport(review_verdict_for_attempt(attempt));
    }
    if (invocation_id === PR_CREATION_INV_ID) {
      return fakePrCreationReport(pr_creation_footer_present);
    }
    return "Canned synthetic response.";
  }

  function craftUserAnswer(
    action: Extract<NextAction, { kind: "ask_user" }>,
  ): ActionResult {
    if (action.question_id === CLARIFICATION_CONTINUE_QID) {
      return {
        kind: "user_answer",
        question_id: action.question_id,
        selected: ["proceed"],
      };
    }
    if (action.question_id === IMPLEMENTATION_GATE_QUESTION_ID) {
      const approved = action.options?.find(({ label }) =>
        label === GATE_OPTION_IMPLEMENT ||
        (opts.override_policy && (label === GATE_OPTION_IMPLEMENT_ANYWAY || label === GATE_OPTION_OVERRIDE_POLICY)),
      );
      return {
        kind: "user_answer",
        question_id: action.question_id,
        selected: [implementation_gate_answer === GATE_OPTION_IMPLEMENT && approved ? approved.label : GATE_OPTION_PRD_ONLY],
      };
    }
    if (action.question_id === PR_GATE_QUESTION_ID) {
      // Explicit, not relying on options[0]: "No" is the zero-risk default
      // (design-phases-3-5.md §3, PR 5) — never pushes/opens a PR unless a
      // test explicitly opts in via pr_gate_answer.
      return {
        kind: "user_answer",
        question_id: action.question_id,
        selected: [pr_gate_answer],
      };
    }
    if (action.options && action.options.length > 0) {
      return {
        kind: "user_answer",
        question_id: action.question_id,
        selected: [action.options[0].label],
      };
    }
    return {
      kind: "user_answer",
      question_id: action.question_id,
      selected: [],
      freeform: freeform_answer,
    };
  }

  function craftPipelineToolResult(
    action: Extract<NextAction, { kind: "call_pipeline_tool" }>,
  ): ActionResult {
    if (action.tool_name === "index_codebase") {
      return {
        kind: "tool_result",
        correlation_id: action.correlation_id,
        success: true,
        data: {
          graph_path,
          symbols_indexed: 0,
          files_parsed: 0,
          duration_ms: 1,
        },
      };
    }
    if (action.tool_name === "analyze_codebase") {
      // Stage 3 all-in-one (index + resolve + cluster). input-analysis.ts
      // emits this instead of bare index_codebase so prepare_prd_input sees
      // a resolved+clustered graph (bare index_codebase yields
      // impacted_community_count=0 / impacted_process_count=0 — see
      // input-analysis.ts module doc). Canned response mirrors the live
      // binary's do_analyze_codebase shape (graph_path + index/resolve/
      // cluster substats); tests only assert on graph_path today.
      return {
        kind: "tool_result",
        correlation_id: action.correlation_id,
        success: true,
        data: {
          graph_path,
          index: { node_count: 0, edge_count: 0, files_indexed: 0 },
          resolve: {},
          cluster: { community_count: 0, process_count: 0, modularity: 0 },
        },
      };
    }
    if (action.tool_name === "detect_changes") {
      // post-impl-verification.ts call 2 (PR 3c). Shape mirrors the live AP
      // do_detect_changes envelope (main.rs:3406) — tests assert on
      // symbols_affected[].qualified_name, which post-impl-verification.ts
      // extracts into post_specs.verification.changed_symbols.
      return {
        kind: "tool_result",
        correlation_id: action.correlation_id,
        success: true,
        data: {
          files_changed: [],
          symbols_affected: [],
          symbols_affected_count: 0,
          communities_affected: [],
          processes_affected: [],
          risk_score: "0.0000",
        },
      };
    }
    if (action.tool_name === "verify_semantic_diff") {
      // post-impl-verification.ts call 3 (PR 3c). Shape mirrors the live AP
      // regression-report envelope (tool_schemas.rs:671); tests only assert
      // it is stored opaquely.
      return {
        kind: "tool_result",
        correlation_id: action.correlation_id,
        success: true,
        data: { regression_score: 0.0, status: "clean" },
      };
    }
    if (action.tool_name === "check_security_gates") {
      // post-impl-verification.ts call 4 (PR 3c). Shape mirrors the live AP
      // SecurityReport envelope (security_gates.rs:42, main.rs:3788) —
      // tests assert on gates_passed, which post-impl-verification.ts
      // extracts into post_specs.verification.gates_passed.
      return {
        kind: "tool_result",
        correlation_id: action.correlation_id,
        success: true,
        data: { gates_passed: true, flags: [] },
      };
    }
    if (action.tool_name === "get_impact") {
      // pre_impl_grounding.ts's per-symbol blast-radius query (PR 3b). Shape
      // mirrors the live AP get_impact response envelope (callers/importers/
      // users/implementors handles) — tests only assert on qualified_name /
      // success, so a minimal but well-formed payload is sufficient here.
      return {
        kind: "tool_result",
        correlation_id: action.correlation_id,
        success: true,
        data: {
          qualified_name: action.arguments.qualified_name,
          callers: [],
          importers: [],
          users: [],
          implementors: [],
        },
      };
    }
    return {
      kind: "tool_result",
      correlation_id: action.correlation_id,
      success: true,
      data: {},
    };
  }

  function craftCortexToolResult(
    action: Extract<NextAction, { kind: "call_cortex_tool" }>,
  ): ActionResult {
    if (action.tool_name === "recall") {
      return {
        kind: "tool_result",
        correlation_id: action.correlation_id,
        success: true,
        data: { results: [], total: 0 },
      };
    }
    return {
      kind: "tool_result",
      correlation_id: action.correlation_id,
      success: true,
      data: {},
    };
  }

  function craftSubagentBatchResult(
    action: Extract<NextAction, { kind: "spawn_subagents" }>,
  ): ActionResult {
    const responses = action.invocations.map((inv) => ({
      invocation_id: inv.invocation_id,
      raw_text: pickFakeAgentResponse(inv.invocation_id, inv.prompt),
    }));
    return {
      kind: "subagent_batch_result",
      batch_id: action.batch_id,
      responses,
    };
  }

  function craftFileWritten(
    action: Extract<NextAction, { kind: "write_file" }>,
  ): ActionResult {
    return {
      kind: "file_written",
      path: action.path,
      bytes: Buffer.byteLength(action.content, "utf8"),
    };
  }

  return function dispatch(action: NextAction): ActionResult | undefined {
    switch (action.kind) {
      case "ask_user":
        return craftUserAnswer(action);
      case "call_pipeline_tool":
        return craftPipelineToolResult(action);
      case "call_cortex_tool":
        return craftCortexToolResult(action);
      case "spawn_subagents":
        return craftSubagentBatchResult(action);
      case "write_file":
        return craftFileWritten(action);
      case "done":
      case "failed":
        return undefined;
      default: {
        const _exhaustive: never = action;
        throw new Error(
          `cannedDispatcher: unhandled action.kind=${(_exhaustive as NextAction).kind}. ` +
            `Add a case to the dispatch switch.`,
        );
      }
    }
  };
}
