/**
 * `contradictory_requirements` (#118): two requirements that state the same
 * thing with a different quantity cannot both hold; the later one is a
 * blocking, non-critical finding of the document check.
 */
import { describe, it, expect } from "vitest";
import { isBlockingViolation } from "@prd-gen/core";
import { validateDocument } from "../index.js";
import { cutStatement, digitsValue, splitGlued, unitOf } from "../hard-output-rules/rules/contradictory-requirement-rules.js";
import { folded } from "../hard-output-rules/rules/minute-digits.js";

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
    // Review 1 of #320, note 1: with two kinds of separator, the first after a leading 0 grouped thousands.
    expect(["0,250.5", "0.250,5", "00,250.5", "1,000.5", "1.000,5"].map(digitsValue)).toEqual(["0,250.5", "0.250,5", "00,250.5", "1000.5", "1000.5"]);
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
      { numbers: ["10"], after: ["mb"] },
      { numbers: ["200"], after: ["ms"] },
      { numbers: ["5"], after: ["s"] },
      { numbers: ["3"], after: ["h"] },
      null,
      null,
      null,
      null,
      { numbers: ["1,000"], after: ["ms"] },
      { numbers: ["7"], after: [null] },
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

  // Review 1 of #320, note 1: `0,250.5` read as 250.5, so it equalled `250.5`.
  it("does not read a leading 0 followed by two kinds of separator as a number", () => {
    expect(
      messageOf(
        table(
          "| FR-001 | A probe answers in 0,250.5 ms. | Must | SLO |",
          "| FR-002 | A probe answers in 250.5 ms. | Must | SLO |",
        ),
      ),
    ).toBe('1 requirement(s) state a quantity an earlier requirement states differently: FR-002 ("250.5", against FR-001: "0,250.5")');
  });

  // Review 1 of #320, note 2: `2h30` was one word since #320, so two durations
  // written that way were no longer compared.
  it("reads an hour-and-minute duration glued as one token", () => {
    expect(["2h30", "10h30", "1h30m", "1h30min", "1a30", "1b30"].map(splitGlued)).toEqual([
      { numbers: ["2", "30"], after: ["h", null] },
      { numbers: ["10", "30"], after: ["h", null] },
      { numbers: ["1", "30"], after: ["h", "m"] },
      { numbers: ["1", "30"], after: ["h", "min"] },
      null,
      null,
    ]);
    expect(
      messageOf(
        table(
          "| FR-001 | La sauvegarde dure 2h30. | Must | Ops |",
          "| FR-002 | La sauvegarde dure 3h30. | Must | Ops |",
          "| FR-003 | The export runs for 2h30. | Must | Ops |",
          "| FR-004 | The export runs for 2h45. | Must | Ops |",
          "| FR-005 | A replay lasts 1h30m. | Must | Ops |",
          "| FR-006 | A replay lasts 1h45m. | Must | Ops |",
          "| FR-007 | Release 1b30 ships the export. | Must | Plan |",
          "| FR-008 | Release 1b45 ships the export. | Must | Plan |",
        ),
      ),
    ).toBe(
      "3 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("3", against FR-001: "2"), FR-004 ("45", against FR-003: "30"), FR-006 ("45", against FR-005: "30")',
    );
  });

  // Review 1 of #320, note 3: the glued line was always first, and only the
  // later requirement's units decide, so the glued path decided nothing.
  it("reports a glued unit on the later requirement", () => {
    expect(
      messageOf(
        table(
          "| FR-001 | Uploads up to 25 MB are accepted. | Must | Limits |",
          "| FR-002 | Uploads up to 10MB are accepted. | Must | Limits |",
          "| FR-003 | A retry waits 30 s. | Must | Ops |",
          "| FR-004 | A retry waits 5s. | Must | Ops |",
        ),
      ),
    ).toBe(
      "2 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("10", against FR-001: "25"), FR-004 ("5", against FR-003: "30")',
    );
  });

  // Review 1 of #321, note 1: only the glued form measured its minutes, and
  // only the later requirement's measures were read, so the finding depended
  // on which form came first.
  it("measures the minutes of a spaced or glued duration in either order", () => {
    expect(cutStatement("dure 2 h 30.").measured).toEqual([true, true]);
    expect(cutStatement("dure 1 h 30 m.").measured).toEqual([true, true]);
    expect(
      messageOf(
        table(
          "| FR-001 | The export runs for 2 h 30. | Must | Ops |",
          "| FR-002 | The export runs for 2h45. | Must | Ops |",
          "| FR-003 | A replay lasts 1h30. | Must | Ops |",
          "| FR-004 | A replay lasts 1 h 45. | Must | Ops |",
          "| FR-005 | A backup lasts 1 h 30 m. | Must | Ops |",
          "| FR-006 | A backup lasts 1h45m. | Must | Ops |",
        ),
      ),
    ).toBe(
      "3 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("45", against FR-001: "30"), FR-004 ("45", against FR-003: "30"), FR-006 ("45", against FR-005: "30")',
    );
  });

  // Review 2 of #322, notes 1 and 2: any number after a spaced hour was read
  // as minutes, so a count after an hour was a quantity, and a one-digit
  // spaced minute was measured where its glued form is a word.
  it("reads a number after a spaced hour as minutes only with the bounds of a glued duration", () => {
    expect(cutStatement("Within 1 hour 10 users are notified.").measured).toEqual([true, false]);
    expect(cutStatement("dure 2 h 5.").measured).toEqual([true, false]);
    expect(cutStatement("dure 2 h 5 min.").measured).toEqual([true, true]);
    expect(cutStatement("dure 2 h 30, puis s'arrête.").measured).toEqual([true, true]);
    expect(cutStatement("dure 2 h 30 m").measured).toEqual([true, true]);
    expect(cutStatement("dure deux heures trente.").measured).toEqual([true, true]);
    expect(cutStatement("dure 2 h 30 45.").measured).toEqual([true, false, false]);
    expect(
      messageOf(
        table(
          "| FR-001 | Within 1 hour 10 users are notified. | Must | Ops |",
          "| FR-002 | Within 1 hour 50 users are notified. | Must | Ops |",
          "| FR-003 | The export runs for 2 h 5. | Must | Ops |",
          "| FR-004 | The export runs for 2 h 7. | Must | Ops |",
          "| FR-005 | The export runs for 2h5. | Must | Ops |",
          "| FR-006 | The export runs for 2h7. | Must | Ops |",
          "| FR-007 | A replay lasts 1 h 30, then stops. | Must | Ops |",
          "| FR-008 | A replay lasts 1h45, then stops. | Must | Ops |",
          "| FR-009 | A backup lasts 2 h 5 min. | Must | Ops |",
          "| FR-010 | A backup lasts 2 h 7 min. | Must | Ops |",
        ),
      ),
    ).toBe(
      "2 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-008 ("45", against FR-007: "30"), FR-010 ("7", against FR-009: "5")',
    );
  });

  // Codex review of #329, two P2: only the later requirement's measures were
  // read, so `2 h 5` then `2 h 30` was reported and the reverse was not; and a
  // glued duration followed by a word lost the minutes `splitGlued` had read.
  it("reads the measures of both requirements and keeps the minutes of a glued duration before a word", () => {
    expect(cutStatement("The export lasts 2h30 before stopping.").measured).toEqual([true, true]);
    expect(cutStatement("The export lasts 2 h 30 before stopping.").measured).toEqual([true, false]);
    expect(
      messageOf(
        table(
          "| FR-001 | The export lasts 2 h 5. | Must | Ops |",
          "| FR-002 | The export lasts 2 h 30. | Must | Ops |",
          "| FR-003 | A replay lasts 1 h 30. | Must | Ops |",
          "| FR-004 | A replay lasts 1 h 5. | Must | Ops |",
          "| FR-005 | A backup lasts 2h30 before stopping. | Must | Ops |",
          "| FR-006 | A backup lasts 2h45 before stopping. | Must | Ops |",
          "| FR-007 | A sync lasts 3 h 30 before stopping. | Must | Ops |",
          "| FR-008 | A sync lasts 3h45 before stopping. | Must | Ops |",
        ),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-006 ("45", against FR-005: "30")',
    );
  });

  // Review 1 of #329, note 3: a one-digit number word counted minutes, where
  // its digits do not.
  it("reads a number word as minutes only from 10 to 59, as two digits", () => {
    expect(cutStatement("dure deux heures cinq.").measured).toEqual([true, false]);
    expect(cutStatement("dure deux heures dix.").measured).toEqual([true, true]);
    expect(cutStatement("dure deux heures soixante.").measured).toEqual([true, false]);
    expect(
      messageOf(
        table(
          "| FR-001 | The export runs for 2 hours five. | Must | Ops |",
          "| FR-002 | The export runs for 2 hours seven. | Must | Ops |",
          "| FR-003 | La sauvegarde dure deux heures trente. | Must | Ops |",
          "| FR-004 | La sauvegarde dure deux heures quinze. | Must | Ops |",
        ),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-004 ("quinze", against FR-003: "trente")',
    );
  });

  // Review 1 of #321, note 2: any later number glued after a unit was read,
  // so a half-year, a semester or a cell layout was a quantity again.
  it("reads a later glued number only as the two-digit minutes of an hour", () => {
    expect(["2024H1", "2025S1", "4s2p", "2h5", "2h30s", "2h30x", "1h30m5", "2h60", "2h75"].map(splitGlued)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(
      messageOf(
        table(
          "| FR-001 | The report covers 2024H1. | Must | Plan |",
          "| FR-002 | The report covers 2024H2. | Must | Plan |",
          "| FR-003 | Courses open in 2025S1. | Must | Plan |",
          "| FR-004 | Courses open in 2025S2. | Must | Plan |",
          "| FR-005 | The pack is wired 4s2p. | Must | Hardware |",
          "| FR-006 | The pack is wired 4s3p. | Must | Hardware |",
        ),
      ),
    ).toBe(undefined);
  });

  // Review 1 of #330, note 1: each requirement was compared with the first of
  // its form only, so a first one that did not measure its minutes hid every
  // later contradiction of those minutes.
  it("compares a requirement with the first of its form that measures the same numbers, and the first that measures all", () => {
    expect(
      messageOf(
        table(
          "| FR-001 | The export lasts 2 h 5. | Must | Ops |",
          "| FR-002 | The export lasts 2 h 30. | Must | Ops |",
          "| FR-003 | The export lasts 2 h 45. | Must | Ops |",
          "| FR-004 | A sync lasts 3 h 30 before stopping. | Must | Ops |",
          "| FR-005 | A sync lasts 3h45 before stopping. | Must | Ops |",
          "| FR-006 | A sync lasts 4 h 45 before stopping. | Must | Ops |",
          "| FR-007 | A backup lasts 1 h 5. | Must | Ops |",
          "| FR-008 | A backup lasts 1 h 30. | Must | Ops |",
          "| FR-009 | A backup lasts 2 h 5. | Must | Ops |",
          "| FR-010 | A scan lasts 2h30 before stopping. | Must | Ops |",
          "| FR-011 | A scan lasts 2 h 45 before stopping. | Must | Ops |",
          "| FR-012 | A scan lasts 3 h 45 before stopping. | Must | Ops |",
        ),
      ),
    ).toBe(
      "4 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-003 ("45", against FR-002: "30"), FR-006 ("4", against FR-005: "3"), FR-009 ("2", against FR-007: "1"), ' +
        'FR-012 ("3", against FR-011: "2")',
    );
    // A requirement that agrees with every reference it is compared with is not reported.
    expect(
      messageOf(
        table(
          "| FR-001 | The export lasts 2 h 5. | Must | Ops |",
          "| FR-002 | The export lasts 2 h 30. | Must | Ops |",
          "| FR-003 | The export lasts 2 h 7. | Must | Ops |",
        ),
      ),
    ).toBe(undefined);
  });

  // Review 1 of #330, note 2: two digits up to 99 counted minutes, where a
  // number word counted them only up to 59.
  it("reads two digits as minutes only from 00 to 59, as a number word", () => {
    expect(cutStatement("dure 2 h 59.").measured).toEqual([true, true]);
    expect(cutStatement("dure 2 h 05.").measured).toEqual([true, true]);
    expect(cutStatement("dure 2 h 60.").measured).toEqual([true, false]);
    expect(cutStatement("dure 2 hours sixty.").measured).toEqual([true, false]);
    expect(splitGlued("2h59")).toEqual({ numbers: ["2", "59"], after: ["h", null] });
    expect(
      messageOf(
        table(
          "| FR-001 | The export runs for 2 h 60. | Must | Ops |",
          "| FR-002 | The export runs for 2 h 75. | Must | Ops |",
          "| FR-003 | The export runs for 2h60. | Must | Ops |",
          "| FR-004 | The export runs for 2h75. | Must | Ops |",
          "| FR-005 | The export runs for 2 hours sixty. | Must | Ops |",
          "| FR-006 | The export runs for 2 hours seventy. | Must | Ops |",
          "| FR-007 | A replay lasts 1 h 50. | Must | Ops |",
          "| FR-008 | A replay lasts 1 h 55. | Must | Ops |",
        ),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-008 ("55", against FR-007: "50")',
    );
  });

  // Review 1 of #330, note 3: a number after glued minutes keeps them a
  // quantity, a number after spaced minutes does not.
  it("measures glued minutes before a number, and spaced minutes only before nothing, a mark or m", () => {
    expect(cutStatement("dure 2h30 45.").measured).toEqual([true, true, false]);
    expect(cutStatement("dure 2 h 30 45.").measured).toEqual([true, false, false]);
  });

  // Review 1 of #331, note 1: a reused identifier was compared with the other
  // references of the form once the first was no longer the only one.
  it("leaves a reused identifier to duplicate_requirement_ids when the form has several references", () => {
    expect(
      messageOf(
        table(
          "| FR-001 | A job lasts 2 h 30 before stopping. | Must | Ops |",
          "| FR-002 | A job lasts 3h30 before stopping. | Must | Ops |",
          "| FR-001 | A job lasts 2 h 30 before stopping. | Must | Ops |",
        ),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("3", against FR-001: "2")',
    );
  });

  // Review 1 of #331, note 2: a number that names is measured by no statement
  // of the form, so the reference that measures every number did not exist.
  it("compares with the first that measures every number the form can measure, beside a naming number", () => {
    expect(cutStatement("Tier 1 users wait 2 h 30.").measurable).toEqual([false, true, true]);
    expect(cutStatement("Tier 1 users wait 2 h 5.").measurable).toEqual([false, true, true]);
    expect(
      messageOf(
        table(
          "| FR-001 | Tier 1 users wait 2 h 5 before stopping. | Must | Ops |",
          "| FR-002 | Tier 1 users wait 2h30 before stopping. | Must | Ops |",
          "| FR-003 | Tier 1 users wait 3 h 30 before stopping. | Must | Ops |",
        ),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-003 ("3", against FR-002: "2")',
    );
  });

  // Review 1 of #331, note 3: `/^[0-5][0-9]$/` read only ASCII digits.
  it("reads two decimal digits of any script as minutes from 00 to 59", () => {
    expect(splitGlued("２h３０")).toEqual({ numbers: ["２", "３０"], after: ["h", null] });
    expect(splitGlued("2h٣٠")).toEqual({ numbers: ["2", "٣٠"], after: ["h", null] });
    expect(splitGlued("２h６０")).toBe(null);
    expect(splitGlued("2h𝟓𝟗")).toEqual({ numbers: ["2", "𝟓𝟗"], after: ["h", null] });
    expect(splitGlued("2h𝟔𝟎")).toBe(null);
    expect(cutStatement("dure 2 h ３０.").measured).toEqual([true, true]);
    expect(cutStatement("dure 2 h ７５.").measured).toEqual([true, false]);
    expect(
      messageOf(
        table(
          "| FR-001 | The export runs for ２h３０. | Must | Ops |",
          "| FR-002 | The export runs for ２h４５. | Must | Ops |",
        ),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("４５", against FR-001: "３０")',
    );
  });

  // Review 1 of #332, note 1: `Number` reads only ASCII digits, so a digit of
  // another script was its own value and `２h３０` contradicted `2h30`.
  it("reads the decimal digits of any script by their value", () => {
    expect(["３０", "٣٠", "𝟑𝟎", "１,０００", "１.５", "１.２.３", "2٣"].map(digitsValue)).toEqual([
      "30",
      "30",
      "30",
      "1000",
      "1.5",
      "1.2.3",
      "23",
    ]);
    expect(cutStatement("The export runs for ２h３０.").values).toEqual(cutStatement("The export runs for 2h30.").values);
    expect(cutStatement("The export runs for ２h３０.").spellings).toEqual(["２", "３０"]);
    for (const other of ["2h30", "2h٣٠", "２ h ３０"]) {
      expect(
        messageOf(
          table(
            "| FR-001 | The export runs for ２h３０. | Must | Ops |",
            `| FR-002 | The export runs for ${other}. | Must | Ops |`,
          ),
        ),
        other,
      ).toBe(undefined);
    }
    expect(
      messageOf(
        table(
          "| FR-001 | The export runs for ２h３０. | Must | Ops |",
          "| FR-002 | The export runs for 3h30. | Must | Ops |",
        ),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("3", against FR-001: "２")',
    );
  });

  // Review 1 of #332, note 3: the references of a form with one duration are
  // not the first of each set of measured numbers for a requirement that
  // measures its minutes; the `references` docstring states what is compared.
  it("compares a requirement that measures its minutes with the first of the form and the first that measures them", () => {
    expect(
      messageOf(
        table(
          "| FR-001 | A job lasts 2h30 before stopping. | Must | Ops |",
          "| FR-002 | A job lasts 2 h 5 before stopping. | Must | Ops |",
          "| FR-003 | A job lasts 3h30 before stopping. | Must | Ops |",
        ),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-003 ("3", against FR-001: "2")',
    );
    // Review 1 of #333, note 3: FR-003 contradicts FR-002 alone (3 against 2
    // hours, both measured), so it is reported only if it is compared with
    // FR-002, which the first of the form, measuring its minutes, excludes.
    expect(
      messageOf(
        table(
          "| FR-001 | A job lasts 2h30 before stopping. | Must | Ops |",
          "| FR-002 | A job lasts 3 h 30 before stopping. | Must | Ops |",
          "| FR-003 | A job lasts 2h30 before stopping. | Must | Ops |",
        ),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("3", against FR-001: "2")',
    );
    // The documented limit: FR-003 contradicts FR-002 alone, which is the first of no reference.
    expect(
      messageOf(
        table(
          "| FR-001 | A job lasts 2 h 5 before stopping. | Must | Ops |",
          "| FR-002 | A job lasts 2 h 7 before stopping. | Must | Ops |",
          "| FR-003 | A job lasts 3h07 before stopping. | Must | Ops |",
        ),
      ),
    ).toBe(undefined);
  });

  // Review 1 of #333, note 2: a word or a rejected glued token kept the script
  // of its digits, so two statements that differ only by it were two forms.
  it("reads the digits of a word of any script as ASCII digits", () => {
    expect(cutStatement("Release ２０２４H1 waits 2 s.").form).toBe(cutStatement("Release 2024H1 waits 2 s.").form);
    expect(cutStatement("Build v２ waits 2 s.").form).toBe(cutStatement("Build v2 waits 2 s.").form);
    expect(
      messageOf(
        table(
          "| FR-001 | Release ２０２４H1 waits 2 s. | Must | Ops |",
          "| FR-002 | Release 2024H1 waits 5 s. | Must | Ops |",
        ),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("5", against FR-001: "2")',
    );
    // Two words that differ by their value still make two forms.
    expect(
      messageOf(
        table(
          "| FR-001 | Release ２０２４H1 waits 2 s. | Must | Ops |",
          "| FR-002 | Release 2024H2 waits 5 s. | Must | Ops |",
        ),
      ),
    ).toBe(undefined);
  });

  // Review 1 of #334, note 1: two forms that do not read as a number are
  // equal exactly when they are identical once their digits are in ASCII.
  it("reads two forms that do not read as a number as equal exactly when their ASCII spellings are identical", () => {
    expect(["1.2.3", "１.２.３", "1.2.4", "0,250.5", "0,250.5"].map(digitsValue)).toEqual([
      "1.2.3",
      "1.2.3",
      "1.2.4",
      "0,250.5",
      "0,250.5",
    ]);
  });

  // Review 1 of #334, note 2: a fullwidth letter was only lowercased (`Ｈ` to
  // `ｈ`), so a word or a unit written with one was another word.
  it("folds the letters of a word or a unit to their compatibility form", () => {
    expect(folded("２０２４Ｈ１")).toBe("2024h1");
    expect(cutStatement("Release ２０２４Ｈ１ waits 2 s.").form).toBe(cutStatement("Release 2024H1 waits 2 s.").form);
    expect(unitOf("ｓ")).toBe("s");
    expect(unitOf("ＭＢ")).toBe("mb");
    expect(cutStatement("A job runs for ５ ｓ.").measured).toEqual([true]);
    expect(
      messageOf(
        table(
          "| FR-001 | Release ２０２４Ｈ１ waits 2 s. | Must | Ops |",
          "| FR-002 | Release 2024H1 waits 5 s. | Must | Ops |",
        ),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("5", against FR-001: "2")',
    );
    expect(
      messageOf(table("| FR-001 | A job runs for ５ ｓ. | Must | Ops |", "| FR-002 | A job runs for 7 s. | Must | Ops |")),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("7", against FR-001: "５")',
    );
    // A glued duration whose unit of an hour is fullwidth reads as `2h30`.
    expect(cutStatement("The export runs for ２ｈ３０.").form).toBe(cutStatement("The export runs for 2h30.").form);
    // Two words whose letters differ still make two forms.
    expect(
      messageOf(
        table(
          "| FR-001 | Release ２０２４Ｈ１ waits 2 s. | Must | Ops |",
          "| FR-002 | Release 2024S1 waits 5 s. | Must | Ops |",
        ),
      ),
    ).toBe(undefined);
  });

  // Review 1 of #334, note 3: the branch of a plain word (`v２`) was checked
  // by its form only, with no finding and no negative case.
  it("reports two statements whose words differ only by the script of their digits", () => {
    expect(
      messageOf(
        table("| FR-001 | Build v２ waits 2 s. | Must | Ops |", "| FR-002 | Build v2 waits 5 s. | Must | Ops |"),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("5", against FR-001: "2")',
    );
    expect(
      messageOf(
        table("| FR-001 | Build v２ waits 2 s. | Must | Ops |", "| FR-002 | Build v3 waits 5 s. | Must | Ops |"),
      ),
    ).toBe(undefined);
  });

  // Review 1 of #335, note 1: four calls of `folded` had no test that fails
  // when they go back to `toLowerCase`: the number words, `isMinuteWord`,
  // `isGluedMinuteUnit` and the minutes of `splitGlued`.
  it("reads a fullwidth number word, minute word and glued minute unit as their letters", () => {
    const reported = (id: string, value: string, earlier: string): string =>
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
      `${id} ("${value}", against FR-001: "${earlier}")`;
    expect(
      messageOf(
        table("| FR-001 | A job runs for ｆｉｖｅ seconds. | Must | Ops |", "| FR-002 | A job runs for two seconds. | Must | Ops |"),
      ),
    ).toBe(reported("FR-002", "two", "ｆｉｖｅ"));
    expect(
      messageOf(
        table(
          "| FR-001 | The export runs for 2 hours ｔｈｉｒｔｙ. | Must | Ops |",
          "| FR-002 | The export runs for 2 hours ｆｏｒｔｙ. | Must | Ops |",
        ),
      ),
    ).toBe(reported("FR-002", "ｆｏｒｔｙ", "ｔｈｉｒｔｙ"));
    expect(
      messageOf(table("| FR-001 | The export runs for 2h30ｍ. | Must | Ops |", "| FR-002 | The export runs for 2h45m. | Must | Ops |")),
    ).toBe(reported("FR-002", "45", "30"));
  });

  // Review 1 of #335, note 2: NFKC of the whole token wrote `²` as `2`, so
  // `x10²` and `x102` were one word.
  it("keeps a superscript, a subscript or a circled digit of a word as it is written", () => {
    expect(folded("x10²")).toBe("x10²");
    expect(folded("CO₂")).toBe("co₂");
    expect(folded("step②")).toBe("step②");
    expect(folded("Ｘ１０²")).toBe("x10²");
    expect(folded("ﬁle")).toBe("file");
    expect(
      messageOf(table("| FR-001 | Grid x10² waits 2 s. | Must | Ops |", "| FR-002 | Grid x102 waits 5 s. | Must | Ops |")),
    ).toBe(undefined);
    expect(
      messageOf(table("| FR-001 | Grid x10² waits 2 s. | Must | Ops |", "| FR-002 | Grid x10² waits 5 s. | Must | Ops |")),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("5", against FR-001: "2")',
    );
  });

  // Review 1 of #337, note 2: a superscript, subscript, circled or fraction
  // form was said to be kept whatever it held; only one of a digit is.
  it("keeps a superscript, subscript, circled or fraction form of a digit (², ₂, ②, ½), and folds one of a letter", () => {
    expect(folded("x10\u00b2")).toBe("x10\u00b2");
    expect(folded("\u2082\u2461\u00bd")).toBe("\u2082\u2461\u00bd");
    // `ⁿ`, `ₐ`, `Ⓗ` hold no digit once in their compatibility form.
    expect(folded("\u207f\u2090\u24bd")).toBe("nah");
  });

  // Review 1 of #336, note 3: removing the final `normalize("NFC")` of
  // `folded` passed every test, and one case, `2h30ｍ`, covered two calls.
  it("recomposes the characters of a word, and folds a glued minute unit for each of its two reads", () => {
    expect(folded("cafe\u0301")).toBe("caf\u00e9");
    // Two conjoining jamo are one syllable once recomposed; a statement
    // token holds them both (they are letters), as it holds a combining
    // accent after a letter (see the decomposed `café` test below).
    expect(folded("\u1100\u1161")).toBe("\uac00");
    expect(
      messageOf(
        table("| FR-001 | The \u1100\u1161 job waits 2 s. | Must | Ops |", "| FR-002 | The \uac00 job waits 5 s. | Must | Ops |"),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("5", against FR-001: "2")',
    );
    // Checked first, so it tells the two calls apart (review 1 of #338,
    // note 1): of the two calls of `folded`, fails only when
    // `isGluedMinuteUnit` goes back to `toLowerCase`, which then rejects the
    // token (null). Any other change that makes the token null (`unitOf`,
    // `GLUED_RUNS`) fails here too (review 1 of #339, note 3).
    expect(splitGlued("2h30ｍ")).not.toBe(null);
    // Reached only once the token is not null, so of the two calls of
    // `folded` it fails only when the minutes of `splitGlued` go back: they
    // keep `ｍ`.
    expect(splitGlued("2h30ｍ")?.after).toEqual(["h", "m"]);
  });

  // #118, slice after #339: `TOKEN` cut a word at a combining accent
  // (`\p{M}` was in no class but the symbol one), so a decomposed `café`
  // and a composed one were two forms and were not compared.
  it("reads a combining accent after a letter as part of its word", () => {
    expect(
      messageOf(
        table("| FR-001 | The cafe\u0301 job waits 2 s. | Must | Ops |", "| FR-002 | The caf\u00e9 job waits 5 s. | Must | Ops |"),
      ),
    ).toBe(
      "1 requirement(s) state a quantity an earlier requirement states differently: " +
        'FR-002 ("5", against FR-001: "2")',
    );
    expect(cutStatement("The cafe\u0301 job waits 2 s.").form).toBe(cutStatement("The caf\u00e9 job waits 2 s.").form);
  });

  it("keeps a combining mark glued after a number in its token", () => {
    // `s\u0301` is no unit, so the token is a word, not `5` seconds.
    expect(splitGlued("5s\u0301")).toBe(null);
    expect(cutStatement("Step 5s\u0301 waits 2 s.").values).toEqual(["2"]);
    // A mark after a digit starts a run of letters, which no unit names.
    expect(splitGlued("5\u0301")).toBe(null);
  });
});
