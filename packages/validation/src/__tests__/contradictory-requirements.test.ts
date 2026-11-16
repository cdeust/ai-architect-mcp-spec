/**
 * `contradictory_requirements` (#118): two requirements that state the same
 * thing with a different quantity cannot both hold; the later one is a
 * blocking, non-critical finding of the document check.
 */
import { describe, it, expect } from "vitest";
import { isBlockingViolation } from "@prd-gen/core";
import { validateDocument } from "../index.js";
import { digitsValue, splitGlued, unitOf } from "../hard-output-rules/rules/contradictory-requirement-rules.js";

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
    expect(["supports", "checks", "ans"].map(unitOf)).toEqual([null, null, "ans"]);
  });

  // Review 1 of #318, note 1: a count noun, a verb or a word of the other
  // language after a naming number made two different things a contradiction.
  it("does not read a count noun, a verb or a word of the other language as a unit", () => {
    expect(["users", "files", "steps", "rows", "times", "attempts", "clicks", "requests", "to", "go", "an", "o"].map(unitOf)).toEqual(
      Array(12).fill(null),
    );
    expect(
      messageOf(
        table(
          "| FR-001 | Tier 1 users can export CSV. | Must | Pricing |",
          "| FR-002 | Tier 2 users can export CSV. | Must | Pricing |",
          "| FR-003 | Version 1 to 3 data is migrated. | Must | Data |",
          "| FR-004 | Version 2 to 3 data is migrated. | Must | Data |",
          "| FR-005 | Step 1 times out when idle. | Must | Flow |",
          "| FR-006 | Step 2 times out when idle. | Must | Flow |",
        ),
      ),
    ).toBe(undefined);
  });

  // Review 1 of #318, note 1: only the first comma was replaced, so 1,000 read as 1
  // and every 1,000,000-style number as NaN, all equal to each other.
  it("reads a thousands separator, a decimal mark, and keeps a form it cannot read as its own value", () => {
    expect(["1,000", "1000", "1,000,000", "1.000.000", "1,000.5", "1.000,5", "1,5", "1.5", "2.25", "1.2.3"].map(digitsValue)).toEqual([
      "1000", "1000", "1000000", "1000000", "1000.5", "1000.5", "1.5", "1.5", "2.25", "1.2.3",
    ]);
    expect(
      messageOf(
        table(
          "| FR-001 | A request completes in 1,000 ms. | Must | SLO |",
          "| FR-002 | A request completes in 1000 ms. | Must | SLO |",
          "| NFR-001 | The archive holds 1,000,000 MB. | Must | Capacity |",
          "| NFR-002 | The archive holds 2,000,000 MB. | Must | Capacity |",
        ),
      ),
    ).toBe('1 requirement(s) state a quantity an earlier requirement states differently: NFR-002 ("2,000,000", against NFR-001: "1,000,000")');
  });

  // Review 1 of #318, note 2: a value already met hid every later requirement that stated it.
  it("reports every later requirement that contradicts the first, after a reused identifier or a reported one", () => {
    expect(
      messageOf(
        table(
          "| FR-001 | A session expires after 30 minutes. | Must | Security |",
          "| FR-001 | A session expires after 60 minutes. | Must | Security |",
          "| FR-002 | A session expires after 60 minutes. | Must | Security |",
        ),
      ),
    ).toBe('1 requirement(s) state a quantity an earlier requirement states differently: FR-002 ("60", against FR-001: "30")');
    expect(
      messageOf(
        table(
          "| FR-001 | A session expires after 30 minutes. | Must | Security |",
          "| FR-002 | A session expires after 60 minutes. | Must | Security |",
          "| FR-003 | A session expires after 60 minutes. | Must | Security |",
        ),
      ),
    ).toBe(
      "2 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("60", against FR-001: "30"), FR-003 ("60", against FR-001: "30")',
    );
  });

  // Review 1 of #318, note 2: a spelling had no length cap in the message.
  it("cuts a long spelling in the message", () => {
    const long = "9".repeat(200);
    expect(
      messageOf(table("| FR-001 | A job runs for 1 s. | Must | Ops |", `| FR-002 | A job runs for ${long} s. | Must | Ops |`)),
    ).toBe(`1 requirement(s) state a quantity an earlier requirement states differently: FR-002 ("${"9".repeat(24)}…", against FR-001: "1")`);
  });

  // Review 1 of #319, note 2: a leading 0 read `,250` as a group of thousands.
  it("reads a comma after a leading 0 as a decimal mark", () => {
    expect(["0,250", "0,25", "0,001", "0.250", "00,500"].map(digitsValue)).toEqual(["0.25", "0.25", "0.001", "0.25", "0.5"]);
    expect(
      messageOf(
        table(
          "| FR-001 | La réponse arrive en 0,250 seconde. | Must | SLO |",
          "| FR-002 | La réponse arrive en 0,25 seconde. | Must | SLO |",
          "| FR-003 | Le délai est de 0,001 seconde. | Must | SLO |",
          "| FR-004 | Le délai est de 1 seconde. | Must | SLO |",
        ),
      ),
    ).toBe('1 requirement(s) state a quantity an earlier requirement states differently: FR-004 ("1", against FR-003: "0,001")');
  });

  // Review 1 of #319, note 3: `B2B` was cut into `B`, `2`, `B`, so the `B`
  // after a naming number read as bytes.
  it("reads a word that holds digits as one word, and a unit glued to a number", () => {
    expect(["10MB", "200ms", "5s", "3h", "1b", "2a", "3D", "2nd", "1,000ms", "7"].map(splitGlued)).toEqual([
      { number: "10", unit: "mb" },
      { number: "200", unit: "ms" },
      { number: "5", unit: "s" },
      { number: "3", unit: "h" },
      null,
      null,
      null,
      null,
      { number: "1,000", unit: "ms" },
      { number: "7", unit: null },
    ]);
    expect(
      messageOf(
        table(
          "| FR-001 | Tier 1 B2B customers can export CSV. | Must | Pricing |",
          "| FR-002 | Tier 2 B2B customers can export CSV. | Must | Pricing |",
          "| FR-003 | Phase 1b ships the export. | Must | Plan |",
          "| FR-004 | Phase 2b ships the export. | Must | Plan |",
          "| FR-005 | The v2 API is kept for 2 years. | Must | Support |",
          "| FR-006 | The v3 API is kept for 2 years. | Must | Support |",
        ),
      ),
    ).toBe(undefined);
    expect(
      messageOf(
        table(
          "| FR-001 | Uploads up to 10MB are accepted. | Must | Limits |",
          "| FR-002 | Uploads up to 25 MB are accepted. | Must | Limits |",
          "| FR-003 | A retry waits 5s. | Must | Ops |",
          "| FR-004 | A retry waits 30 s. | Must | Ops |",
        ),
      ),
    ).toBe(
      "2 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("25", against FR-001: "10"), FR-004 ("30", against FR-003: "5")',
    );
  });
});
