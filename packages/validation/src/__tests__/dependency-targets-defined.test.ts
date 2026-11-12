/**
 * dependency_targets_defined (#118): a dependency on an identifier the
 * document never defines is reported by the document check.
 */
import { describe, it, expect } from "vitest";
import type { SectionType } from "@prd-gen/core";
import { validateDocument } from "../index.js";
import { checkDocumentDependencyTargetsDefined } from "../hard-output-rules/rules/dependency-target-rules.js";

type Section = { type: SectionType; content: string };

const REQUIREMENTS_TABLE = (dependsOn: string): Section => ({
  type: "requirements",
  content: [
    "| ID | Requirement | Priority | Depends On | Source |",
    "|----|-------------|----------|------------|--------|",
    "| FR-001 | Create a snippet | High | — | User Request |",
    `| FR-002 | Search snippets | High | ${dependsOn} | User Request |`,
  ].join("\n"),
});

const messages = (sections: Section[]): string[] =>
  checkDocumentDependencyTargetsDefined(sections).map((v) => v.message);

describe("dependency_targets_defined", () => {
  it("passes when every table dependency is defined in the document", () => {
    expect(messages([REQUIREMENTS_TABLE("FR-001")])).toEqual([]);
  });

  it("reports a table dependency on an undefined identifier", () => {
    expect(messages([REQUIREMENTS_TABLE("FR-001, FR-009")])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: FR-009",
    ]);
  });

  it("reads only the dependency column, not the other cells of the row", () => {
    const section: Section = {
      type: "user_stories",
      content: [
        "| Story ID | Title | SP | Depends On | AC |",
        "|----------|-------|----|------------|----|",
        "| STORY-001 | Create form, see FR-042 | 3 | — | AC-001 |",
      ].join("\n"),
    };
    expect(messages([section])).toEqual([]);
  });

  it("reports a prose dependency on an undefined identifier", () => {
    const section: Section = {
      type: "user_stories",
      content: [
        "- STORY-1: As a reader, I copy a sample. — 2 SP",
        "- STORY-2: As a reader, I see the copy worked. Depends on STORY-7. — 1 SP",
      ].join("\n"),
    };
    expect(messages([section])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: STORY-7",
    ]);
  });

  it("reads 'blocked by' and stops the clause at the end of the sentence", () => {
    const section: Section = {
      type: "user_stories",
      content: [
        "- STORY-1: First story.",
        "- STORY-2: Blocked by STORY-1 and STORY-3. Mentions STORY-9 elsewhere.",
      ].join("\n"),
    };
    expect(messages([section])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: STORY-3",
    ]);
  });

  it("accepts a target defined in another section, as a heading or in bold", () => {
    const sections: Section[] = [
      { type: "requirements", content: "### FR-001\nCreate a snippet.\n\n1. **FR-002** Search." },
      { type: "user_stories", content: "- **STORY-1**: depends on FR-001 and FR-002." },
    ];
    expect(messages(sections)).toEqual([]);
  });

  it("does not count a mention as a definition", () => {
    const section: Section = {
      type: "user_stories",
      content: "- STORY-1: Mirrors STORY-4 of the old plan; depends on STORY-4.",
    };
    expect(messages([section])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: STORY-4",
    ]);
  });

  it("skips fenced blocks, which show proposed code", () => {
    const section: Section = {
      type: "technical_specification",
      content: "```\n// depends on FR-404\n```\n",
    };
    expect(messages([section])).toEqual([]);
  });

  it("lists each undefined target once, sorted", () => {
    const section: Section = {
      type: "user_stories",
      content: [
        "- STORY-1: depends on STORY-9 and STORY-8.",
        "- STORY-2: depends on STORY-9.",
      ].join("\n"),
    };
    expect(messages([section])).toEqual([
      "2 dependency target(s) are defined nowhere in the document: STORY-8, STORY-9",
    ]);
  });

  it("is a blocking document-level finding of validateDocument", () => {
    const report = validateDocument([REQUIREMENTS_TABLE("FR-009")]);
    const found = report.violations.filter((v) => v.rule === "dependency_targets_defined");
    expect(found).toHaveLength(1);
    expect(found[0]!.isCritical).toBe(true);
    expect(found[0]!.sectionType).toBeNull();
    expect(report.rulesChecked).toContain("dependency_targets_defined");
    expect(report.rulesPassed).not.toContain("dependency_targets_defined");
    expect(validateDocument([REQUIREMENTS_TABLE("FR-001")]).rulesPassed).toContain(
      "dependency_targets_defined",
    );
  });
});
