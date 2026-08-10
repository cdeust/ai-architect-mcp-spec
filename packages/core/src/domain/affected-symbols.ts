import { z } from "zod";

/**
 * `stage-5.affected_symbols.json` sidecar — contract-first claim extraction
 * for ai-architect-mcp-codebase's stage 6 anti-hallucination validator
 * (`validate_prd_against_graph`).
 *
 * Claims originate from the PRD generator's own LLM output (the
 * "Affected Symbols" block requested in the technical_specification prompt —
 * see @prd-gen/meta-prompting section-prompts.ts), NOT from codebase_grounding.
 * Deriving claims from grounding would validate the graph against itself
 * (circular — the whole point of stage 6's axis V1 is to catch symbols the
 * PRD claims that the graph does NOT contain).
 *
 * source: ai-architect-mcp-codebase stages/stage-6.md §4.2 (contract shape) +
 * src/prd_validator.rs::parse_structured_claims (parser — confirms JSON,
 * not the YAML shown in the doc's illustrative example; sidecar is read via
 * `serde_json::from_str`). Verified 2026-07-14 against the live binary
 * source at /Users/cdeust/Developments/anthropic-partnership/automatised-pipeline.
 */

/** source: stage-6.md §4.2 — `change_kind` enumerates these four values. */
export const ChangeKindSchema = z.enum(["add", "modify", "remove", "rename"]);
export type ChangeKind = z.infer<typeof ChangeKindSchema>;

/**
 * A single affected-symbol claim. `qualified_name` is the only field
 * prd_validator.rs treats as required — entries whose `qualified_name` is
 * empty/absent are skipped by the Rust parser (`if qn.is_empty() { continue; }`),
 * so this schema mirrors that by requiring a non-empty string.
 */
export const AffectedSymbolSchema = z.object({
  qualified_name: z.string().min(1),
  change_kind: ChangeKindSchema.optional(),
  rationale: z.string().optional(),
});
export type AffectedSymbol = z.infer<typeof AffectedSymbolSchema>;

/**
 * Scope claims — two kinds recognized by prd_validator.rs::parse_structured_claims
 * (any other `kind` value is silently dropped by the Rust parser's `_ => {}` arm;
 * this schema mirrors that by only accepting the two enumerated kinds).
 */
export const ScopeClaimSchema = z.object({
  kind: z.enum(["community_scope", "process_exclusion"]),
  /** Used by `community_scope` claims — a human-readable community label. */
  assertion: z.string().optional(),
  /** Used by `process_exclusion` claims — processes the PRD claims NOT to affect. */
  processes: z.array(z.string()).optional(),
});
export type ScopeClaim = z.infer<typeof ScopeClaimSchema>;

export const AffectedSymbolsDocumentSchema = z.object({
  affected_symbols: z.array(AffectedSymbolSchema),
  scope_claims: z.array(ScopeClaimSchema),
});
export type AffectedSymbolsDocument = z.infer<
  typeof AffectedSymbolsDocumentSchema
>;

const EMPTY_DOCUMENT: AffectedSymbolsDocument = {
  affected_symbols: [],
  scope_claims: [],
};

/**
 * Marker preceding the fenced JSON block in generated section content. Kept
 * as a named export so the prompt builder (meta-prompting) and the parser
 * (here) share one literal — drift between "what we ask for" and "what we
 * parse" would silently zero out extraction.
 */
export const AFFECTED_SYMBOLS_MARKER = "<!-- AFFECTED_SYMBOLS_JSON -->";

/**
 * Matches the marker immediately followed by a fenced code block (optionally
 * tagged `json`) and captures the fence's inner text. Anchored to the marker
 * specifically (not "any JSON-looking fence") because technical_specification
 * content routinely contains OTHER fenced code blocks (architecture examples)
 * that must not be mistaken for the claims payload.
 */
const AFFECTED_SYMBOLS_BLOCK_PATTERN = new RegExp(
  `${AFFECTED_SYMBOLS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*` +
    "```(?:json)?\\s*\\n([\\s\\S]*?)\\n?```",
);

/**
 * precondition:  `content` is the raw generated markdown for one section
 *                (any section — callers decide which section to check).
 * postcondition: returns a validated AffectedSymbolsDocument. Extraction is
 *                tolerant (marker absent, block malformed, or JSON.parse
 *                failure all yield the empty document — never throws);
 *                validation of retained entries is strict (each array
 *                element is checked independently via safeParse; invalid
 *                elements are dropped, not the whole array).
 *
 * source: ai-architect-mcp-codebase stages/stage-6.md §4.2, "Contract
 * location" (line 129 at commit 512d683186b3295a4bac6f24f4f7333f9637d811 —
 * pinned because stage-6.md is a live spec under active rename to
 * ai-architect-mcp-spec; the "prd-spec-generator" name below is this pinned
 * revision's, not necessarily the doc's current name): "The prd-spec-generator
 * already outputs multiple JSON files; we require one named
 * `stage-5.affected_symbols.json` alongside the main PRD. If absent, stage 6
 * degrades to regex-only mode with a `contract_missing: true` warning at the
 * top of the report (informational, not fail)."
 *
 * Inference from that contract (not stated verbatim in the doc): since the
 * regex fallback activates only when the sidecar file is ABSENT, exporting
 * an empty sidecar would suppress the fallback without providing any claims
 * to validate against — worse than not exporting at all. Callers must
 * therefore check `affected_symbols.length > 0` before exporting; this
 * function does not decide export policy, only extraction.
 */
export function parseAffectedSymbolsBlock(
  content: string,
): AffectedSymbolsDocument {
  const match = AFFECTED_SYMBOLS_BLOCK_PATTERN.exec(content);
  if (!match) return EMPTY_DOCUMENT;

  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return EMPTY_DOCUMENT;
  }
  if (typeof raw !== "object" || raw === null) return EMPTY_DOCUMENT;
  const obj = raw as Record<string, unknown>;

  return {
    affected_symbols: filterValid(obj.affected_symbols, AffectedSymbolSchema),
    scope_claims: filterValid(obj.scope_claims, ScopeClaimSchema),
  };
}

/**
 * Strip the affected-symbols marker + fenced block from section content so
 * the internal validator payload never leaks into the human-readable PRD
 * document (01-prd.md). No-op (returns content unchanged) when the marker
 * is absent — safe to call on every section unconditionally.
 */
export function stripAffectedSymbolsBlock(content: string): string {
  return content.replace(AFFECTED_SYMBOLS_BLOCK_PATTERN, "").trim();
}

function filterValid<T>(value: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    const result = schema.safeParse(item);
    if (result.success) out.push(result.data);
  }
  return out;
}
