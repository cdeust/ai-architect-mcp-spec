/**
 * Contracts for the ai-architect-mcp-codebase MCP.
 * Stage assignments per /Users/cdeust/Developments/anthropic/ai-architect-mcp-codebase/NOTES.md.
 *
 * Tool names are canonical — defined in the pipeline's `src/tool_schemas.rs`.
 * We do not duplicate logic; we type the requests and parse the responses.
 */

import { z } from "zod";

// ─── Stage 3a: Index + query graph ──────────────────────────────────────────

/**
 * source: tool_schemas.rs index_codebase_schema (live binary at
 * /Users/cdeust/Developments/anthropic/ai-architect-mcp-codebase/src/tool_schemas.rs:214).
 * Required fields are `path` and `output_dir`; `language` is optional with
 * default "auto". `refresh` is NOT in the schema.
 */
export const IndexCodebaseRequestSchema = z.object({
  path: z.string().describe("Absolute path to the codebase root"),
  output_dir: z
    .string()
    .describe("Absolute directory where the graph will be stored"),
  language: z
    .enum(["rust", "swift", "typescript", "python", "auto"])
    .default("auto"),
});
export type IndexCodebaseRequest = z.infer<typeof IndexCodebaseRequestSchema>;

/**
 * source: live binary returns `graph_path` (not `graph_id`); see live-integration
 * test in packages/ecosystem-adapters/src/__tests__/ai-architect-codebase.integration.test.ts.
 */
export const IndexCodebaseResponseSchema = z.object({
  graph_path: z.string(),
  symbols_indexed: z.number().int().nonnegative().optional(),
  files_parsed: z.number().int().nonnegative().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
});
export type IndexCodebaseResponse = z.infer<typeof IndexCodebaseResponseSchema>;

/**
 * source: ai-architect-mcp-codebase/src/tool_schemas.rs:522 analyze_codebase_schema
 * (verified against the live binary's do_analyze_codebase in main.rs,
 * 2026-07-13). Stage 3 all-in-one: runs index_codebase + resolve_graph +
 * cluster_graph in one call. Required fields are `path` and `output_dir`;
 * `language` defaults to "auto"; `dependency_scope` defaults to "none".
 * NOTE: the schema has no `directory` field — do not confuse with the
 * pre-fix client stub that passed `{ directory }`.
 */
export const AnalyzeCodebaseRequestSchema = z.object({
  path: z.string().describe("Absolute path to the codebase root to index"),
  output_dir: z
    .string()
    .describe("Absolute directory where the graph will be stored"),
  language: z
    .enum([
      "auto",
      "rust",
      "python",
      "typescript",
      "java",
      "kotlin",
      "swift",
      "objc",
      "c",
      "cpp",
      "go",
    ])
    .default("auto"),
  dependency_scope: z.enum(["none", "public_api", "full"]).default("none"),
});
export type AnalyzeCodebaseRequest = z.infer<
  typeof AnalyzeCodebaseRequestSchema
>;

/**
 * source: ai-architect-mcp-codebase/src/main.rs do_analyze_codebase — response
 * shape verified 2026-07-13 (`graph_path` top-level plus `index`/`resolve`/
 * `cluster` sub-objects). Only `graph_path` is required by downstream graph
 * tools; the rest is opaque combined-stage statistics.
 */
export const AnalyzeCodebaseResponseSchema = z.object({
  graph_path: z.string(),
  index: z
    .object({
      node_count: z.number().int().nonnegative().optional(),
      edge_count: z.number().int().nonnegative().optional(),
      files_indexed: z.number().int().nonnegative().optional(),
    })
    .optional(),
  resolve: z.record(z.string(), z.unknown()).optional(),
  cluster: z
    .object({
      community_count: z.number().int().nonnegative().optional(),
      process_count: z.number().int().nonnegative().optional(),
      modularity: z.number().optional(),
    })
    .optional(),
});
export type AnalyzeCodebaseResponse = z.infer<
  typeof AnalyzeCodebaseResponseSchema
