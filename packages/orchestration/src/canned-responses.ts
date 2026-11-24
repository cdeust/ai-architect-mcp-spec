/**
 * Canned fixture-response producers: the fake prose/report content used by
 * canned-dispatcher.ts to answer subagent invocations without a real LLM.
 *
 * Extracted from canned-dispatcher.ts (which was pushing past the 500-line
 * file-size cap, §4.1) — a Move-5 split along a genuine concern boundary:
 * this module answers "what does a fake subagent SAY", canned-dispatcher.ts
 * answers "how does an action route to a result".
 *
 * source: design-phases-3-5.md (PR 3b-5, report-contract precedent);
 * craftsmanship gate §4.1 (500-line file cap).
 */

/**
 * Default per-section draft producer. Each branch emits content the claim
 * extractors recognise (FR_LINE_RE, AC_LINE_RE, ARCH_PATTERNS, NFR_PATTERNS,
 * SECURITY_KEYWORDS). Without claims the verifier returns zero judge_requests
 * and the self-check phase silently bypasses the judge round.
 *
 * source: curie cross-audit pass-2 (2026-04) — fake drafts must be claim-rich.
 */
export function defaultFakeSectionDraft(section_type: string): string {
  const heading = `## ${section_type}`;
  switch (section_type) {
    case "requirements":
      return [
        heading,
        "",
        "- FR-001: The system supports OAuth login via Google and GitHub.",
        "- FR-002: The system stores session tokens in HttpOnly cookies.",
      ].join("\n");
    case "acceptance_criteria":
      return [
        heading,
        "",
        "- AC-001: A user with valid Google credentials can sign in.",
        "- AC-002: A user with invalid credentials sees an error message.",
      ].join("\n");
    case "technical_specification":
      return [
        heading,
        "",
        "We use ports-and-adapters architecture. The OAuth domain port is",
        "implemented by Google and GitHub adapters at the infrastructure layer.",
      ].join("\n");
    case "performance_requirements":
      return [
        heading,
        "",
        "p95 < 250ms for token validation under nominal load.",
      ].join("\n");
    case "security_considerations":
      return [
        heading,
        "",
        "All session tokens use AES-256-GCM. Authentication uses OAuth 2.0.",
      ].join("\n");
    default:
      return [heading, "", "Canned synthetic content."].join("\n");
  }
}

/**
 * A canned PASS for each claim a judge prompt asks about: a JSON array with
 * one verdict per claim_id (the batched judge prompt of issue #119).
 */
export function fakeJudgeVerdict(claimIds: readonly string[]): string {
  return JSON.stringify(
    claimIds.map((claim_id) => ({
      claim_id,
      verdict: "PASS",
      rationale: "Canned synthetic verdict.",
      caveats: [],
      confidence: 0.9,
    })),
  );
}

export function fakeClarificationQuestion(): string {
  return JSON.stringify({
    question: "What is the primary success metric?",
    options: null,
    rationale: "Canned placeholder.",
  });
}
