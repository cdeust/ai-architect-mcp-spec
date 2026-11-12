/**
 * Regression fixtures for issue #117: lexicon checks judge vocabulary, not
 * applicability.
 *
 * A correct PRD for a client-side feature (a copy-to-clipboard button) has no
 * server, no stored data and no authentication, so it says nothing about rate
 * limiting, consent, erasure or TLS. Before #117 it scored 0.00 with dozens of
 * critical violations, all from lexicon thresholds, and the pipeline retried
 * on them. The lexicon findings are now advisory (reported, no penalty, never
 * critical, no retry); only findings of a defect that is present stay
 * blocking.
 *
 * Two fixtures:
 *   - CLIENT_SIDE_PRD must pass: no blocking violation, score 1.00.
 *   - the same PRD with seeded structural defects must fail on exactly the
 *     rules those defects break.
 */
import { describe, it, expect } from "vitest";
import { isBlockingViolation, type SectionType } from "@prd-gen/core";
import { validateDocument, validateSection } from "../index.js";

type Section = { type: SectionType; content: string };

const CLIENT_SIDE_PRD: readonly Section[] = [
  {
    type: "overview",
    content: `## Overview

Add a "Copy" button next to every code block in the documentation viewer.
Clicking it copies the code block's text to the system clipboard and shows a
"Copied" confirmation for two seconds. The feature runs entirely in the
browser: no request leaves the page and nothing is stored.`,
  },
  {
    type: "requirements",
    content: `## Requirements

| ID | Requirement | Priority | Source |
|----|-------------|----------|--------|
| FR-001 | Each code block shows a Copy button in its top-right corner. | Must | Reader survey |
| FR-002 | Clicking Copy writes the block's plain text to the clipboard. | Must | Reader survey |
| FR-003 | After a successful copy the button reads "Copied" for two seconds. | Should | Design review |`,
  },
  {
    type: "user_stories",
    content: `## User Stories

- STORY-1: As a reader, I copy a code sample in one click so that I can paste it into my terminal. (FR-001, FR-002) — 2 SP
- STORY-2: As a reader, I see that the copy worked so that I do not copy twice. (FR-003) — 1 SP`,
  },
  {
    type: "acceptance_criteria",
    content: `## Acceptance Criteria

- AC-001 (FR-001): Every rendered code block has exactly one Copy button.
- AC-002 (FR-002): After a click, the clipboard holds the block's text, without line numbers.
- AC-003 (FR-003): The label reads "Copied" for two seconds, then "Copy" again.`,
  },
  {
    type: "testing",
    content: `## Testing

| Test | Covers | Check |
|------|--------|-------|
| T-001 | AC-001 | Render a page with three code blocks; expect three Copy buttons. |
| T-002 | AC-002 | Click Copy on a numbered block; expect the clipboard text without line numbers. |
| T-003 | AC-003 | Click Copy with a fake timer; expect "Copied", then "Copy" after two seconds. |`,
  },
];

describe("client-side PRD regression fixture (#117)", () => {
  it("passes: no blocking violation and a full score", () => {
    const report = validateDocument(CLIENT_SIDE_PRD);
    const blocking = report.violations.filter(isBlockingViolation);
    expect(blocking.map((v) => `[${v.rule}] ${v.message}`)).toEqual([]);
    expect(report.hasCriticalViolations).toBe(false);
    expect(report.totalScore).toBe(1);
  });

  it("each section passes on its own: nothing would trigger a retry", () => {
    for (const section of CLIENT_SIDE_PRD) {
      const report = validateSection(section.content, section.type);
      expect(
        report.violations.filter(isBlockingViolation).map((v) => v.rule),
        section.type,
      ).toEqual([]);
    }
  });

  it("fails when structural defects are seeded", () => {
    const seeded: Section[] = CLIENT_SIDE_PRD.map((s) => {
      if (s.type === "requirements") {
        // Duplicate requirement identifier.
        return {
          ...s,
          content: `${s.content}\n| FR-002 | The button is keyboard reachable. | Must | Accessibility audit |`,
        };
      }
      if (s.type === "user_stories") {
        // A story that depends on itself.
        return {
          ...s,
          content: `${s.content}\n- STORY-3: depends on STORY-3. — 1 SP`,
        };
      }
      return s;
    });

    const report = validateDocument(seeded);
    const blockingRules = new Set(
      report.violations.filter(isBlockingViolation).map((v) => v.rule),
    );
    expect(blockingRules.has("duplicate_requirement_ids")).toBe(true);
    expect(blockingRules.has("no_self_referencing_deps")).toBe(true);
    expect(report.totalScore).toBeLessThan(1);
  });
});

describe("lexicon findings are advisory, defect findings stay blocking (#117)", () => {
  it("a technical specification without server vocabulary draws only advisory findings", () => {
    const content = `## Technical Specification

The button is a small UI component rendered beside each code block. On click
it reads the block's text and calls navigator.clipboard.writeText; on success
it swaps its label for two seconds.`;
    const report = validateSection(content, "technical_specification");
    // The lexicon still reports what it did not find…
    expect(report.violations.length).toBeGreaterThan(0);
    // …but none of it blocks, costs score or is critical.
    for (const v of report.violations) {
      expect(v.isAdvisory, v.rule).toBe(true);
      expect(v.isCritical, v.rule).toBe(false);
      expect(v.scorePenalty, v.rule).toBe(0);
    }
    expect(report.hasCriticalViolations).toBe(false);
    expect(report.totalScore).toBe(1);
  });

  it("a weak algorithm in a code example still blocks", () => {
    const content = [
      "## Technical Specification",
      "",
      "```ts",
      "const digest = MD5(password);",
      "```",
    ].join("\n");
    const report = validateSection(content, "technical_specification");
    const weak = report.violations.filter(
      (v) => v.rule === "cryptographic_standards" && v.offendingContent !== null,
    );
    expect(weak.length).toBeGreaterThan(0);
    for (const v of weak) {
      expect(isBlockingViolation(v)).toBe(true);
      expect(v.isCritical).toBe(true);
      expect(v.scorePenalty).toBeGreaterThan(0);
    }
  });
});
