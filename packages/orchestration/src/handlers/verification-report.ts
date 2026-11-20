/**
 * Verification-report export — builds `10-verification-report.md` from
 * `state.pending_completion` (self-check's finalize() output). Extracted
 * from file-export.ts (§4.1 500-line file cap): file-export.ts owns the
 * file-WRITING protocol (what files exist, when they're written, skip
 * reasons); this module owns rendering ONE derived report from state that
 * is already fully computed — a distinct concern (Move 5).
 */

import type { PipelineState } from "../types/state.js";
import type { AgentIdentity } from "@prd-gen/core";
import { SECTION_DISPLAY_NAMES } from "@prd-gen/core";
import type { PrdFile } from "./file-export.js";
import { evaluateRunPolicy, resolveVerificationPolicy } from "./verification-policy.js";

const VERIFICATION_REPORT_FILENAME = "10-verification-report.md";

/**
 * Escape one GFM table cell so untrusted text cannot break out of it.
 *
 * Judge rationales are LLM-generated (§13.1 D2: treat as untrusted), so a
 * cell must survive three shapes that a naive `.replace(/\|/g, "\\|")` lets
 * through:
 *
 *   1. `a\|b`   — escaping the pipe WITHOUT first escaping the backslash
 *                 yields `a\\|b`, which GFM renders as a literal backslash
 *                 followed by an *unescaped* delimiter → column injection.
 *                 Order matters: backslash first, then pipe.
 *   2. newlines — a raw `\n` terminates the table row → row injection.
 *                 Rendered as `<br>`, the GFM-sanctioned in-cell line break.
 *   3. `\r`     — CRLF input would otherwise leave a stray CR in the cell.
 *
 * postcondition: the result contains no unescaped `|` and no line terminator,
 *   so it always occupies exactly one cell of one row.
 *
 * source: GitHub Flavored Markdown spec §4.10 (tables) — "include a pipe in a
 *   cell's content by escaping it, including inside other inline spans".
 * source: CodeQL js/incomplete-sanitization (backslash must be escaped first).
 */
function escapeTableCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

/**
 * precondition:  `state.written_files` contains at least one exported file
 *                (file_export has run) whose path ends in the 01-prd.md
 *                slug so the report lands in the same run directory.
 * postcondition: returns null when `state.written_files` is empty (no run
 *                directory can be derived); otherwise the directory prefix
 *                shared by every exported PRD file.
 */
function runDirFromWrittenFiles(state: PipelineState): string | null {
  const prd = state.written_files.find((p) => /(^|\/)01-prd\.md$/.test(p));
  if (!prd) return null;
  return prd.slice(0, prd.length - "/01-prd.md".length);
}

function renderSectionsSummary(state: PipelineState): string {
  if (state.sections.length === 0) return "_No sections were tracked for this run._";
  return state.sections
    .map((s) => {
      const violations =
        s.last_violations.length > 0
          ? `\n  Violations (last attempt): ${s.last_violations.join("; ")}`
          : "";
      return `- **${SECTION_DISPLAY_NAMES[s.section_type] ?? s.section_type}**: ${s.status} (attempt ${s.attempt}, ${s.violation_count} violation(s) recorded)${violations}`;
    })
    .join("\n");
}