>;

export const QueryGraphRequestSchema = z.object({
  graph_path: z
    .string()
    .describe("Absolute path to the graph (returned by index_codebase)"),
  query: z.string().describe("Cypher query against the graph"),
});
export type QueryGraphRequest = z.infer<typeof QueryGraphRequestSchema>;

// ─── Stage 3d: Hybrid search + context ──────────────────────────────────────

export const SearchCodebaseRequestSchema = z.object({
  graph_id: z.string(),
  query: z.string(),
  mode: z.enum(["bm25", "vector", "hybrid"]).default("hybrid"),
  limit: z.number().int().min(1).max(50).default(10),
});
export type SearchCodebaseRequest = z.infer<typeof SearchCodebaseRequestSchema>;

export const SearchCodebaseHitSchema = z.object({
  symbol: z.string(),
  file: z.string(),
  line: z.number().int(),
  score: z.number(),
  snippet: z.string(),
});
export type SearchCodebaseHit = z.infer<typeof SearchCodebaseHitSchema>;

export const GetContextRequestSchema = z.object({
  graph_id: z.string(),
  symbol_fqn: z.string(),
  hops: z.number().int().min(0).max(4).default(2),
});
export type GetContextRequest = z.infer<typeof GetContextRequestSchema>;

// ─── Stage 3c: Impact + clusters ────────────────────────────────────────────

export const GetImpactRequestSchema = z.object({
  graph_id: z.string(),
  changed_symbols: z.array(z.string()).min(1),
  depth: z.number().int().min(1).max(5).default(2),
});
export type GetImpactRequest = z.infer<typeof GetImpactRequestSchema>;

export const ImpactedSymbolSchema = z.object({
  fqn: z.string(),
  distance: z.number().int().nonnegative(),
  community: z.string().optional(),
});
export type ImpactedSymbol = z.infer<typeof ImpactedSymbolSchema>;

// ─── Stage 4: PRD input bundle ──────────────────────────────────────────────

export const PreparePrdInputRequestSchema = z.object({
  graph_id: z.string(),
  finding_id: z.string(),
  output_path: z.string().describe("Where to write stage-4.prd_input.json"),
});
export type PreparePrdInputRequest = z.infer<typeof PreparePrdInputRequestSchema>;

/**
 * Bounded-I/O budget for the PrdInputBundle (Phase 1c).
 *
 * The bundle is parsed from the ai-architect-mcp-codebase MCP and stored verbatim
 * into PipelineState.codebase_grounding, which is later serialized into every
 * section-generation prompt as codebase context. An unbounded bundle therefore
 * blows up (a) the MCP frame carrying the prepare_prd_input response and
 * (b) every downstream section prompt. The pipeline's contract is the only
 * place that can reject it before either happens, because each field is opaque
 * (z.unknown()) and there is no other type boundary on the path.
 *
 * Budget derivation (measured, not invented):
 *   Claude Code rejects MCP tool results over MAX_MCP_OUTPUT_TOKENS = 25,000
 *   tokens at 4 chars/token = 100,000 chars of compact JSON.
 *   source: Claude Code 2.1.170 binary, extracted 2026-06-10 — default
 *   MAX_MCP_OUTPUT_TOKENS d4O=25000, estimator chars/4 → 100,000 char cap.
 *   Verified char-exact against a rejected 324,429-char response.
 *   Mirrors the Cortex sibling repo's MAX_RESPONSE_CHARS = 100_000
 *   (mcp_server/core/response_budget.py).
 *
 * Whole-bundle target: BUNDLE_BUDGET_CHARS = 100,000 chars. The five fields
 * get proportional shares of that budget based on how much each contributes to
 * a real bundle (the array fields carry the bulk of the codebase context;
 * `finding` and `graph_stats` are small singular objects). Shares sum to the
 * budget; JSON structural overhead (keys, brackets) is absorbed by leaving the
 * per-field caps slightly below an even split so the serialized whole stays
 * under 100,000 chars even when every field is at its cap.
 *
 * Rejection (not truncation) is the policy here: the bundle is opaque to this
 * layer (z.unknown()), so we cannot safely truncate inside it without risking
 * invalid JSON or dropping the one field a section needed. A ZodError is the
 * observable signal — the caller (preparePrdInput) sees it and must ask
 * ai-architect-mcp-codebase for a smaller finding/graph slice. Silent data loss is
 * never acceptable (Phase 1c rule).
 */
