/**
 * Canned fixture-response producers: the fake prose/report content used by
 * canned-dispatcher.ts to answer subagent invocations without a real LLM.
 *
 * Extracted from canned-dispatcher.ts (which was pushing past the 500-line
 * file-size cap, §4.1) — a Move-5 split along a genuine concern boundary:
 * this module answers "what does a fake subagent SAY", canned-dispatcher.ts
 * answers "how does an action route to a result". Each producer here owns
 * exactly one report contract (BRANCH:/WORKTREE:, VERDICT:/FINDINGS:,
 * PR_URL:, ...), matching the parser it is a fixture for.
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
 * Nominal engineer report for the `implementation` step's spawn (PR 4a).
 * Carries a parsable BRANCH:/WORKTREE:/FILES: footer per
 * implementation.ts's report contract (buildImplementationPrompt /
 * parseImplementationReport) so a full "Implement" smoke run traverses
 * `post_impl_verification` instead of aborting on an unparsable report.
 */
export function fakeImplementationReport(): string {
  return [
    "Implemented the requested change on a fresh worktree, per protocol.",
    "",
    "BRANCH: feat/canned-implementation",
    "WORKTREE: /tmp/canned/implementation-worktree",
    "SHA: 0000000000000000000000000000000000cafe",
    "FILES:",
    "- src/example.ts",
  ].join("\n");
}

/**
 * Nominal test-engineer report for the `testing` step's spawn (PR 4b).
 * Freeform prose — TestingStateSchema stores only `{ raw_report }`, no
 * machine-readable footer contract.
 */
export function fakeTestingReport(): string {
  return [
    "Added unit tests for the change and ran the project's test suite on",
    "the implementation worktree. All tests pass; no regressions found.",
  ].join(" ");
}

/**
 * Nominal code-reviewer report for the `review` step's spawn (PR 4b).
 * Carries a parsable VERDICT:/FINDINGS: footer per review.ts's report
 * contract (buildReviewPrompt / parseReviewReport).
 */
export function fakeReviewReport(verdict: "pass" | "fail"): string {
  if (verdict === "pass") {
    return [
      "The implementation matches the spec, verification gates passed, and",
      "the test report shows a clean run.",
      "",
      "VERDICT: PASS",
    ].join("\n");
  }
  return [
    "The implementation has a gap relative to the spec that must be fixed",
    "before this can ship.",
    "",
    "VERDICT: FAIL",
    "FINDINGS:",
    "- Canned synthetic finding: address the gap and resubmit.",
  ].join("\n");
}

/**
 * Nominal engineer report for the `pr_creation` step's spawn (PR 5). Carries
 * a parsable PR_URL: footer per pr-creation.ts's report contract
 * (buildPrCreationPrompt / parsePrCreationReport) unless `footerPresent` is
 * false (used to exercise the "footer absent → degrade" path).
 */
export function fakePrCreationReport(footerPresent: boolean): string {
  const lines = [
    "Pushed the branch and opened a pull request, per protocol.",
    "No merge, no --admin, no force-push.",
  ];
  if (footerPresent) {
    lines.push("", "PR_URL: https://github.com/example/canned/pull/1");
  }
  return lines.join("\n");
}

/**
 * A canned PASS for each claim a judge prompt asks about: a JSON array with
 * one verdict per claim_id (the batched judge prompt of issue #119). With no
 * claim_id (a caller that has no prompt), the single-object form, which the
 * parser accepts for an invocation of one claim.
 */
export function fakeJudgeVerdict(claimIds: readonly string[] = []): string {
  const verdict = {
    verdict: "PASS",
    rationale: "Canned synthetic verdict.",
    caveats: [],
    confidence: 0.9,
  };
  return claimIds.length === 0
    ? JSON.stringify(verdict)
    : JSON.stringify(claimIds.map((claim_id) => ({ claim_id, ...verdict })));
}

export function fakeClarificationQuestion(): string {
  return JSON.stringify({
    question: "What is the primary success metric?",
    options: null,
    rationale: "Canned placeholder.",
  });
}