function renderDistribution(
  verification: NonNullable<PipelineState["pending_completion"]>["verification"],
): string {
  if (!verification) {
    return "_No multi-judge verification ran for this document (zero-claim short-circuit or malformed input)._";
  }
  const dist = Object.entries(verification.distribution)
    .map(([verdict, count]) => `  - ${verdict}: ${count}`)
    .join("\n");
  return [
    `Claims evaluated: ${verification.claims_evaluated}`,
    dist,
    verification.distribution_suspicious
      ? "⚠ Distribution suspicious — 100% PASS suggests confirmatory bias."
      : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * `JudgeVerdict.judge` is a structured `AgentIdentity` (`{kind, name}`), not
 * a string — rendering it with template-literal coercion produces
 * "[object Object]" in the markdown table. `kind:name` (e.g.
 * "genius:dijkstra", "rule:rule-tier") is a readable, unambiguous identity
 * string; matches the `${kind}:${name}` shape `agentSubagentType`
 * (core/domain/agent.ts) builds on before prefixing the host tool-name
 * convention.
 */
function renderJudgeIdentity(judge: AgentIdentity): string {
  return `${judge.kind}:${judge.name}`;
}

/**
 * Per-claim judge verdicts. `judge_verdicts` is an OPTIONAL contract field
 * (see actions.ts VerificationSummarySchema doc). self-check.ts's finalize()
 * populates it whenever at least one judge verdict was produced (including
 * rule-tier mechanical verdicts — claim-tier.ts); it is omitted for the
 * genuinely-absent case — zero claims extracted at all. Rather than
 * fabricate per-claim data that does not exist in state, this renders an
 * explicit, honest gap notice when the field is absent (zetetic §8: no
 * source, no invented content) and a verbatim table when it IS present.
 */
function renderJudgeVerdicts(
  verification: NonNullable<PipelineState["pending_completion"]>["verification"],
): string {
  const verdicts = verification?.judge_verdicts;
  if (!verdicts || verdicts.length === 0) {
    return (
      "_Per-claim judge verdicts are not present in this run's state — " +
      "multi-judge verification did not run (zero-claim short-circuit) or was " +
      "explicitly skipped at the budget gate (see actions.ts " +
      "VerificationSummarySchema.judge_verdicts). No per-claim data is " +
      "fabricated here._"
    );
  }
  const header = "| Claim ID | Judge | Model | Verdict | Confidence | Rationale |";
  const sep = "|---|---|---|---|---|---|";
  const rows = verdicts.map(
    (v) =>
      `| ${escapeTableCell(v.claim_id)} | ${escapeTableCell(renderJudgeIdentity(v.judge))} | ${escapeTableCell(v.model ?? "—")} | ${escapeTableCell(v.verdict)} | ${v.confidence.toFixed(2)} | ${escapeTableCell(v.rationale)} |`,
  );
  return [header, sep, ...rows].join("\n");
}

/**
 * Cross-model agreement summary — how many SUBJECTIVE claims (rule-tier
 * mechanical verdicts excluded; they were never model-dispatched) were
 * judged by more than one distinct model vs a single model only. A claim
 * with >1 distinct `model` among its verdicts crossed a model boundary —
 * only "architecture"-typed claims can, by construction, since
 * self-check-verify-budget.ts's assignJudgeModels only cycles
 * `diversity_models` for that claim_type (see VerifyBudgetConfigSchema
 * .diversity_models doc for the monoculture-mitigation rationale and its
 * honest limit: cross-model here still means cross-Claude-family by
 * default, not cross-vendor).
 */
function renderModelAgreementSummary(
  verification: NonNullable<PipelineState["pending_completion"]>["verification"],
): string {
  const verdicts = verification?.judge_verdicts;
  if (!verdicts || verdicts.length === 0) {
    return "_No per-claim judge verdicts available to compute model agreement._";
  }
  const modelsByClaim = new Map<string, Set<string>>();
  for (const v of verdicts) {
    if (v.judge.kind === "rule" || !v.model) continue; // mechanical-tier: not model-dispatched
    const set = modelsByClaim.get(v.claim_id) ?? new Set<string>();
    set.add(v.model);
    modelsByClaim.set(v.claim_id, set);
  }
  if (modelsByClaim.size === 0) {
    return "_No subjective (model-dispatched) claims in this run's judge_verdicts._";
  }
  let crossModel = 0;
  let singleModel = 0;
  for (const models of modelsByClaim.values()) {
    if (models.size > 1) crossModel += 1;
    else singleModel += 1;
  }
  return [
    `Subjective claims with cross-model judge agreement: ${crossModel}`,
    `Subjective claims judged by a single model only: ${singleModel}`,
  ].join("\n");
}

function renderGraphValidation(
  verification: NonNullable<PipelineState["pending_completion"]>["verification"],
): string {
  const report = verification?.prd_graph_validation;
  if (!report) {
    return "_No PRD-vs-graph validation ran for this run (no codebase graph was available)._";
  }
  return ["```json", JSON.stringify(report, null, 2), "```"].join("\n");
}

/**
 * The gap this section closes (2026-07-15, e2e run run_mrlqa0aj_u2rh15): a
 * FAIL verdict and a reduced-jury sampling gap were both present in the
 * distribution above, yet nothing in the pipeline stated whether that was
 * acceptable — the human had to notice it themselves. This section always
 * names the policy IN FORCE, the COMPUTED verdict, and the recorded human
 * decision (or "awaiting gate answer" pre-decision), so the gap and its
 * closure are both artifacts of record, not something a reader has to infer
 * from the distribution counts above.
 *
 * precondition:  none — `state.pending_completion` may be absent (handled
 *                by the caller's null-return before this is reached in
 *                practice, but this function itself is total).
 * postcondition: pure function of `state.verification_policy`,
 *                `state.pending_completion?.verification`, and
 *                `state.post_specs?.decision`/`policy_derogation`.
 */
function renderPolicySection(state: PipelineState): string {
  const policy = resolveVerificationPolicy(state.verification_policy);
  const verdict = evaluateRunPolicy(state);

  const policyLine =
    `Policy in force: block_on=[${policy.block_on.join(", ")}], ` +
    `min_subjective_sampled_ratio=${(policy.min_subjective_sampled_ratio * 100).toFixed(0)}%, ` +
    `on_unsampled_below_ratio=${policy.on_unsampled_below_ratio}, ` +
    `on_cross_model_disagreement=${policy.on_cross_model_disagreement}`;

  const findingsLine =
    verdict.reasons.length > 0
      ? `Findings: ${verdict.reasons.join(" ")}`
      : "Findings: none — no claim triggered block_on, ratio, or disagreement gates.";

  const decision = state.post_specs?.decision ?? "pending";
  const derogation = state.post_specs?.policy_derogation;
  let decisionLine: string;
  if (decision === "pending") {
    decisionLine = "Human decision: pending (gate not yet answered).";
  } else if (derogation) {
    decisionLine = `Human decision: ${decision} — derogation granted by user at gate (policy status was "${derogation.policy_status}").`;
  } else if (decision === "implement") {
    decisionLine = "Human decision: implement (policy status was \"pass\" — no derogation required).";
  } else {
    decisionLine = "Human decision: prd_only (no derogation — implementation not selected).";
  }

  return [
    `**Computed status: ${verdict.status}**`,
    "",
    policyLine,
    findingsLine,
    decisionLine,
  ].join("\n");
}

/**
 * precondition:  `state.pending_completion !== null` (self-check's
 *                finalize() has run).
 * postcondition: returns the 10-verification-report.md PrdFile with section
 *                statuses+violations, the verification distribution,
 *                per-claim judge verdicts (verbatim when present, an
 *                honest gap notice otherwise), cross-model agreement, and
 *                prd_graph_validation findings; returns null when no run
 *                directory can be derived (file_export never wrote
 *                01-prd.md) or pending_completion is absent — degrades
 *                gracefully rather than blocking the pipeline on a missing
 *                report.
 */
export function buildVerificationReportFile(state: PipelineState): PrdFile | null {
  const pending = state.pending_completion;
  if (!pending) return null;
  const dir = runDirFromWrittenFiles(state);
  if (!dir) return null;

  return {
    path: `${dir}/${VERIFICATION_REPORT_FILENAME}`,
    content: () =>
      [
        `# Verification Report: ${state.feature_description}`,
        "",
        `Run ID: ${state.run_id}`,
        "",
        "## Verification Policy",
        "",
        renderPolicySection(state),
        "",
        "## Section Statuses & Violations",
        "",
        renderSectionsSummary(state),
        "",
        "## Multi-Judge Verification Distribution",
        "",
        renderDistribution(pending.verification),
        "",
        "## Per-Claim Judge Verdicts",
        "",
        renderJudgeVerdicts(pending.verification),
        "",
        "## Cross-Model Agreement",
        "",
        renderModelAgreementSummary(pending.verification),
        "",
        "## PRD-vs-Graph Validation",
        "",
        renderGraphValidation(pending.verification),
      ].join("\n"),
  };
}

/** Filename constant re-exported for callers that need to test for presence. */
export { VERIFICATION_REPORT_FILENAME };
