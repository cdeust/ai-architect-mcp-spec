import { z } from "zod";

export const PipelineStepSchema = z.enum([
  "banner",
  "preflight",
  "context_detection",
  "input_analysis",
  "feasibility_gate",
  "clarification",
  "budget",
  "section_generation",
  "jira_generation",
  "file_export",
  "self_check",
  /**
   * Post-specs implementation loop (design-phases-3-5.md, PR 3b).
   * `self_check`'s finalize() now advances here instead of emitting
   * `remember`/`done` directly — see finalize.ts, now the sole step that
   * reaches `complete`.
   */
  "implementation_gate",
  "pre_impl_grounding",
  /**
   * `implementation` (PR 4a, design-phases-3-5.md §3): one `spawn_subagents`
   * (purpose "implement", subagent_type "engineer", isolation "worktree")
   * that hands the validated specs + pre-impl grounding to an engineer
   * subagent. `pre_impl_grounding` always transitions here once its
   * (optional) grounding loop settles — grounding is best-effort context for
   * the engineer, not a gate on reaching implementation. On success,
   * advances to `post_impl_verification`; on subagent error or an
   * unparseable report, aborts straight to `finalize` (design §4 —
   * "nothing to verify without code").
   */
  "implementation",
  /**
   * `post_impl_verification` (PR 3c wiring, PR 4a reachability,
   * design-phases-3-5.md §1, §3, §5): the 4-call POST-implementation
   * verification sequence (index_codebase(worktree) → detect_changes →
   * verify_semantic_diff → check_security_gates). Reached from
   * `implementation` once the engineer's report is parsed successfully.
   * Always advances to `testing` (PR 4b) once the sequence settles —
   * success and degrade both continue; there is nothing left to verify
   * once all 4 calls have run or degraded.
   */
  "post_impl_verification",
  /**
   * `testing` (PR 4b, design-phases-3-5.md §3): one `spawn_subagents`
   * (purpose "test", subagent_type "test-engineer", isolation "none" — SAME
   * branch/worktree `implementation` recorded, no second worktree). A
   * test-engineer failure DEGRADES (surfaced to `review` as a finding, not
   * an abort — design §4). Always advances to `review`.
   */
  "testing",
  /**
   * `review` (PR 4b, design-phases-3-5.md §3): one `spawn_subagents`
   * (purpose "review", subagent_type "code-reviewer") fed the verification +
   * testing verdicts. A parsed FAIL verdict retries `implementation` on the
   * SAME worktree with the findings injected into the prompt, bounded by
   * `REVIEW_RETRY_CAP` (review.ts). PASS, or cap exhaustion (degrade to
   * advisory FAIL), advances to `pr_gate` (PR 5 — replaces the PR-4b
   * dead-end to `finalize`).
   */
  "review",
  /**
   * `pr_gate` (PR 5, design-phases-3-5.md §3): the trust-seam human gate —
   * `ask_user` ("Push + open PR" / "No"), MANDATORY and non-skippable,
   * always fires when reached regardless of the `review` verdict (including
   * an advisory FAIL). "No" is a valid TERMINAL path (not a failure):
   * advances straight to `finalize` with `post_specs.pr = {pushed:false,
   * url:null}`. "Push + open PR" advances to `pr_creation`.
   */
  "pr_gate",
  /**
   * `pr_creation` (PR 5, design-phases-3-5.md §3): one `spawn_subagents`
   * (purpose "pr", subagent_type "engineer", isolation "none" — SAME
   * branch/worktree as `implementation`) instructing the engineer to push
   * the branch and open a pull request, returning the PR URL via a
   * machine-readable `PR_URL:` footer. Push/`gh` failure or a missing
   * footer DEGRADES (`appendError("upstream_failure")`,
   * `post_specs.pr.pushed = false`) — `finalize` is still reached, never a
   * hard abort.
   */
  "pr_creation",
  /**
   * Relocated Phase C (Cortex `remember` → `done`) — the only step that
   * advances `current_step` to `complete`. `implementation_gate`
   * ("prd_only") and every failure/degrade/terminal path in
   * `pre_impl_grounding` / `implementation` / `post_impl_verification` /
   * `testing` / `review` / `pr_gate` / `pr_creation` dead-ends here.
   */
  "finalize",
  "complete",
]);
export type PipelineStep = z.infer<typeof PipelineStepSchema>;
