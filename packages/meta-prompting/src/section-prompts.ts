/**
 * Section drafting prompts.
 *
 * Per-section-type templates that produce a self-contained prompt for the
 * engineer subagent. Each builder takes:
 *   - feature description
 *   - PRD context type
 *   - recall summary (Cortex)
 *   - clarification answers
 *   - prior violations (for retry)
 *
 * Output: a single string the host hands to the Agent tool.
 *
 * The hard-output rules baked into each prompt mirror SKILL.md so the draft
 * has a chance of passing validation on the first attempt.
 */

import {
  SECTION_DISPLAY_NAMES,
  PRD_CONTEXT_CONFIGS,
  AFFECTED_SYMBOLS_MARKER,
  type PRDContext,
  type SectionType,
} from "@prd-gen/core";
import type { StrategyAssignment } from "@prd-gen/strategy";

/**
 * One symbol matched against the codebase graph by ai-architect-mcp-codebase's
 * feature-mode `prepare_prd_input`. Only the fields the rendered grounding
 * block consumes are typed; the AP payload may carry more (relationships,
 * processes), which this builder deliberately does not render to keep the
 * prompt token-bounded.
 *
 * source: AP feature-mode prepare_prd_input contract (prd_context shape),
 * shipped 2026-06.
 */
export interface GroundedSymbol {
  readonly qualified_name?: string;
  readonly name?: string;
  readonly label?: string;
  readonly file_path?: string;
  readonly community_id?: string | number;
}

/**
 * Code-graph grounding for the feature (AP `prepare_prd_input.prd_context`).
 * Every field is optional so a partial / older payload still type-checks; the
 * renderer guards each field independently and emits NOTHING when the grounding
 * carries no usable evidence (backward-compatible with pre-grounding callers).
 *
 * source: AP feature-mode prepare_prd_input contract (prd_context shape),
 * shipped 2026-06.
 */
export interface CodebaseGrounding {
  readonly finding_summary?: string;
  readonly matched_symbols?: ReadonlyArray<GroundedSymbol>;
  readonly impacted_communities?: readonly string[];
  readonly impacted_processes?: readonly string[];
  readonly graph_stats?: {
    readonly nodes?: number;
    readonly edges?: number;
    readonly communities?: number;
    readonly processes?: number;
  };
}

export interface SectionPromptInput {
  readonly section_type: SectionType;
  readonly feature_description: string;
  readonly prd_context: PRDContext;
  readonly recall_summary: string;
  readonly clarification_qa: ReadonlyArray<{ question: string; answer: string }>;
  readonly prior_violations: readonly string[];
  readonly attempt: number;
  /**
   * Research-evidence-backed strategy assignment chosen by `@prd-gen/strategy`.
   * Optional because legacy callers may construct prompts without it; when
   * present, the rendered prompt includes a `<strategies>` block telling the
   * engineer subagent which reasoning patterns to apply (and avoid).
   *
   * source: Phase 4 strategy-wiring (2026-04).
   */
  readonly strategy_assignment?: StrategyAssignment;
  /**
   * Code-graph grounding for the feature, produced by ai-architect-mcp-codebase's
   * feature-mode `prepare_prd_input` (its `prd_context` payload) and threaded
   * through from `PipelineState.codebase_grounding`. When present and non-empty,
   * the rendered prompt gains a `<codebase_grounding>` block listing real
   * matched symbols / files / communities / processes so the drafted section
   * references the actual codebase rather than inventing structure.
   *
   * Optional: pipelines without a codebase (or predating grounding) omit it,
   * and the rendered prompt is then byte-identical to before.
   *
   * source: AP feature-mode prepare_prd_input contract, shipped 2026-06.
   */
  readonly codebase_grounding?: CodebaseGrounding;
  /**
   * Run-level Cortex memory-recall summary (state.global_recall_summary),
   * fetched ONCE per run in input_analysis on `feature_description` — before
   * any section-specific context exists. Distinct from `recall_summary`
   * (per-section, template-driven query, rendered as `<codebase_context>`):
   * this is prior-run/decision memory that applies across every section, so
   * it is rendered in its own `<project_memory>` block. Optional/falsy for
   * pipelines predating the field or when Cortex returned nothing — the
   * rendered prompt is then byte-identical to before.
   *
   * source: Phase 1a (2026-07-14) — Cortex memory-loop closure.
   */
  readonly global_recall_summary?: string;
  /**
   * git-historian investigation report for the feature's zone
   * (state.git_history_summary), fetched ONCE per run in input_analysis
   * after code-graph grounding settles. Distinct from `global_recall_summary`
   * (Cortex prior-run memory) and `codebase_grounding` (code-graph
   * symbols/communities): this is version-control provenance — relevant
   * commits/PRs, abandoned prior attempts, churn hotspots, discovered
   * constraints. Rendered in its own `<git_history>` block. Optional/falsy
   * for pipelines predating the field, without a codebase, or when the
   * investigation returned nothing — the rendered prompt is then
   * byte-identical to before.
   *
   * source: Phase 2 (2026-07-14) — git-historian stage.
   */
  readonly git_history_summary?: string;
}

