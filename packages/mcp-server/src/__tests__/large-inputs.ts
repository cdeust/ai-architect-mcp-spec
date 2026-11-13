/**
 * Inputs large enough to push a tool's unbounded response over the
 * 100,000-char budget (#125), shared by the size-contract tests.
 */

/**
 * Deterministic filler prose with no claim pattern: one sentence per line,
 * a blank line every fourth, as a PRD is written (a claim's evidence is a
 * few lines around it, so a single 58k line would put the whole section in
 * every claim).
 */
export function filler(topic: string, chars: number): string {
  const sentence = `The ${topic} part of the product is described here in plain words for the reader.`;
  let text = "";
  for (let line = 1; text.length < chars; line++) text += sentence + (line % 4 === 0 ? "\n\n" : "\n");
  return text.slice(0, chars);
}

export type Section = { type: string; content: string };

/**
 * Eight sections, about 58,000 chars: the size at which the 2026-11-10
 * measurement on #125 found 238,729 chars. Each section carries the lines
 * the claim extractors recognise, then filler up to `perSection` chars.
 */
export function largePrd(perSection = 7_250): Section[] {
  const claimLines: Record<string, string[]> = {
    requirements: [
      "- FR-001: The system supports OAuth login via Google and GitHub.",
      "- FR-002: The system stores session tokens in HttpOnly cookies.",
      "- FR-003: The system signs the user out after 30 minutes of inactivity.",
    ],
    acceptance_criteria: [
      "- AC-001: A user with valid Google credentials can sign in.",
      "- AC-002: A user with invalid credentials sees an error message.",
      "- AC-003: `grep -c FAILED report.txt` prints 0 with exit code 0.",
    ],
    technical_specification: [
      "We use ports-and-adapters architecture. The OAuth domain port is",
      "implemented by Google and GitHub adapters at the infrastructure layer.",
    ],
    security_considerations: ["All session tokens use AES-256-GCM. Authentication uses OAuth 2.0."],
    performance_requirements: ["p95 < 250ms for token validation under nominal load."],
    testing: ["Every acceptance criterion has one automated test."],
    risks: ["- The identity provider outage is a risk for every sign-in."],
    deployment: ["The release is rolled out behind a feature flag."],
  };
  return Object.entries(claimLines).map(([type, lines]) => {
    const head = `## ${type}\n\n${lines.join("\n")}\n\n`;
    return { type, content: head + filler(type, perSection - head.length) };
  });
}

/**
 * A `user_stories` section of 1,500 stories that each depend on themselves:
 * one violation per story. 111,169 chars; `validate_prd_section` returned
 * 487,789 chars for it before the report was paged (measured 2026-11-13).
 */
export const SELF_DEPENDENT_STORIES = Array.from(
  { length: 1_500 },
  (_, i) => `- STORY-${i}: as a user I want ${i} — ${i % 7} SP. Depends On: STORY-${i}, FR-${9_000 + i}`,
).join("\n");

/**
 * A section of 4,000 inline-code references to symbols no graph entry
 * resolves. 78,889 chars; `validate_prd_section` returned 332,597 chars for
 * it with an empty `known_symbols` before the report was paged (measured
 * 2026-11-13).
 */
export const UNRESOLVED_SYMBOL_REFERENCES =
  "## Tech\n\n" + Array.from({ length: 4_000 }, (_, i) => `\`Service${i}.run()\``).join(" ");