// source: Claude Code 2.1.170 binary cap, 100,000 chars (see block comment).
const BUNDLE_BUDGET_CHARS = 100_000;

/**
 * Per-field char caps. Derived from BUNDLE_BUDGET_CHARS by proportional share:
 *   matched_symbols / impacted_communities / impacted_processes — the three
 *   array fields carry the codebase context, so they get the largest shares;
 *   finding + graph_stats are single objects and get small shares.
 * Shares: 0.30 + 0.20 + 0.20 + 0.10 + 0.10 = 0.90 of the budget; the remaining
 * 0.10 (10,000 chars) is structural-overhead headroom so the serialized whole
 * bundle stays under 100,000 chars with every field at its cap.
 * The cap is enforced on each field's compact-JSON serialization length.
 */
const MATCHED_SYMBOLS_BUDGET_CHARS = 30_000; // 0.30 × 100,000
const IMPACTED_COMMUNITIES_BUDGET_CHARS = 20_000; // 0.20 × 100,000
const IMPACTED_PROCESSES_BUDGET_CHARS = 20_000; // 0.20 × 100,000
const FINDING_BUDGET_CHARS = 10_000; // 0.10 × 100,000
const GRAPH_STATS_BUDGET_CHARS = 10_000; // 0.10 × 100,000

/**
 * Max element counts for the array fields. Derived from the per-array char
 * budget divided by a measured per-element floor: a single matched-symbol /
 * community / process entry serializes to ~200 chars minimum (fqn + file +
 * a few numeric fields).
 *   source: measured 2026-06-10 on the ai-architect-mcp-codebase integration
 *   fixture (packages/ecosystem-adapters/src/__tests__/ai-architect-codebase.integration.test.ts)
 *   — smallest entry observed was 187 chars compact-JSON; rounded up to 200.
 * Element cap = floor(array_budget / 200). The element cap and the char cap
 * are BOTH enforced (.max() on count, plus the serialized-length refine):
 * either bound tripping rejects the bundle, so a few huge elements are caught
 * by the char cap and many tiny elements by the count cap.
 */
const MIN_ELEMENT_CHARS = 200; // measured floor, see above
const MATCHED_SYMBOLS_MAX = Math.floor(
  MATCHED_SYMBOLS_BUDGET_CHARS / MIN_ELEMENT_CHARS,
); // 150
const IMPACTED_COMMUNITIES_MAX = Math.floor(
  IMPACTED_COMMUNITIES_BUDGET_CHARS / MIN_ELEMENT_CHARS,
); // 100
const IMPACTED_PROCESSES_MAX = Math.floor(
  IMPACTED_PROCESSES_BUDGET_CHARS / MIN_ELEMENT_CHARS,
); // 100

/** Compact-JSON serialized length of an opaque value (matches Claude Code's counted text). */
function jsonChars(value: unknown): number {
  return JSON.stringify(value).length;
}

/**
 * A field of the bundle whose serialization must stay within `budget` chars.
 * Rejection is a ZodError (observable) — never silent truncation.
 */