const COMMON_RULES = [
  "1. Output ONLY the section body. No surrounding prose, no JSON, no fences.",
  "2. Start with `## <Section Display Name>` exactly once.",
  "3. Every Functional Requirement (FR-XXX) MUST cite a Source: user-request, clarification round, or codebase finding.",
  "4. Acceptance Criteria use `AC-XXX` format starting from AC-001.",
  "5. No `AnyCodable`, `AnyJSON` — heterogeneous JSON is an explicit type.",
  "6. NFR claims (latency, throughput, fps, storage) MUST specify a measurement method.",
  "7. Story-point totals must add up. No self-referencing dependencies.",
  "8. Architectural patterns: ports/adapters in code examples, not frameworks in domain.",
];

const PER_SECTION_GUIDANCE: Partial<Record<SectionType, string>> = {
  overview:
    "1-2 paragraphs. State problem, audience, success measure. No requirements here.",
  goals:
    "Bulleted list of measurable goals. Each goal: outcome verb + target + measurement.",
  requirements:
    "Markdown table: | ID | Requirement | Priority | Depends On | Source |. SP column FORBIDDEN here.",
  user_stories:
    "Each story: As a <role>, I want <action>, so that <outcome>. Include AC-XXX list per story.",
  technical_specification:
    "Show ports (interfaces in domain) + adapters (impls in infrastructure) + composition root. No framework imports in domain.",
  acceptance_criteria:
    "Numbered AC-001..AC-NNN. Each AC: Given/When/Then or one-line behaviour. Each AC must trace to one or more FR-XXX.",
  data_model:
    "DDL for tables/types/enums. Every CREATE TYPE / CREATE TABLE must be referenced. NO `NOW()` in partial-index WHERE.",
  api_specification:
    "Endpoint table: | Method | Path | Auth | Request | Response | Errors |. Match any HTTP-style ports from technical_specification.",
  security_considerations:
    "Auth (mechanism), authz (matrix), data-at-rest, data-in-transit, secrets handling, audit logs. Cite STRIDE category per claim.",
  performance_requirements:
    "p50/p95/p99 + measurement method (e.g., k6 script, prod APM). Verdict: SPEC-COMPLETE if method is named, NEEDS-RUNTIME otherwise.",
  testing:
    "Coverage table: | Test name | Tests AC-XXX or FR-XXX | Type (unit/integration/e2e) | Status |. Real implementations only — no `// TODO` test bodies.",
  deployment:
    "Phases (canary, full), rollback procedure, feature flags, monitoring/alerting hooks.",
  risks:
    "Risk register: | Risk | Likelihood | Impact | Mitigation | Owner |. One row per risk.",
  timeline:
    "Phases with sprint counts. Each phase total = sum of stories in that phase. Grand total = sum of phases.",
};

