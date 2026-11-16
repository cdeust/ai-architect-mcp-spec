/**
 * `testable_acceptance_criteria` (#118): an acceptance criterion that states
 * how a person feels ("Readers love the confirmation.") names nothing a test
 * can observe; it is a blocking, non-critical finding of the document check.
 */
import { describe, it, expect } from "vitest";
import { isBlockingViolation } from "@prd-gen/core";
import { validateDocument } from "../index.js";
import { untestableTermIn } from "../hard-output-rules/rules/testable-acceptance-criteria-rules.js";
import { requirementDefinitions } from "../hard-output-rules/rules/requirement-definitions.js";

const findings = (content: string, type: "acceptance_criteria" | "requirements" = "acceptance_criteria") =>
  validateDocument([{ type, content }]).violations.filter((v) => v.rule === "testable_acceptance_criteria");

const messageOf = (content: string): string | undefined => findings(content)[0]?.message;

describe("testable_acceptance_criteria (#118)", () => {
  it("reports a list-item criterion that states a feeling, blocking but not critical", () => {
    const [finding, ...rest] = findings("## Acceptance Criteria\n\n- AC-001 (FR-001): Readers love the confirmation.");
    expect(rest).toEqual([]);
    expect(finding?.message).toBe(
      '1 acceptance criterion(s) state how a person feels, which no test can observe: AC-001 ("love")',
    );
    expect(finding !== undefined && isBlockingViolation(finding)).toBe(true);
    expect(finding?.isCritical).toBe(false);
  });

  it("reads table rows, headings and bold lines, and names each criterion once", () => {
    const content = [
      "| ID | Criterion |",
      "|----|-----------|",
      "| AC-001 | Users enjoy the new layout. |",
      "| AC-002 | The page shows 20 results. |",
      "",
      "### AC-003: Onboarding",
      "",
      "Admins are delighted by the wizard, and they appreciate it.",
      "",
      "**AC-004** Les lecteurs adorent le bouton.",
    ].join("\n");
    expect(messageOf(content)).toBe(
      '3 acceptance criterion(s) state how a person feels, which no test can observe: AC-001 ("enjoy"), AC-003 ("delighted"), AC-004 ("adorent")',
    );
  });

  it("does not read a term in quoted text or a code span, or inside a longer word", () => {
    for (const text of [
      'The banner reads "We love feedback".',
      "The `onLoved` handler fires once.",
      "The glove icon is shown.",
      "The label reads « Les lecteurs adorent » in French.",
    ]) {
      expect(findings(`- AC-001: ${text}`), text).toEqual([]);
    }
  });

  it("leaves out words with a testable sense in a criterion", () => {
    for (const text of [
      "The happy path completes in one request.",
      "With prefers-reduced-motion, no animation plays.",
      "The condition is satisfied when the queue is empty.",
      "Buttons look like links.",
      "The look and feel matches the design file.",
    ]) {
      expect(untestableTermIn(text), text).toBeNull();
      expect(findings(`- AC-001: ${text}`), text).toEqual([]);
    }
  });

  it("reads acceptance criteria in any section, and nothing but acceptance criteria", () => {
    expect(findings("- AC-001: Readers love it.", "requirements")).toHaveLength(1);
    expect(findings("- FR-001: Readers love it.\n- STORY-1: Readers love it.")).toEqual([]);
  });

  it("does not read a fenced block", () => {
    expect(findings("```\n- AC-001: Readers love it.\n```")).toEqual([]);
  });

  it("leaves the requirement reader as it was: an AC line does not end an FR definition", () => {
    // A bold AC line is a definition form: read with the AC prefix it ends
    // the FR text, so the default reader keeping it in FR-001 is a real check.
    const content = "- FR-001: Search must be fast\n  **AC-001** within 200 ms.";
    expect(requirementDefinitions(content)).toEqual([
      { id: "FR-001", text: ": Search must be fast\n**AC-001** within 200 ms." },
    ]);
    expect(requirementDefinitions(content, ["FR", "AC"])).toEqual([
      { id: "FR-001", text: ": Search must be fast" },
      { id: "AC-001", text: " within 200 ms." },
    ]);
  });

  it("does not read the French Like reaction \"J'aime\" as a feeling, but reads other elisions", () => {
    for (const text of [
      "Le bouton J'aime incrémente le compteur de 1.",
      "Le bouton j\u2019adore s'affiche sous la photo.",
    ]) {
      expect(untestableTermIn(text), text).toBeNull();
      expect(findings(`- AC-1: ${text}`), text).toEqual([]);
    }
    expect(untestableTermIn("Les lecteurs l'adorent.")).toBe("adorent");
    expect(untestableTermIn("Les lecteurs l\u2019apprécient.")).toBe("apprécient");
  });

  it("refuses an identifier prefix that is not upper-case letters", () => {
    expect(() => requirementDefinitions("x", ["A|B"])).toThrow(/invalid identifier prefixes/);
  });
});
