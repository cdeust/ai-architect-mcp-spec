/**
 * NextAction — the contract between the runner and the host.
 *
 * The runner is a stateless reducer. It cannot itself call MCP tools,
 * spawn subagents, or interact with users. Instead it returns a NextAction
 * envelope describing what the host must do, and waits for an ActionResult
 * to be fed back via the next `step()` call.
 *
 * Two surfaces are exported:
 *
 *   - HandlerActionSchema: what a HANDLER may return (includes emit_message,
 *     which is a request to the runner to coalesce a status message and
 *     re-enter the dispatch).
 *   - NextActionSchema: what STEP() returns to the host (excludes
 *     emit_message — those are coalesced into StepOutput.messages).
 *
 * Discriminated by `kind`. Add a new kind if and only if a step needs an
 * action that no existing kind covers.
 */

import { z } from "zod";
// PRDContextSchema / SectionTypeSchema are deliberately NOT imported here.
// The action envelope is transport-generic (opaque `arguments` records +
// correlation ids); PRD context and section type are typed where they are
// actually carried — state/core-state.ts (prd_context), state/section-status.ts
// (section_type) — and parsed at handlers/context-detection.ts.
import { VerdictSchema, JudgeVerdictSchema } from "@prd-gen/core";

// ─── Action 1: ask_user ─────────────────────────────────────────────────────