/**
 * Render the strategies block. Empty string when no assignment is provided
 * (legacy callers); a structured block listing required / optional / forbidden
 * strategies + the research citations + the expected improvement when present.
 *
 * source: Phase 4 strategy-wiring (2026-04). The block is structured so the
 * subagent can apply the strategies deliberately rather than treating them
 * as decorative metadata.
 */
function renderStrategiesBlock(
  assignment: StrategyAssignment | undefined,
): string {
  if (!assignment) return "";
  const lines: string[] = [
    `<strategies>`,
    `Apply the following research-evidence-backed reasoning strategies:`,
    "",
  ];
  if (assignment.required.length > 0) {
    lines.push(`REQUIRED (apply all of these):`);
    for (const s of assignment.required) lines.push(`  - ${s}`);
  }
  if (assignment.optional.length > 0) {
    lines.push(`OPTIONAL (apply if natural for this section):`);
    for (const s of assignment.optional) lines.push(`  - ${s}`);
  }
  if (assignment.forbidden.length > 0) {
    lines.push(`FORBIDDEN (do NOT apply — these have been shown to harm this kind of claim):`);
    for (const s of assignment.forbidden) lines.push(`  - ${s}`);
  }
  if (assignment.researchCitations.length > 0) {
    lines.push("");
    lines.push(`Citations backing this assignment:`);
    for (const c of assignment.researchCitations) lines.push(`  - ${c}`);
  }
  // The number is a population-level aggregate of research-evidence scores
  // across the strategies in this assignment — NOT a forward-looking
  // prediction calibrated to this specific section/feature. Labeling it
  // as such prevents the engineer subagent from inflating its own
  // confidence based on a number that is structurally an average over
  // unrelated benchmarks (cross-audit feynman MED-1, Phase 4 wiring,
  // 2026-04).
  lines.push(
    `Research-evidence baseline (population aggregate, NOT a per-section prediction): ${(assignment.expectedImprovement * 100).toFixed(1)}%`,
  );
  lines.push(
    `Assignment confidence: ${(assignment.assignmentConfidence * 100).toFixed(1)}%`,
  );
  lines.push(`</strategies>`);
  return lines.join("\n");
}

/**
 * Size caps for the grounding block. These bound prompt tokens — a large graph
 * (hundreds of matched symbols / communities) must not blow the per-section
 * prompt budget. Caps mirror the intent of summarizeRecall's truncation in
 * orchestration: include enough real evidence to ground the draft, drop the
 * long tail.
 *
 * source: provisional heuristic, parallel to RECALL_MAX_RESULTS_INCLUDED=8 in
 * orchestration/section-generation.ts (Phase 3+4 retrieval budget). Symbols get
 * a higher cap (15) because each is one short line and they are the primary
 * grounding signal; community/process name lists get 10 each.
 */
const GROUNDING_MAX_SYMBOLS = 15;
const GROUNDING_MAX_COMMUNITY_NAMES = 10;
const GROUNDING_MAX_PROCESS_NAMES = 10;

/**
 * Render the `<codebase_grounding>` block. Returns "" when grounding is absent
 * or carries no usable evidence (no symbols, no communities, no processes, no
 * stats) — so a pipeline without grounding produces a byte-identical prompt to
 * before (no empty tags). Concise on purpose: a stats header, then capped lists
 * of real symbols/files/communities/processes.
 *
 * source: AP feature-mode prepare_prd_input contract (prd_context), 2026-06.
 */
