/**
 * Bounded-I/O caps for in-memory pipeline arrays (Phase 1c).
 *
 * PipelineState lives in the runStore and is serialized into MCP responses
 * (get_pipeline_state format:"full" returns the whole state; section prompts
 * embed clarification_qa). Two append-only arrays can grow without bound:
 * `clarifications` (one turn per Q&A round) and `errors` (one per failure).
 * Neither had a contract cap before Phase 1c — the per-context clarification
 * range bounds rounds in the handler, but for the default tier
 * CAPABILITIES.maxClarificationRounds is Infinity, so the schema is the only
 * guaranteed bound.
 *
 * Budget derivation (measured, not invented):
 *   Claude Code rejects MCP tool results over 25,000 tokens = 100,000 chars
 *   of compact JSON.
 *   source: Claude Code 2.1.170 binary, extracted 2026-06-10 — default
 *   MAX_MCP_OUTPUT_TOKENS d4O=25000, estimator chars/4 → 100,000 char cap.
 *   Verified char-exact against a rejected 324,429-char response. Mirrors the
 *   Cortex sibling repo's MAX_RESPONSE_CHARS = 100_000.
 */
// source: Claude Code 2.1.170 binary cap (see block comment above).
// Exported so the response boundary (mcp-server get_pipeline_state format:"full")
// derives its single aggregate ceiling from the SAME measured constant the input
// contracts use — no second, drifting copy of the budget (Phase 1d).
export const MAX_RESPONSE_CHARS = 100_000;

/**
 * Max clarification turns retained. A turn serializes to ~1,000 chars
 * (round + question + answer + two ISO timestamps; question/answer are short
 * sentences). get_pipeline_state format:"full" ships the whole array over MCP,
 * and section prompts embed clarification_qa, so the turns must fit the
 * 100,000-char response budget alongside the rest of the state.
 *   source: measured 2026-06-10 — a representative clarification turn from a
 *   production run serialized to 740 chars compact-JSON; rounded up to 1,000
 *   to leave headroom for long freeform answers.
 * Cap = floor((MAX_RESPONSE_CHARS / 2) / 1000) = 50. Half the budget is
 * reserved for clarifications so the other half covers the rest of the state
 * (sections, errors, grounding) when format:"full" is requested.
 */
// source: measured 740, rounded up (see above). Reuse the turn estimate as
// the per-field ceiling for composed text (1,000 UTF-16 code units per field).
const CLARIFICATION_TURN_CHARS = 1_000;
export const MAX_CLARIFICATION_TURNS = Math.floor(
  MAX_RESPONSE_CHARS / 2 / CLARIFICATION_TURN_CHARS,
); // 50

/**
 * Max error messages retained (FIFO). Genuine error messages only — not a
 * progress log. An error string is short (≤500 chars by convention), and the
 * parallel error_kinds entry is a single enum token. The errors array ships
 * its length over MCP (envelope.state_summary.errors) but its contents ship in
 * format:"full". Cap so the array cannot dominate the 100,000-char response
 * budget: floor((MAX_RESPONSE_CHARS / 4) / 500) = 50. A quarter of the budget
 * is allotted to errors+kinds; the rest covers sections, clarifications, and
 * grounding.
 *   source: 500-char error floor is the project convention (errors are
 *   single-sentence failure messages, not stack dumps); measured 2026-06-10,
 *   longest observed pipeline error was 312 chars.
 * Eviction is FIFO with a dropped count surfaced via appendError's return —
 * never silent loss (Phase 1c rule). The oldest errors are dropped because the
 * most recent failures are the ones a caller acts on.
 */
const ERROR_MESSAGE_CHARS = 500; // project convention, measured max 312
export const MAX_PIPELINE_ERRORS = Math.floor(
  MAX_RESPONSE_CHARS / 4 / ERROR_MESSAGE_CHARS,
); // 50

export function boundedClarificationText(value: string): string {
  return value.slice(0, CLARIFICATION_TURN_CHARS);
}

// The compose protocol supplies labels only. Its rationale is the ask_user description.
export function boundedClarificationOptions(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) return null;
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const label = boundedClarificationText(entry);
    if (!label.trim()) return null;
    labels.push(label);
  }
  return labels;
}
