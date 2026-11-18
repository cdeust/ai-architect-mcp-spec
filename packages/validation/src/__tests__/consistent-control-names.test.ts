/**
 * `consistent_control_names` (#118): an acceptance criterion that names a
 * control by a name no requirement uses ("Clone control" for the "Copy
 * button") checks a control no requirement defines; it is a blocking,
 * non-critical finding of the document check.
 */
import { describe, it, expect } from "vitest";
import { isBlockingViolation, type SectionType } from "@prd-gen/core";
import { validateDocument } from "../index.js";
import { namedControlsIn, withoutCodeSpans } from "../hard-output-rules/rules/control-name-rules.js";

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

  it("ends a requirement's text at a criterion in the same section, so the criterion's name is not the requirement's", () => {
    // Codex review of #345, P2: read with FR and NFR only, the heading's body
    // and the bold line ran on into the criterion below them.
    const heading = [{ type: "requirements" as const, content: "### FR-001: Show a Copy button.\n\n- AC-001: Show a Clone button." }];
    const bold = [{ type: "requirements" as const, content: "**FR-001** Show a Copy button.\n**AC-001** Show a Clone button." }];
    for (const sections of [heading, bold]) {
      expect(findings(sections).map((v) => v.message)).toEqual([
        '1 acceptance criterion(s) name a control no requirement names: AC-001 ("Clone button")',
      ]);
    }
  });

  it("leaves out code spans of any backtick run, over a line end, and keeps an unclosed run literal", () => {
    // Codex review of #345, P2: ``Clone button`` was read as a name.
    expect(namedControlsIn("Use ``Clone button`` or ```a `Clone` button``` here.")).toEqual([]);
    expect(namedControlsIn("Use `Clone\nbutton` here.")).toEqual([]);
    expect(withoutCodeSpans("a ``b` c`` d")).toBe("a   d");
    expect(withoutCodeSpans("a `` b ` c")).toBe("a `` b ` c");
    expect(namedControlsIn("An unclosed `` run, then the Clone button.").map((c) => c.key)).toEqual(["clone"]);
  });

  it("does not check a criterion name that opens a sentence, a requirement keyword or a number word", () => {
    // Review 1 of #345, note 2: harmless text was flagged once a requirement named a control.
    for (const criterion of [
      "- AC-001: External links open in a new tab.",
      "- AC-001: Access control rejects a reader without a session.",
      "- AC-001: Two buttons sit in the corner.",
      '- AC-001: "Share" link copies the URL. Then nothing else.',
      "| AC-001 | Export icons are grey. |",
      "- AC-001: The File menu MUST list Save.",
      "- AC-001: Le bouton DOIT copier le code.",
      "- AC-001: Les boutons DOIVENT rester visibles et le menu PEUT se replier.",
      "- AC-001: Le lien NE DOIT PAS s'ouvrir dans un nouvel onglet.",
    ]) {
      expect(messageOf("- FR-001: Each code block shows a Copy button, and the File menu lists it.", criterion), criterion).toBeUndefined();
    }
    // A name inside the sentence is still checked, and a requirement's
    // sentence-initial name still defines it.
    expect(messageOf("- FR-001: Share link opens a dialog.", "- AC-001: Then the Share link and the Clone button work.")).toBe(
      '1 acceptance criterion(s) name a control no requirement names: AC-001 ("Clone button")',
    );
  });

  it("does not read a quoted number word inside a sentence as a name", () => {
    // Review 1 of #346, note 2: "Two buttons" opens a sentence, so it did not
    // test the number words; here only NOT_A_NAME keeps "Two" out.
    expect(messageOf(COPY_FR, '- AC-001: The toolbar shows "Two" buttons.')).toBeUndefined();
    expect(namedControlsIn('The toolbar shows "Two" buttons.')).toEqual([]);
  });

  it("reads every French keyword form in capitals as no name, and a keyword in title case as a name", () => {
    // Review 1 of #347, note 2: ten of the fourteen French entries had no
    // test, and the plurals and the future were read as names.
    for (const keyword of [
      "DOIT", "DOIVENT", "DEVRAIT", "DEVRAIENT", "DEVRA", "DEVRONT", "PEUT", "PEUVENT", "POURRA", "POURRONT",
      "OBLIGATOIRE", "OBLIGATOIRES", "RECOMMANDÉ", "RECOMMANDÉE", "RECOMMANDÉS", "RECOMMANDÉES",
      "OPTIONNEL", "OPTIONNELLE", "OPTIONNELS", "OPTIONNELLES",
      "FACULTATIF", "FACULTATIVE", "FACULTATIFS", "FACULTATIVES",
    ]) {
      expect(namedControlsIn(`Le bouton ${keyword} rester visible.`), keyword).toEqual([]);
    }
    // A keyword not written in capitals is a name, as RFC 2119 writes them in
    // capitals: "l'onglet Recommandé" is a tab named Recommandé.
    expect(namedControlsIn("Le lecteur ouvre l'onglet Recommandé.").map((c) => c.key)).toEqual(["recommandé"]);
    expect(messageOf(COPY_FR, "- AC-001: Le lecteur ouvre l'onglet Recommandé.")).toBe(
      "1 acceptance criterion(s) name a control no requirement names: AC-001 (\"onglet Recommandé\")",
    );
    expect(messageOf(COPY_FR, "- AC-001: The reader opens the Recommended tab.")).toBe(
      '1 acceptance criterion(s) name a control no requirement names: AC-001 ("Recommended tab")',
    );
  });

  it("reads every English keyword in capitals as no name", () => {
    // Review 1 of #348, note 3: only MUST had a test.
    for (const keyword of ["MUST", "SHALL", "SHOULD", "MAY", "REQUIRED", "RECOMMENDED", "OPTIONAL"]) {
      expect(namedControlsIn(`The toolbar shows the ${keyword} button.`), keyword).toEqual([]);
    }
  });

  it("reads a keyword in title case that opens a sentence as no name", () => {
    // Review 1 of #348, note 2: "Should link" was read as a control named
    // "should", so a document whose requirements name no control had a
    // defined name and its criterion's "Help button" was reported.
    expect(namedControlsIn("Should link to the docs.")).toEqual([]);
    expect(namedControlsIn("The page loads. May link to the docs.")).toEqual([]);
    expect(messageOf("- FR-001: Should link to the docs.", "- AC-001: The page shows the Help button.")).toBeUndefined();
    // A keyword in title case inside a sentence is still a name.
    expect(namedControlsIn("Then the Recommended tab opens.").map((c) => c.key)).toEqual(["recommended"]);
  });

  it("reads a keyword adjective that opens a requirement as the name of its control", () => {
    // Review 1 of #349, note 1: since #349 a keyword opening a sentence was
    // no name, so "Recommended tab lists the picks." defined no tab and a
    // criterion naming the Recommended tab was reported.
    const requirements = `${COPY_FR}\n- FR-002: Recommended tab lists the picks.`;
    expect(messageOf(requirements, "- AC-001: The reader opens the Recommended tab.")).toBeUndefined();
    expect(
      messageOf(`${COPY_FR}\n- FR-002: "Recommended" tab lists the picks.`, "- AC-001: The reader opens the Recommended tab."),
    ).toBeUndefined();
    for (const adjective of ["Required", "Recommended", "Optional", "Obligatoire", "Recommandé", "Optionnel", "Facultatif"]) {
      expect(namedControlsIn(`${adjective} tab lists the picks.`).map((c) => c.key), adjective).toEqual([
        adjective.toLowerCase(),
      ]);
    }
    // A keyword verb that opens a sentence is still no name, nor is an
    // adjective in capitals.
    for (const verb of ["Must", "Shall", "Should", "May", "Doit", "Peut"]) {
      expect(namedControlsIn(`${verb} link to the docs.`), verb).toEqual([]);
    }
    expect(namedControlsIn("RECOMMENDED tab lists the picks.")).toEqual([]);
  });

  it("reads a keyword verb after a bold identifier as opening its sentence", () => {
    // Review 1 of #349, note 2: the text of "**FR-001:** Should link…" is
    // ":** Should link…", whose "**" hid the colon, so "should" was a name.
    expect(messageOf("**FR-001:** Should link to the docs.", "- AC-001: The page shows the Help button.")).toBeUndefined();
    expect(messageOf("- **FR-001:** Should link to the docs.", "- AC-001: The page shows the Help button.")).toBeUndefined();
    // Review 1 of #350, note 2: "__FR-001:__" is not a defining line, so an
    // assertion on it held with or without the skip of "_". An underscore
    // emphasis after the colon is one: its "_" hid the colon.
    expect(messageOf("- FR-001: _Should link to the docs._", "- AC-001: The page shows the Help button.")).toBeUndefined();
    expect(namedControlsIn("FR-001: _Should link to the docs._")).toEqual([]);
    // Inside a sentence an emphasis mark opens no sentence.
    expect(messageOf(COPY_FR, "- AC-001: The page shows the **Clone button**.")).toBe(
      '1 acceptance criterion(s) name a control no requirement names: AC-001 ("Clone button")',
    );
  });

  it("reads a decomposed accent as part of its name", () => {
    // Review 1 of #347, note 3: NAME stopped at U+0301, so the NFD keyword
    // "RECOMMANDE\u0301" gave the key "recommande" and was read as a control.
    expect(namedControlsIn("Le bouton RECOMMANDE\u0301 rester visible.")).toEqual([]);
    // A mark with no composed form stays in its word: "Q\u0301" has none.
    expect(namedControlsIn("The Q\u0301x button works.").map((c) => c.key)).toEqual(["q\u0301x"]);
    // The NFD and NFC spellings of one name are one name.
    expect(messageOf("- FR-001: Each page shows a Re\u0301sume\u0301 button.", "- AC-001: Then the Résumé button works.")).toBeUndefined();
  });

  it("does not report a name after a line end or a statement colon: two known misses", () => {
    // Review 1 of #346, note 1. A definition's text joins its blocks with a
    // line end, which a hard wrap cannot be told from, and "AC-001:" opens
    // the statement; so these criteria are not reported. This test pins the
    // misses: a change that reports them must update it, the comment of
    // SENTENCE_BOUNDARY and the CHANGELOG. Emphasis marks must stay left out
    // before a name (opensSentence): without "*", "**FR-001:** Should link…"
    // defines a control named "should" again (review 1 of #349, note 2;
    // review 1 of #351, note 3).
    expect(messageOf(COPY_FR, "- AC-001: Every code block has exactly one\n  Clone control.")).toBeUndefined();
    expect(messageOf(COPY_FR, "- AC-001: Clone button copies the code.")).toBeUndefined();
    // The colon outside the bold already opened the statement before #350.
    // The positive case shows the line is still read as a definition, so
    // this miss is the statement start alone (review 1 of #352, note 2;
    // review 1 of #353, note 2).
    expect(messageOf(COPY_FR, "- **AC-001**: Clone button copies the code.")).toBeUndefined();
    expect(messageOf(COPY_FR, "- **AC-001**: The Clone button copies the code.")).toBe(
      '1 acceptance criterion(s) name a control no requirement names: AC-001 ("Clone button")',
    );
    // Review 1 of #350, note 1: since #350 emphasis marks are left out before
    // a name, so the second miss covers an identifier bold with its colon and
    // a name in bold or in italics too (review 1 of #351, note 2).
    expect(messageOf(COPY_FR, "- **AC-001:** Clone button copies the code.")).toBeUndefined();
    expect(messageOf(COPY_FR, "- AC-001: **Clone button** copies the code.")).toBeUndefined();
    expect(messageOf(COPY_FR, "- AC-001: _Clone button_ copies the code.")).toBeUndefined();
  });

  it("quotes at most 24 characters of a long control name", () => {
    expect(messageOf(COPY_FR, `- AC-001: The A${"b".repeat(200)} button works.`)).toBe(
      `1 acceptance criterion(s) name a control no requirement names: AC-001 ("A${"b".repeat(23)}…")`,
    );
  });

  it("reads every noun of controlNouns with its plural, switches included", () => {
    expect(namedControlsIn("the Dark switches and the Dark switch").map((c) => c.key)).toEqual(["dark", "dark"]);
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