function boundedJsonField(budget: number, fieldName: string) {
  return z.unknown().refine((v) => jsonChars(v) <= budget, {
    message: `${fieldName} exceeds bounded-I/O budget of ${budget} chars (serialized). Request a smaller slice from ai-architect-mcp-codebase. source: Claude Code 2.1.170 MCP 100,000-char cap, proportional share.`,
  });
}

/**
 * A bounded array field: capped element count (.max) AND capped serialized
 * length (refine). Both bounds reject with a ZodError.
 */
function boundedJsonArray(
  maxElements: number,
  budget: number,
  fieldName: string,
) {
  return z
    .array(z.unknown())
    .max(maxElements, {
      message: `${fieldName} exceeds ${maxElements} elements (bounded-I/O element cap = floor(${budget}/${MIN_ELEMENT_CHARS})). source: measured 200-char element floor, AP integration fixture 2026-06-10.`,
    })
    .refine((arr) => jsonChars(arr) <= budget, {
      message: `${fieldName} exceeds bounded-I/O budget of ${budget} chars (serialized). source: Claude Code 2.1.170 MCP 100,000-char cap, proportional share.`,
    });
}

export const PrdInputBundleSchema = z.object({
  finding: boundedJsonField(FINDING_BUDGET_CHARS, "finding"),
  matched_symbols: boundedJsonArray(
    MATCHED_SYMBOLS_MAX,
    MATCHED_SYMBOLS_BUDGET_CHARS,
    "matched_symbols",
  ),
  impacted_communities: boundedJsonArray(
    IMPACTED_COMMUNITIES_MAX,
    IMPACTED_COMMUNITIES_BUDGET_CHARS,
    "impacted_communities",
  ),
  impacted_processes: boundedJsonArray(
    IMPACTED_PROCESSES_MAX,
    IMPACTED_PROCESSES_BUDGET_CHARS,
    "impacted_processes",
  ),
  graph_stats: boundedJsonField(GRAPH_STATS_BUDGET_CHARS, "graph_stats"),
});
export type PrdInputBundle = z.infer<typeof PrdInputBundleSchema>;

/**
 * Exported for tests and for callers that want to check a bundle's budget
 * without parsing (e.g. to log a warning before a hard reject).
 */
export const PRD_INPUT_BUNDLE_BUDGET = {
  BUNDLE_BUDGET_CHARS,
  MATCHED_SYMBOLS_MAX,
  IMPACTED_COMMUNITIES_MAX,
  IMPACTED_PROCESSES_MAX,
  FINDING_BUDGET_CHARS,
  GRAPH_STATS_BUDGET_CHARS,
} as const;

// ─── Stage 6: PRD-vs-graph validation ───────────────────────────────────────

export const ValidatePrdAgainstGraphRequestSchema = z.object({
  graph_id: z.string(),
  prd_path: z.string(),
});
export type ValidatePrdAgainstGraphRequest = z.infer<
  typeof ValidatePrdAgainstGraphRequestSchema
>;

export const PrdGraphValidationReportSchema = z.object({
  hallucinated_symbols: z.array(z.string()),
  community_inconsistencies: z.array(z.string()),
  unverified_impact_claims: z.array(z.string()),
  verdict: z.enum(["pass", "warn", "fail"]),
});
export type PrdGraphValidationReport = z.infer<
  typeof PrdGraphValidationReportSchema
>;

// ─── Stage 9: Semantic diff verification ────────────────────────────────────

export const VerifySemanticDiffRequestSchema = z.object({
  pre_graph_id: z.string(),
  post_graph_id: z.string(),
});
export type VerifySemanticDiffRequest = z.infer<
  typeof VerifySemanticDiffRequestSchema
>;

export const SemanticDiffReportSchema = z.object({
  dangling_refs: z.array(z.string()),
  new_sccs: z.array(z.string()),
  unresolved_delta: z.number().int(),
  regression_score: z.number(),
  verdict: z.enum(["clean", "concerning", "regression"]),
});
export type SemanticDiffReport = z.infer<typeof SemanticDiffReportSchema>;