export const AskUserActionSchema = z.object({
  kind: z.literal("ask_user"),
  /** Identifies the question so the host can map answer → state */
  question_id: z.string(),
  header: z.string().describe("Short prompt header for AskUserQuestion tool"),
  description: z.string().describe("Body explaining what we need from the user"),
  options: z
    .array(
      z.object({
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .min(2)
    .max(4)
    .nullable()
    .describe("Structured options for AskUserQuestion. Null = freeform answer."),
  multi_select: z.boolean().default(false),
});
export type AskUserAction = z.infer<typeof AskUserActionSchema>;

// ─── Action 2: call_pipeline_tool ───────────────────────────────────────────

export const CallPipelineToolActionSchema = z.object({
  kind: z.literal("call_pipeline_tool"),
  tool_name: z.string().describe("ai-architect-mcp-codebase MCP tool name"),
  arguments: z.record(z.string(), z.unknown()),
  /** Opaque routing token — host echoes it back unchanged on the corresponding tool_result. */
  correlation_id: z.string(),
});
export type CallPipelineToolAction = z.infer<typeof CallPipelineToolActionSchema>;

// ─── Action 3: call_cortex_tool ─────────────────────────────────────────────

export const CallCortexToolActionSchema = z.object({
  kind: z.literal("call_cortex_tool"),
  tool_name: z.string().describe("Cortex MCP tool name"),
  arguments: z.record(z.string(), z.unknown()),
  /** Opaque routing token — host echoes it back unchanged on the corresponding tool_result. */
  correlation_id: z.string(),
});
export type CallCortexToolAction = z.infer<typeof CallCortexToolActionSchema>;

// ─── Action 4: spawn_subagents ──────────────────────────────────────────────

export const SpawnSubagentsActionSchema = z.object({
  kind: z.literal("spawn_subagents"),
  /** Multiple invocations to run IN PARALLEL — host MUST issue them in one message */
  invocations: z.array(
    z.object({
      invocation_id: z.string(),
      subagent_type: z.string(),
      description: z.string(),
      prompt: z.string(),
      isolation: z.enum(["worktree", "none"]).default("none"),
      /**
       * Model the host SHOULD dispatch this invocation under. Optional and
       * additive — a host that does not read this field falls back to its
       * own default (typically the session model), so every producer that
       * omits it is unaffected (backward-compatible). self-check.ts sets
       * this on every judge invocation (default "haiku" — judging is
       * read-and-compare work, not frontier reasoning; see
       * types/state/verify-budget.ts).
       */
      model: z.string().optional(),
      /**
       * Extended-thinking effort the host SHOULD dispatch this invocation
       * under. Optional and additive for the same reason as `model`.
       */
      effort: z.enum(["low", "medium", "high"]).optional(),
    }),
  ),
  /** Identifies the batch so the runner can route the batch result on submission. */
  batch_id: z.string(),
  /**
   * Observability label only — host dispatch logic MUST NOT branch on this
   * field. It exists so logs and telemetry can attribute batches to a high-
   * level intent (judging vs drafting vs reviewing vs implementing).
   *
   * "implement" added additively (design-phases-3-5.md §3, PR 4a) for the
   * `implementation` step's engineer spawn — no existing purpose value was
   * removed or repurposed, so every prior batch's observability label is
   * unaffected. "test" added additively (design-phases-3-5.md §3, PR 4b) for
   * the `testing` step's test-engineer spawn — "review" already existed
   * (unused until PR 4b's `review` step wires it) so no addition was needed
   * there. "pr" added additively (design-phases-3-5.md §3, PR 5) for the
   * `pr_creation` step's engineer spawn (branch push + `gh pr create`) — no
   * existing purpose value was removed or repurposed.
   */
  purpose: z.enum(["judge", "draft", "review", "implement", "test", "pr"]),
});
export type SpawnSubagentsAction = z.infer<typeof SpawnSubagentsActionSchema>;

// ─── Action 5: write_file ───────────────────────────────────────────────────

export const WriteFileActionSchema = z.object({
  kind: z.literal("write_file"),
  path: z.string(),
  content: z.string(),
});
export type WriteFileAction = z.infer<typeof WriteFileActionSchema>;

// ─── Action 6: emit_message ─────────────────────────────────────────────────

/** Display a message to the user (e.g., banner, summary). No reply expected. */
/**
 * `emit_message` is a HANDLER-only action. The runner coalesces these into
 * StepOutput.messages and never returns one as the host-facing action.
 * `level` defaults to "info" if a handler omits it — enforced by the schema
 * so the runtime is not the only line of defense.
 */
export const EmitMessageActionSchema = z.object({
  kind: z.literal("emit_message"),
  message: z.string(),
  level: z.enum(["info", "warn", "error"]).default("info"),
});
export type EmitMessageAction = z.infer<typeof EmitMessageActionSchema>;

// ─── Action 7: done ─────────────────────────────────────────────────────────

/**
 * Typed verification summary attached to the `done` action.
 *
 * source: cross-audit consensus (popper C1, feynman H2, curie C-2, dijkstra
 * C2, shannon S3, test-engineer C3 — Phase 3+4 cross-audit, 2026-04). The
 * previous design encoded these counts in the prose `summary` string; KPI
 * extractors regex-parsed them with a "KNOWN BRITTLENESS" caveat. Any
 * whitespace change in the producer silently zeroed every downstream metric
 * and survived all mutation tests. Typed fields close the gap.
 *
 * Invariants:
 *   - claims_evaluated = sum(distribution.values())
 *   - claims_evaluated >= 0; every distribution[v] >= 0
 *   - distribution_suspicious is a derived flag based on PASS-rate +
 *     minimum cluster size; see verification/orchestrator.ts:concludeFromVerdicts.
 */
export const VerificationSummarySchema = z.object({
  claims_evaluated: z.number().int().nonnegative(),
  distribution: z.record(VerdictSchema, z.number().int().nonnegative()),
  distribution_suspicious: z.boolean(),
  /**
   * PRD-vs-graph validation report from ai-architect-mcp-codebase
   * `validate_prd_against_graph`, attached when the run had a code graph.
   * Symbol-hallucination / community-consistency / process-impact findings.
   * Opaque object — the orchestration layer is a passthrough and does not parse
   * the AP payload. Absent when no codebase was provided (preserves the prior
   * verification shape for non-codebase runs).
   *
   * source: AP validate_prd_against_graph contract (shipped 2026-06). Attached
   * here (not as a new top-level done field) so KPI/test consumers read one
   * typed verification surface.
   */
  prd_graph_validation: z.record(z.string(), z.unknown()).optional(),
  /**
   * Per-claim judge verdicts (judge identity, verdict, rationale, caveats,
   * confidence) — the raw JudgeVerdict[] self-check's Phase B parses before
   * folding them into `distribution`. Optional CONTRACT field: self-check.ts
   * (owned separately — see file-export.ts's verification-report module doc)
   * currently discards this array after computing `distribution`; it is
   * declared here so a future self-check change can attach it losslessly and
   * file-export's 10-verification-report.md renders it verbatim the moment
   * it is populated. Absent (undefined) means "not wired yet, or this run's
   * `done` predates the field" — consumers MUST treat absence as "unknown",
   * never as "zero verdicts" (that is `claims_evaluated === 0`, a distinct
   * fact already carried above).
   *
   * source: e2e run_mrlqa0aj_u2rh15 (2026-07-15) — self-check's finalize()
   * (self-check.ts) computes JudgeVerdict[] via parseVerdicts/
   * parseVerdictsFromSnapshot but only forwards concludeDocument's
   * DISTRIBUTION counts to pending_completion.verification; the per-claim
   * array itself is never exported to a file or surfaced to the user.
   */
  judge_verdicts: z.array(JudgeVerdictSchema).optional(),
  /**
   * Total number of SUBJECTIVE-tier claims (claim-tier.ts) extracted for
   * this run, BEFORE any budget-driven reduction/sampling
   * (self-check-verify-budget.ts `reduceJudgeRequests`/`sampleWithinCap`).
   * Distinct from `claims_evaluated` (which counts only claims that
   * actually RECEIVED a verdict): `sampleWithinCap` can drop a subjective
   * claim entirely when the judge-panel budget is exceeded, leaving it with
   * NO verdict at all — that claim is still counted here, but absent from
   * `judge_verdicts`. `handlers/verification-policy.ts`'s
   * `min_subjective_sampled_ratio` gate needs both numbers to distinguish
   * "sampled and judged" from "never dispatched at all" for a subjective
   * claim. Mechanical-tier claims (claim-tier.ts) are excluded — they are
   * rule-verdicted deterministically and never subject to sampling, so they
   * can never be "unsampled". Defaults to 0 (mechanical-only or zero-claim
   * documents, and any `done` predating this field).
   *
   * source: e2e run run_mrlqa0aj_u2rh15 (2026-07-15); design-phases-3-5.md §7.
   */
  total_subjective_claims: z.number().int().nonnegative().default(0),
});
export type VerificationSummary = z.infer<typeof VerificationSummarySchema>;

/**
 * What the finished run's deliverables are worth, so a terminal `done` never
 * reads as a success when the self-check found the PRD unusable (issue #122:
 * an audited run showed a hard-output score of 0.00 next to `done`).
 *
 * `kind: "done"` means the pipeline reached its end; `outcome.status` says
 * whether its output can be trusted as is. "needs_attention" is set by
 * self_check's finalize() when at least one section failed validation, the
 * deterministic checks reported a critical violation, or the hard-output
 * score is at its floor of 0 (penalties saturated). `reasons` names each
 * fact, in that order, and is empty exactly when `status` is "passed".
 *
 * source: issue #122 (independent audit of v0.8.0, 2026-10-10).
 */
export const DoneOutcomeSchema = z.object({
  status: z.enum(["passed", "needs_attention"]),
  reasons: z.array(z.string()),
});
export type DoneOutcome = z.infer<typeof DoneOutcomeSchema>;

export const DoneActionSchema = z.object({
  kind: z.literal("done"),
  summary: z.string(),
  artifacts: z.array(z.string()).default([]),
  /**
   * Quality verdict on the run's deliverables (DoneOutcomeSchema). Present
   * on every `done` that went through self_check; absent on the `done`
   * emissions that did not (replay of an already complete run, a runner
   * fallback built from messages only).
   */
  outcome: DoneOutcomeSchema.optional(),
  /**
   * Typed verification summary. Optional only because not every `done`
   * emission has run the judge phase (zero-claim short-circuit, malformed
   * input, etc.). When present, KPI extractors and tests MUST read this
   * field — never regex-parse `summary`.
   */
  verification: VerificationSummarySchema.optional(),
});
export type DoneAction = z.infer<typeof DoneActionSchema>;

// ─── Action 8: failed ───────────────────────────────────────────────────────

export const FailedActionSchema = z.object({
  kind: z.literal("failed"),
  reason: z.string(),
  step: z.string(),
});
export type FailedAction = z.infer<typeof FailedActionSchema>;

// ─── Union ──────────────────────────────────────────────────────────────────

/**
 * HandlerAction — what a HANDLER may return from `invoke()`. Includes
 * `emit_message`; the runner consumes these and never lets them escape.
 *
 * Uses `z.input` so handlers can omit fields with schema-level defaults
 * (e.g. `emit_message.level`); Zod normalizes them to the output type at
 * runtime. The runner re-types the action against the parsed shape on use.
 */
export const HandlerActionSchema = z.discriminatedUnion("kind", [
  AskUserActionSchema,
  CallPipelineToolActionSchema,
  CallCortexToolActionSchema,
  SpawnSubagentsActionSchema,
  WriteFileActionSchema,
  EmitMessageActionSchema,
  DoneActionSchema,
  FailedActionSchema,
]);
export type HandlerAction = z.input<typeof HandlerActionSchema>;

/**
 * NextAction — what `step()` returns to the host. The runner guarantees
 * `kind !== "emit_message"`; those are coalesced into StepOutput.messages.
 * Hosts pattern-matching on `action.kind` therefore never need to handle
 * `emit_message` — the type system makes the case unreachable.
 */
export const NextActionSchema = z.discriminatedUnion("kind", [
  AskUserActionSchema,
  CallPipelineToolActionSchema,
  CallCortexToolActionSchema,
  SpawnSubagentsActionSchema,
  WriteFileActionSchema,
  DoneActionSchema,
  FailedActionSchema,
]);
export type NextAction = z.infer<typeof NextActionSchema>;

// ─── ActionResult — fed back into the reducer ───────────────────────────────

export const UserAnswerSchema = z.object({
  kind: z.literal("user_answer"),
  question_id: z.string(),
  selected: z.array(z.string()).default([]),
  freeform: z.string().optional(),
});
export type UserAnswer = z.infer<typeof UserAnswerSchema>;

export const ToolResultSchema = z.object({
  kind: z.literal("tool_result"),
  correlation_id: z.string(),
  success: z.boolean(),
  data: z.unknown(),
  error: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const SubagentBatchResultSchema = z.object({
  kind: z.literal("subagent_batch_result"),
  batch_id: z.string(),
  responses: z.array(
    z.object({
      invocation_id: z.string(),
      raw_text: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});
export type SubagentBatchResult = z.infer<typeof SubagentBatchResultSchema>;

export const FileWrittenSchema = z.object({
  kind: z.literal("file_written"),
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type FileWritten = z.infer<typeof FileWrittenSchema>;

export const ActionResultSchema = z.discriminatedUnion("kind", [
  UserAnswerSchema,
  ToolResultSchema,
  SubagentBatchResultSchema,
  FileWrittenSchema,
]);
export type ActionResult = z.infer<typeof ActionResultSchema>;

