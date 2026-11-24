import fc from "fast-check";
import { expect, it } from "vitest";
import { projectDefineDocument } from "../define-handoff.js";
import { DEFINE_REQUIREMENT_OPTIONS, proseLines, requirementDefinitions } from "../hard-output-rules/rules/requirement-definitions.js";

const mention = "Render quotes with the <blockquote> element.";
const publish = "Publish only the verified commit.";
const stop = "Stop at the first failing phase.";
const statements = [mention, publish, stop];
const id = (index: number) => `FR-${String(index + 1).padStart(3, "0")}`;
const numbered = (texts: readonly string[]) => texts.map((text, i) => `${id(i)}: ${text}`);
const list = (lines: readonly string[]) => lines.map(line => "- " + line).join("\n");

function check(content: string, definitions: readonly (readonly [string, string])[], paragraphs: readonly string[]) {
  const expected = definitions.map(([id, text]) => ({ id, text }));
  const raw = requirementDefinitions(content, undefined, DEFINE_REQUIREMENT_OPTIONS);
  expect(raw.map(({ id, text }) => ({ id, text: text.replace(/^:/, "").trim() }))).toEqual(expected);
  expect([...proseLines(content, true)].map(line => line.trim()).filter(Boolean)).toEqual(paragraphs);
  expect(projectDefineDocument([{ type: "requirements", content }]).requirements).toEqual(expected);
}

const entries = (texts: readonly string[]) => texts.map((text, i) => [id(i), text] as const);

it("preserves a literal opener and all three list definitions", () => {
  const lines = numbered(statements);
  check(list(lines), entries(statements), lines);
});

it("preserves a literal opener in a table cell and subsequent rows", () => {
  const table = ["| ID | Statement |", "| --- | --- |", ...statements.map((text, i) => `| ${id(i)} | ${text} |`)];
  check(table.join("\n"), entries(statements), []);
});

it("preserves a literal opener in a heading and subsequent headings", () => {
  check(numbered(statements).map(line => "### " + line).join("\n"), entries(statements), []);
});

it("keeps root prose and the bold definitions below an unpaired opener", () => {
  const bold = [publish, stop].map((text, i) => `**${id(i)}** ${text}`);
  check([mention, ...bold].join("\n"), entries([publish, stop]), [mention, ...bold]);
});

it("keeps tag mentions in different list items independent", () => {
  const texts = [mention, publish, stop, publish, stop, publish, "Document the </blockquote> tag."];
  const lines = numbered(texts);
  check(list(lines), entries(texts), lines);
});

it("removes a closed quote after an earlier literal opener", () => {
  const texts = [...statements, "Keep the receipt."];
  check(list(numbered(texts)) + "<blockquote>Legacy</blockquote>", entries(texts), numbered(texts));
});

it("retains both sides of a closed inline quote", () => {
  check("- FR-001: Keep <blockquote>Legacy.</blockquote>the receipt.", entries(["Keep the receipt."]), ["FR-001: Keep the receipt."]);
});

it("closes a root quote on the continuation of a list item", () => {
  const content = ["<blockquote>", "", "- FR-007: Old policy.", "- FR-008: Old receipt.", "  </blockquote>", "", "- FR-001: " + stop];
  check(content.join("\r\n"), entries([stop]), numbered([stop]));
});

it("removes a whole nested quote and keeps text between adjacent pairs", () => {
  const content = "- FR-001: Keep <blockquote>old <blockquote>nested</blockquote> text</blockquote>the <blockquote>old</blockquote>receipt.";
  check(content, entries(["Keep the receipt."]), ["FR-001: Keep the receipt."]);
});

it("preserves an unmatched root closer", () => {
  const lines = numbered([publish, stop]);
  check("</blockquote>\n\n" + list(lines), entries([publish, stop]), ["</blockquote>", ...lines]);
});

it("ignores tag lookalikes in code, comments and Markdown block quotes", () => {
  const code = "Use `<blockquote>` as the example.";
  const opaque = ["> <blockquote>", "~~~html\n<blockquote>\n~~~", "    <blockquote>", "<!--\n<blockquote>\n-->"];
  const lines = numbered([code, stop]);
  check([...opaque, list(lines)].join("\n\n"), entries([code, stop]), lines);
});

it("recognizes case, attributes and multiline tags but preserves custom elements", () => {
  // Four extra spaces on the continuation keep ">" inside the paragraph (CommonMark §5.1).
  const content = '- FR-001: Keep <BLOCKQUOTE cite="x">old</BLOCKQUOTE><blockquote\n      >old</blockquote>the <blockquote-example> receipt.';
  const texts = ["Keep the <blockquote-example> receipt."];
  check(content, entries(texts), numbered(texts));
});

it("preserves every requirement in 200 lists with independently placed tag mentions", () => {
  const text = fc.constantFrom(mention, "Describe the </blockquote> tag.", publish);
  fc.assert(fc.property(fc.array(text, { minLength: 1 }), (texts) => {
    const lines = numbered(texts);
    check(list(lines), entries(texts), lines);
  }), { seed: 3, numRuns: 200 }); // source: P03 property 13, fixed seed and document count
});

it("expires openers at the end of each heading and table cell, including header cells", () => {
  const table = ["| ID | Statement <blockquote> | Detail </blockquote> |", "| --- | --- | --- |",
    "| FR-002 | Keep <blockquote> here. | End </blockquote> here. |"];
  const content = ["### FR-001: " + mention, "## Fields", ...table, "", "- FR-003: Keep </blockquote> here."].join("\n");
  check(content, entries([mention, "Keep <blockquote> here. | End </blockquote> here.", "Keep </blockquote> here."]),
    ["FR-003: Keep </blockquote> here."]);
});

it("keeps a matched inner quote inside an unmatched opener", () => {
  const text = "Keep <blockquote>this and the receipt.";
  const content = "- FR-001: Keep <blockquote>this and <blockquote>old</blockquote>the receipt.";
  check(content, entries([text]), numbered([text]));
});

it("restores the parent item after its child ends and can close its quote inside a descendant", () => {
  const content = ["- FR-001: Keep <blockquote>old", "  - nested <blockquote>mention",
    "  - another item</blockquote>the receipt.", "- FR-002: " + stop].join("\n");
  check(content, entries(["Keep \nthe receipt.", stop]), ["FR-001: Keep", "the receipt.", "FR-002: " + stop]);
});

it("pairs two root mentions across ordinary blocks and retains both boundaries", () => {
  const content = ["Begin <blockquote>obsolete", "", "- FR-009: Old text.", "", "end</blockquote>finish", "", "- FR-001: " + stop];
  check(content.join("\n"), entries([stop]), ["Begin", "finish", ...numbered([stop])]);
});
