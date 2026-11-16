/**
 * `contradictory_requirements` (#118): two requirements that state the same
 * thing with a different quantity cannot both hold; the later one is a
 * blocking, non-critical finding of the document check.
 */
import { describe, it, expect } from "vitest";
import { isBlockingViolation } from "@prd-gen/core";
import { validateDocument } from "../index.js";
import { unitOf } from "../hard-output-rules/rules/contradictory-requirement-rules.js";

type Sections = ReadonlyArray<{ type: "requirements" | "user_stories"; content: string }>;

const findings = (sections: Sections) =>
  validateDocument(sections).violations.filter((v) => v.rule === "contradictory_requirements");

const table = (...rows: string[]): string =>
  ["| ID | Requirement | Priority | Source |", "|----|-------------|----------|--------|", ...rows].join("\n");

const messageOf = (content: string): string | undefined =>
  findings([{ type: "requirements", content }])[0]?.message;

describe("contradictory_requirements (#118)", () => {
  it("reports a table row that states a quantity an earlier row states differently, blocking but not critical", () => {
    const [finding, ...rest] = findings([
      {
        type: "requirements",
        content: table(
          '| FR-003 | After a successful copy the button reads "Copied" for two seconds. | Should | Design review |',
          '| FR-004 | After a successful copy the button reads "Copied" for five seconds. | Must | Survey |',
        ),
      },
    ]);
    expect(rest).toEqual([]);
    expect(finding?.message).toBe(
      '1 requirement(s) state a quantity an earlier requirement states differently: FR-004 ("five", against FR-003: "two")',
    );
    expect(finding !== undefined && isBlockingViolation(finding)).toBe(true);
    expect(finding?.isCritical).toBe(false);
  });

  it("compares list items across sections, in digits and words, singular and plural units, EN and FR", () => {
    expect(
      findings([
        { type: "requirements", content: "- FR-001: Uploads up to 10 MB are accepted.\n- FR-002: The link expires after one hour." },
        {
          type: "user_stories",
          content: [
            "- NFR-001: Uploads up to 25 MB are accepted.",
            "- NFR-002: The link expires after 3 hours.",
            "- NFR-003: Le lien expire après 24 heures.",
            "- NFR-004: Le lien expire après quarante heures.",
          ].join("\n"),
        },
      ])[0]?.message,
    ).toBe(
      "3 requirement(s) state a quantity an earlier requirement states differently: " +
        'NFR-001 ("25", against FR-001: "10"), NFR-002 ("3", against FR-002: "one"), NFR-004 ("quarante", against NFR-003: "24")',
    );
  });

  it("does not report the same value spelled twice, a restatement, or a different wording", () => {
    for (const second of [
      "| FR-002 | The label reads Copied for 2 seconds. | Must | Survey |",
      "| FR-002 | The label reads Copied for two seconds. | Must | Survey |",
      "| FR-002 | The label reads Copied during five seconds. | Must | Survey |",
    ]) {
      expect(messageOf(table("| FR-001 | The label reads Copied for two seconds. | Should | Review |", second)), second).toBe(
        undefined,
      );
    }
  });

  it("does not report statements that differ in a number that names rather than measures", () => {
    expect(
      messageOf(
        table(
          "| FR-001 | Tier 1 supports 10 users. | Must | Pricing |",
          "| FR-002 | Tier 2 supports 50 users. | Must | Pricing |",
          "| FR-003 | Step 1 runs FR-001 checks. | Must | Flow |",
          "| FR-004 | Step 2 runs FR-002 checks. | Must | Flow |",
        ),
      ),
    ).toBe(undefined);
  });

  it("leaves a reused identifier to duplicate_requirement_ids and names each requirement once", () => {
    expect(
      messageOf(
        table(
          "| FR-001 | A session expires after 30 minutes. | Must | Security |",
          "| FR-001 | A session expires after 60 minutes. | Must | Security |",
        ),
      ),
    ).toBe(undefined);
    expect(
      messageOf(
        table(
          "| FR-001 | A session expires after 30 minutes. | Must | Security |",
          "| FR-002 | A session expires after 60 minutes. | Must | Security |",
          "| FR-002 | A session expires after 90 minutes. | Must | Security |",
          "| FR-003 | A session expires after 30 minutes. | Must | Security |",
        ),
      ),
    ).toBe('1 requirement(s) state a quantity an earlier requirement states differently: FR-002 ("60", against FR-001: "30")');
  });

  it("reads a unit in the singular, its plural by the final s, and listed forms that end in s", () => {
    expect(["seconds", "second", "secondes", "ms", "mois", "fois", "%", "MB"].map(unitOf)).toEqual([
      "second",
      "second",
      "seconde",
      "ms",
      "mois",
      "fois",
      "%",
      "mb",
    ]);
    expect(["supports", "checks", "users"].map(unitOf)).toEqual([null, null, "user"]);
  });
});