function renderGroundingBlock(
  grounding: CodebaseGrounding | undefined,
): string {
  if (!grounding) return "";

  const symbols = grounding.matched_symbols ?? [];
  const communities = grounding.impacted_communities ?? [];
  const processes = grounding.impacted_processes ?? [];
  const stats = grounding.graph_stats;
  const summary = grounding.finding_summary?.trim() ?? "";

  const hasStats =
    !!stats &&
    [stats.nodes, stats.edges, stats.communities, stats.processes].some(
      (n) => typeof n === "number",
    );
  const hasContent =
    symbols.length > 0 ||
    communities.length > 0 ||
    processes.length > 0 ||
    summary.length > 0 ||
    hasStats;
  if (!hasContent) return "";

  const lines: string[] = [`<codebase_grounding>`];

  if (summary) lines.push(summary);

  if (hasStats && stats) {
    lines.push(
      `Graph: ${stats.nodes ?? "?"} nodes, ${stats.edges ?? "?"} edges, ` +
        `${stats.communities ?? "?"} communities, ${stats.processes ?? "?"} processes.`,
    );
  }

  if (symbols.length > 0) {
    lines.push(
      `Matched symbols (showing ${Math.min(symbols.length, GROUNDING_MAX_SYMBOLS)} of ${symbols.length}):`,
    );
    for (const s of symbols.slice(0, GROUNDING_MAX_SYMBOLS)) {
      const label = s.name ?? s.qualified_name ?? "(unnamed)";
      const file = s.file_path ? ` — ${s.file_path}` : "";
      const community =
        s.community_id !== undefined ? ` (community ${s.community_id})` : "";
      lines.push(`  - ${label}${file}${community}`);
    }
  }

  if (communities.length > 0) {
    const shown = communities.slice(0, GROUNDING_MAX_COMMUNITY_NAMES);
    lines.push(
      `Impacted communities (${communities.length}): ${shown.join(", ")}`,
    );
  }

  if (processes.length > 0) {
    const shown = processes.slice(0, GROUNDING_MAX_PROCESS_NAMES);
    lines.push(
      `Impacted processes (${processes.length}): ${shown.join(", ")}`,
    );
  }

  lines.push(`</codebase_grounding>`);
  return lines.join("\n");
}

/**
 * Instructs the engineer subagent to append a machine-parsable "Affected
 * Symbols" block to the technical_specification section. This is the ONLY
 * source for ai-architect-mcp-codebase stage 6's `stage-5.affected_symbols.json`
 * sidecar — claims must come from what the LLM asserts here, never from
 * `<codebase_grounding>` (that would validate the graph against itself;
 * stage 6's whole purpose is to catch symbols the PRD claims that the graph
 * does NOT contain).
 *
 * The block is a deliberate, narrowly-scoped exception to COMMON_RULES #1
 * ("no JSON, no fences") — it is appended AFTER the section body, marked
 * unambiguously, and stripped from the human-readable PRD before assembly
 * (see @prd-gen/core stripAffectedSymbolsBlock, applied in
 * orchestration/file-export.ts joinSections). The block is REQUIRED, never
 * optional: when the section introduces no symbol-level changes (e.g. a
 * purely conceptual/greenfield technical spec, or a docs-only/infra-only
 * PRD) the model still emits the block, with `affected_symbols: []`. This
 * is because file-export.ts's export policy keys on whether the
 * technical_specification section ran at all, not on whether the model's
 * block was non-empty — an omitted block is indistinguishable downstream
 * from "extraction never ran," which is a different, ABSENT-sidecar state
 * that wrongly triggers stage 6's low-precision regex fallback. An empty
 * `affected_symbols` array, in contrast, is exported as a genuine
 * zero-claims sidecar and correctly suppresses that fallback.
 *
 * source: ai-architect-mcp-codebase stages/stage-6.md, "Zero-claims case —
 * not the same as absent" (§4.2), pinned at commit
 * 92216cd90f8f26cb15348675fc6556b8293edfc1; parser verified against
 * src/prd_validator.rs::parse_structured_claims (JSON, not the doc's
 * illustrative YAML) — see affected-symbols.ts module doc.
 */
