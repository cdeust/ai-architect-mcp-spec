/**
 * `consistent_control_names` (#118): an acceptance criterion that names a
 * control by a name no requirement uses ("Clone control" for the "Copy
 * button") checks a control no requirement defines; it is a blocking,
 * non-critical finding of the document check.
 */
import { describe, it, expect } from "vitest";
import { isBlockingViolation, type SectionType } from "@prd-gen/core";
import { validateDocument } from "../index.js";
import { namedControlsIn } from "../hard-output-rules/rules/control-name-rules.js";

const findings = (sections: ReadonlyArray<{ type: SectionType; content: string }>) =>
  validateDocument(sections).violations.filter((v) => v.rule === "consistent_control_names");

const doc = (requirements: string, criteria: string) => [
  { type: "requirements" as const, content: `## Requirements\n\n${requirements}` },
  { type: "acceptance_criteria" as const, content: `## Acceptance Criteria\n\n${criteria}` },
];

const messageOf = (requirements: string, criteria: string): string | undefined =>
  findings(doc(requirements, criteria))[0]?.message;

const COPY_FR = "- FR-001: Each code block shows a Copy button in its top-right corner.";

describe("consistent_control_names (#118)", () => {
  it("reports a criterion that names a control no requirement names, blocking but not critical", () => {
    const [finding, ...rest] = findings(doc(COPY_FR, "- AC-001 (FR-001): Every code block has exactly one Clone control."));
    expect(rest).toEqual([]);
    expect(finding?.message).toBe(
      '1 acceptance criterion(s) name a control no requirement names: AC-001 ("Clone control")',
    );
    expect(finding !== undefined && isBlockingViolation(finding)).toBe(true);
    expect(finding?.isCritical).toBe(false);
  });

  it("accepts the requirement's name in any case and with another control noun", () => {
    expect(messageOf(COPY_FR, "- AC-001: Every code block has exactly one Copy button.")).toBeUndefined();
    expect(messageOf(COPY_FR, "- AC-001: Every code block has exactly one COPY Button.")).toBeUndefined();
    expect(messageOf(COPY_FR, "- AC-001: The Copy control sits in the top-right corner.")).toBeUndefined();
  });

  it("reports nothing when no requirement names a control: there is no term to differ from", () => {
    expect(messageOf("- FR-001: Clicking copies the code to the clipboard.", "- AC-001: The Clone control copies the code.")).toBeUndefined();
  });

  it("does not read a determiner as a name, in English or French", () => {
    expect(namedControlsIn("The button and each link, then the Copy button.").map((c) => c.key)).toEqual(["copy"]);
    expect(namedControlsIn("Le menu Fichier contient le bouton Copier.").map((c) => c.key)).toEqual(["fichier", "copier"]);
  });

  it("reads quoted names and French names after the noun", () => {
    expect(namedControlsIn('A "Copy" button and a bouton « Copier ».').map((c) => c.key)).toEqual(["copy", "copier"]);
    expect(messageOf("- FR-001: Chaque bloc affiche un bouton Copier.", "- AC-001: Le bouton Cloner copie le texte.")).toBe(
      '1 acceptance criterion(s) name a control no requirement names: AC-001 ("bouton Cloner")',
    );
  });

  it("does not read a code span, a lowercase word or a hyphenated word as a name", () => {
    expect(namedControlsIn("Press `Clone button` or the copy button or a Copy-to-clipboard button.")).toEqual([]);
  });

  it("reads table rows, headings and bold lines, and names each criterion once", () => {
    const criteria = [
      "| ID | Criterion |",
      "|----|-----------|",
      "| AC-001 | The Share link opens a dialog, and the Clone button too. |",
      "| AC-002 | The Copy button reads Copied. |",
      "",
      "### AC-003: Export",
      "",
      "The Export icon downloads the file.",
      "",
      "**AC-004** The Copy button stays visible.",
    ].join("\n");
    expect(messageOf(COPY_FR, criteria)).toBe(
      '2 acceptance criterion(s) name a control no requirement names: AC-001 ("Share link"), AC-003 ("Export icon")',
    );
  });

  it("collects the requirement names across sections and NFR definitions", () => {
    const sections = [
      { type: "requirements" as const, content: COPY_FR },
      { type: "technical_specification" as const, content: "- NFR-001: The Share link loads in under 200 ms." },
      { type: "acceptance_criteria" as const, content: "- AC-001: The Share link and the Copy button are visible." },
    ];
    expect(findings(sections)).toEqual([]);
  });
});
