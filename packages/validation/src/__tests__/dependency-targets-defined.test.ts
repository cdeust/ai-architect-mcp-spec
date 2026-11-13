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

  it("does not read a backtick line with a backtick in its info string as a fence", () => {
    // Review of #232: as in CommonMark, "```npm i``` installs" is a code span
    // in a paragraph. Read as a fence it opened a block that never closed and
    // hid the dependency below it.
    const section: Section = {
      type: "technical_specification",
      content: ["```npm i``` installs the tool.", "- STORY-1: depends on FR-404"].join("\n"),
    };
    expect(messages([section])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: FR-404",
    ]);
  });

  it("keeps the dependency column in place when a cell holds an escaped pipe", () => {
    const section: Section = {
      type: "requirements",
      content: [
        "| ID | Requirement | Priority | Depends On | Source |",
        "|----|-------------|----------|------------|--------|",
        "| FR-001 | Match a \\| b | High | FR-009 | User Request |",
      ].join("\n"),
    };
    expect(messages([section])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: FR-009",
    ]);
  });

  it("keeps a nested shorter or other fence inside the enclosing block", () => {
    const section: Section = {
      type: "technical_specification",
      content: [
        "````markdown",
        "```",
        "- STORY-1: depends on FR-404.",
        "```",
        "~~~",
        "- STORY-2: depends on FR-405.",
        "````",
        "- STORY-3: depends on FR-406.",
      ].join("\n"),
    };
    expect(messages([section])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: FR-406",
    ]);
  });

  it("accepts a bold line start and a plain or code-span cell of the ID column as definitions", () => {
    const sections: Section[] = [
      { type: "user_stories", content: "**STORY-1**: First story." },
      {
        type: "requirements",
        content: [
          "| # | ID | Requirement |",
          "|---|----|-------------|",
          "| 1 | FR-001 | Create |",
          "| 2 | `FR-002` | Search |",
        ].join("\n"),
      },
      { type: "timeline", content: "- STORY-2: depends on STORY-1, FR-001 and FR-002." },
    ];
    expect(messages(sections)).toEqual([]);
  });

  it("does not let a dependency cell define the identifier it names", () => {
    const section: Section = {
      type: "requirements",
      content: [
        "| # | Requirement | Depends On |",
        "|---|-------------|------------|",
        "| 1 | Search | FR-009 |",
      ].join("\n"),
    };
    expect(messages([section])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: FR-009",
    ]);
  });

  it("reads STORY-001 and STORY-1 as the same identifier", () => {
    const section: Section = {
      type: "user_stories",
      content: "- STORY-001: First story.\n- STORY-2: depends on STORY-1.",
    };
    expect(messages([section])).toEqual([]);
  });

  it("an unclosed fence ends with its section and hides no later section", () => {
    const sections: Section[] = [
      { type: "technical_specification", content: "```ts\nconst x = 1;" },
      { type: "user_stories", content: "- STORY-1: depends on STORY-9." },
    ];
    expect(messages(sections)).toEqual([
      "1 dependency target(s) are defined nowhere in the document: STORY-9",
    ]);
  });

  it("names at most twenty targets and counts the rest, without overflowing on a huge cell", () => {
    const ids = Array.from({ length: 200_000 }, (_, i) => `FR-${i + 100}`).join(", ");
    const section: Section = {
      type: "requirements",
      content: `| ID | Depends On |\n|----|------------|\n| FR-001 | ${ids} |`,
    };
    const [message] = messages([section]);
    expect(message).toMatch(/^200000 dependency target\(s\) are defined nowhere in the document: /);
    expect(message).toMatch(/ and 199980 more$/);
    expect(message!.split(", ")).toHaveLength(20);
  });

  it("skips a fenced block written with CRLF line endings", () => {
    const section: Section = {
      type: "technical_specification",
      content: "```ts\r\n// depends on FR-404\r\n```\r\n- STORY-1: depends on FR-405.\r\n",
    };
    expect(messages([section])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: FR-405",
    ]);
  });

  it("skips a fenced block nested in a list item with four-space indentation", () => {
    const section: Section = {
      type: "technical_specification",
      content: ["1. Example:", "", "    ```ts", "    // depends on FR-404", "    ```"].join("\n"),
    };
    expect(messages([section])).toEqual([]);
  });

  it("does not let a code-span target in a leading dependency column define itself", () => {
    const section: Section = {
      type: "requirements",
      content: [
        "| Depends On | ID | Requirement |",
        "|------------|----|-------------|",
        "| `FR-009` | FR-001 | Search |",
      ].join("\n"),
    };
    expect(messages([section])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: FR-009",
    ]);
  });

  it("reads every ID column as defining, so an Epic ID column ahead of Story ID does not hide the stories", () => {
    const section: Section = {
      type: "user_stories",
      content: [
        "| Epic ID | Story ID | Title | Depends On |",
        "|---------|----------|-------|------------|",
        "| EPIC-1 | STORY-1 | Create | — |",
        "| EPIC-1 | STORY-2 | Search | STORY-1 |",
        "| EPIC-1 | STORY-3 | Share | STORY-2, STORY-9 |",
      ].join("\n"),
    };
    expect(messages([section])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: STORY-9",
    ]);
  });

  it("defines nothing from a table whose first column is a dependency column and none is headed ID", () => {
    const section: Section = {
      type: "requirements",
      content: [
        "| Depends On | Requirement | Owner |",
        "|------------|-------------|-------|",
        "| FR-009 | Search | FR-001 |",
      ].join("\n"),
    };
    expect(messages([section])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: FR-009",
    ]);
  });

  it("does not count a bare identifier at a line start as a definition", () => {
    const section: Section = {
      type: "user_stories",
      content: "STORY-7 is deferred.\n- STORY-2: depends on STORY-7.",
    };
    expect(messages([section])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: STORY-7",
    ]);
  });

  it("does not count an identifier outside the ID column of a table as a definition", () => {
    const sections: Section[] = [
      {
        type: "timeline",
        content: ["| Sprint | Story |", "|--------|-------|", "| 1 | STORY-7 |"].join("\n"),
      },
      { type: "user_stories", content: "- STORY-2: depends on STORY-7." },
    ];
    expect(messages(sections)).toEqual([
      "1 dependency target(s) are defined nowhere in the document: STORY-7",
    ]);
  });

  it("counts STORY-07 and STORY-7 as one undefined target", () => {
    const section: Section = {
      type: "user_stories",
      content: "- STORY-1: depends on STORY-07.\n- STORY-2: depends on STORY-7.",
    };
    expect(messages([section])).toEqual([
      "1 dependency target(s) are defined nowhere in the document: STORY-07",
    ]);
  });

  it("does not read an identifier of more than nine digits, which Number() would round", () => {
    const section: Section = {
      type: "user_stories",
      content: `- STORY-1: depends on STORY-${"9".repeat(400)} and STORY-${"8".repeat(400)}.`,
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