function renderAffectedSymbolsInstruction(sectionType: SectionType): string {
  if (sectionType !== "technical_specification") return "";
  return [
    `<affected_symbols_instruction>`,
    `After the section body above, append EXACTLY ONE block in this exact`,
    `form (this is the ONLY place fenced JSON is permitted in this section —`,
    `do not use JSON/fences anywhere else). This block is REQUIRED in every`,
    `technical_specification section, with no exception:`,
    "",
    AFFECTED_SYMBOLS_MARKER,
    "```json",
    `{`,
    `  "affected_symbols": [`,
    `    {"qualified_name": "<file_path>::<symbol_name>", "change_kind": "add|modify|remove|rename", "rationale": "<why this symbol is touched>"}`,
    `  ],`,
    `  "scope_claims": [`,
    `    {"kind": "community_scope", "assertion": "<human-readable community label>"},`,
    `    {"kind": "process_exclusion", "processes": ["process::<entry_qualified_name>"]}`,
    `  ]`,
    `}`,
    "```",
    "",
    `Rules for this block:`,
    `  - qualified_name MUST be "<file_path>::<symbol_name>" (e.g. "src/main.rs::handle_tool_call"), matching a REAL symbol from <codebase_grounding> when grounding is present. Entries without qualified_name are ignored downstream.`,
    `  - scope_claims is optional; omit the key entirely if there is nothing to claim.`,
    `  - If nothing in this feature modifies, adds, removes, or renames any existing codebase symbol (e.g. a purely conceptual/greenfield spec, or a docs-only/infra-only change), emit the block anyway with "affected_symbols": [] — do NOT omit the block. An omitted block is read downstream as "extraction did not run," a different state from "ran and found nothing," and routes this PRD through a low-precision fallback instead of correctly reporting zero claims.`,
    `</affected_symbols_instruction>`,
  ].join("\n");
}

export function buildSectionPrompt(input: SectionPromptInput): string {
  const display = SECTION_DISPLAY_NAMES[input.section_type];
  const contextConfig = PRD_CONTEXT_CONFIGS[input.prd_context];
  const sectionGuidance =
    PER_SECTION_GUIDANCE[input.section_type] ??
    "Follow the section's standard structure.";

  const clarificationLines = input.clarification_qa
    .filter((c) => c.answer)
    .map((c) => `Q: ${c.question}\nA: ${c.answer}`)
    .join("\n\n");

  const violationsBlock = input.prior_violations.length
    ? [
        `<previous_attempt_failed validation>`,
        `Attempt ${input.attempt - 1} produced violations:`,
        input.prior_violations.map((v) => `- ${v}`).join("\n"),
        `Fix every violation in this attempt.`,
        `</previous_attempt_failed>`,
      ].join("\n")
    : "";

  const strategiesBlock = renderStrategiesBlock(input.strategy_assignment);
  const groundingBlock = renderGroundingBlock(input.codebase_grounding);
  const affectedSymbolsInstruction = renderAffectedSymbolsInstruction(
    input.section_type,
  );

  return [
    `<role>You draft section "${display}" of a ${contextConfig.displayName} PRD.</role>`,
    "",
    `<feature>${input.feature_description}</feature>`,
    "",
    `<context>`,
    `PRD type: ${contextConfig.displayName}`,
    `Focus: ${contextConfig.description}`,
    `Attempt: ${input.attempt}`,
    `</context>`,
    "",
    input.global_recall_summary
      ? `<project_memory>\n${input.global_recall_summary}\n</project_memory>\n`
      : "",
    input.git_history_summary
      ? `<git_history>\n${input.git_history_summary}\n</git_history>\n`
      : "",
    input.recall_summary
      ? `<codebase_context>\n${input.recall_summary}\n</codebase_context>\n`
      : "",
    groundingBlock,
    clarificationLines
      ? `<clarifications>\n${clarificationLines}\n</clarifications>\n`
      : "",
    violationsBlock,
    strategiesBlock,
    `<guidance>`,
    sectionGuidance,
    `</guidance>`,
    "",
    `<hard_rules>`,
    COMMON_RULES.join("\n"),
    `</hard_rules>`,
    "",
    affectedSymbolsInstruction,
    `Produce the "${display}" section now. Markdown only.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
