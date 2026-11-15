import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { listedIds } from "./listed-ids.js";
import { LINE_BREAK, linesOutsideFences } from "./fenced-blocks.js";
import { phrases } from "./lexicon.js";

// Document-Level Rule: Measurable Requirements
//
// A requirement that asks for an unbounded quality ("fast", "user-friendly",
// "seamless") and gives no number cannot be verified: no test can decide
// whether it holds. ISO/IEC/IEEE 29148:2018 §5.2.7 lists such terms
// (superlatives, subjective language, ambiguous adjectives and adverbs,
// loopholes such as "if possible") as terms a requirement statement must
// avoid or bound.
//
// The rule reads each requirement definition (FR-n, NFR-n) and reports the
// ones whose text holds such a term and no number. A number, in digits or in
// words, is read as the bound the term needs, except where it cannot be a
// quantity: a code span, an identifier (`FR-2`), a priority code (`P1`), the
// marker of a numbered list item, and a metadata column of a table or a
// metadata row of a key-value table (`Priority`, `Story Points`). The rule does not check that the number
// belongs to the term, and quoted text is read for the number (a quote may
// state the bound), so a quoted label that carries a number silences it
// (`The "Top 10" page must load fast.`): a missed finding, chosen over a
// blocking one on a quoted bound. It fires on the presence of a defect, so
// it is blocking, but not critical: the term list is a heuristic, and a
// finding costs the non-critical penalty and triggers no critical retry.
//
// source: issue #118, seeded defect `unmeasurable_requirement` ("Copying must
// be fast and user-friendly."), which the document check did not diagnose.

/** A requirement identifier, bounded to nine digits like dependency-target-rules.ts. */
const REQ_ID_SOURCE = String.raw`\b(?:FR|NFR)-\d{1,9}\b`;

/** A table row whose first cell is one requirement identifier (optionally bold or code). */
const TABLE_DEFINITION = new RegExp(
  String.raw`^[ \t]*\|[ \t]*(?:\*\*|\x60)?(${REQ_ID_SOURCE})(?:\*\*|\x60)?[ \t]*\|(.*)$`,
);

/** A list item, heading or bold line that opens with a requirement identifier. */
const LIST_DEFINITION = new RegExp(
  String.raw`^[ \t]*(?:(?:[-*+]|\d{1,9}[.)]|#{1,6})[ \t]+(?:\*\*|\x60)?|\*\*)(${REQ_ID_SOURCE})(?:\*\*|\x60)?(.*)$`,
);

/** A letter, a digit or a hyphen: a term must not touch one on either side. */
const WORD_CHAR = String.raw`[\p{L}\p{N}-]`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every unbounded term (EN + FR) as one alternation, longest first so that
 * `user friendly` wins over a shorter overlapping phrase. Within a phrase a
 * space matches any run of spaces or tabs.
 */
const UNBOUNDED_TERM = new RegExp(
  String.raw`(?<!${WORD_CHAR})(?:` +
    [...new Set(phrases("unboundedQualityTerms"))]
      .sort((a, b) => b.length - a.length)
      .map((p) => escapeRegExp(p).replace(/ /g, "[ \\t]+"))
      .join("|") +
    String.raw`)(?!${WORD_CHAR})`,
  "iu",
);

/**
 * A number in digits, or a number word other than "one": "one" and the
 * French "un" are left out because they are also articles and pronouns.
 * Compounds are read by their parts (`twenty-five`, `dix-sept`,
 * `quatre-vingts`), since a hyphen is not a letter.
 */
const NUMBER_WORDS = [
  // EN
  "zero", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
  "eighty", "ninety", "hundred", "hundreds", "thousand", "thousands", "million",
  "millions", "billion", "billions", "dozen", "dozens",
  // FR
  "zéro", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix",
  "onze", "douze", "treize", "quatorze", "quinze", "seize", "vingt", "vingts",
  "trente", "quarante", "cinquante", "soixante", "septante", "huitante", "octante",
  "nonante", "cent", "cents", "mille", "milliers", "milliard", "milliards", "douzaine",
  "douzaines",
] as const;

const NUMBER = new RegExp(
  String.raw`\p{N}|(?<!\p{L})(?:${[...new Set(NUMBER_WORDS)].join("|")})(?!\p{L})`,
  "iu",
);

/**
 * Quoted text and code spans name things (a "Fast mode" label, a `quickSort`
 * symbol) rather than state a quality, so they are removed before the term
 * search. Each pattern is bounded to one line, and the body of a quote
 * excludes its opening mark as well as its closing one: otherwise a line of
 * `“` (or `«`) with no closing mark is rescanned to its end from every
 * opening mark, which is quadratic (CodeQL js/polynomial-redos, PR #275).
 */
const NAMED_TEXT = /"[^"\n]*"|“[^“”\n]*”|«[^«»\n]*»|`[^`\n]*`/g;

/** A code span: a symbol, never a bound. Bounded to one line like NAMED_TEXT. */
const CODE_SPAN = /`[^`\n]*`/g;

/**
 * Tokens that carry a digit but are not a quantity, so they cannot bound a
 * term: an identifier (`FR-001`, `STORY-2`, `UTF-8`), a priority code (`P1`).
 * Both patterns are bounded. source: PR #275 review, notes 1 and 4. The
 * marker of a list item is removed by `withoutListMarkers`.
 */
const NOT_A_QUANTITY = [/\b[A-Z][A-Z0-9]{0,9}-\d{1,9}\b/g, /\bP\d\b/g] as const;

/**
 * An ordered list marker at a line start followed by the item's text, with
 * the number in group 1. Anchored at the start of one line, so the scan of a
 * line is linear (the lookahead is tried once).
 */
const ORDERED_MARKER = /^[ \t]*(\d{1,9})[.)](?=[ \t]+\S)/;

/** A line that opens a list item, ordered or not: indentation in group 1, the number of an ordered marker in group 2. */
const ANY_LIST_MARKER = /^([ \t]*)(?:[-*+]|(\d{1,9})[.)])(?:[ \t]|$)/;

/**
 * The column a list marker is measured from: the content indentation of the
 * innermost open item the marker is inside, else 0. A marker 4 or more
 * columns right of it opens no item (CommonMark 0.31.2 §5.2; PR #281 review,
 * note 1; PR #282 review, note 1). The list item that defines the
 * requirement is the first open item (`withoutListMarkers`), so a marker
 * under it is measured from its content (PR #283 review, note 3). `open`
 * holds the content indentations of the open items, strictly increasing, so
 * a binary search finds the container: a line that opens no item never
 * pushes on the stack, and a rescan of the stack on every such line would
 * cost its depth each time (PR #282 review, note 3).
 */
function containerOf(open: readonly number[], marker: number): number {
  let lo = 0;
  let hi = open.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (open[mid]! <= marker) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? open[lo - 1]! : 0;
}

/**
 * The lines of a text with the marker of each ordered list item removed. A
 * line that starts with a number and a period is a list item only where
 * CommonMark 0.31.2 §5.2 lets one start: an ordered list may interrupt a
 * paragraph only when it starts at 1, so after a line of text a marker is
 * read only for `1.`, while after a blank line, a heading, or left of the
 * content of a list item that is still open, any number is. Otherwise the line goes on with the
 * paragraph above, and its number is the end of a wrapped sentence (`… is`
 * then `  1000. Beyond that it pages.`), which counts as the bound (PR #277
 * review, note 1; PR #276 review, note 1).
 *
 * The open items are a stack of their content indentations, increasing from
 * the outermost (CommonMark §5.2-5.3). An item stays open across the lines of
 * its text, wrapped ones included, so the `2.` of `1. Search must be fast
 * and` / `   reliable.` / `2. …` is a marker (PR #278 review, note 1), and so
 * is a sibling left of the item before it (`  1.` then `2.`, PR #280 review,
 * note 1). A number at or past the innermost item's content indentation
 * would open a nested list, so `   2000.` wrapped under `1. … the maximum
 * entry count is` is the bound (PR #279 review). A new item closes every
 * open item whose content it is not inside, siblings included; a non-blank
 * line after a blank line closes every item whose content it is left of. A
 * marker 4 or more columns right of its container (the content of the
 * innermost open item it is inside, or the line start) opens no item, so
 * `    1. read the file, whose maximum size is` under a line of text goes on
 * with that text and the `  2000.` below it is the bound (PR #281 review,
 * note 1).
 *
 * The first line is the rest of the definition's opening line, right after
 * its identifier: a number there opens the statement and numbers it
 * (`| FR-001 | 2. Search must be fast. |`), it bounds nothing, so its marker
 * is removed (PR #278 review, note 3). `afterHeading` says the first line is
 * the rest of a heading, so the second line may open a list. `base` is the
 * content indentation of the list item that defines the requirement, whose
 * continuation lines keep their indentation: that item is open when the text
 * starts, so a sibling left of its content continues its list (`1. NFR-001:
 * Search must be fast.` / ` 2. Results are listed.`) and a marker right of
 * it is measured from it (PR #283 review, note 3).
 */
function withoutListMarkers(text: string, afterHeading: boolean, base: number): string {
  const lines = text.split("\n");
  /** Content indentation of each open item, innermost last; the defining item first. */
  const open: number[] = base > 0 ? [base] : [];
  return lines
    .map((line, i) => {
      const previous = i === 0 ? "" : lines[i - 1]!;
      const item = ANY_LIST_MARKER.exec(line);
      const ordered = ORDERED_MARKER.exec(line);
      const marker = item === null ? 0 : indentWidth(item[1]!);
      // Text; a number with no item text after it; or a marker 4 columns
      // past its container, which after text is a lazy continuation of the
      // paragraph and after a blank line an indented code block. None opens
      // an item, and each closes after a blank line the items it is left
      // of, as any text does (PR #282 review, note 2). The first line follows
      // the defining line, not a blank line, so it closes nothing.
      if (
        item === null ||
        (item[2] !== undefined && ordered === null) ||
        (i > 0 && marker - containerOf(open, marker) >= 4)
      ) {
        if (i > 0 && line.trim() !== "" && previous.trim() === "") {
          const indent = indentWidth(/^[ \t]*/.exec(line)![0]);
          while (open.length > 0 && indent < open[open.length - 1]!) open.pop();
        }
        return line;
      }
      // A marker left of the innermost item's content continues an open list
      // (a sibling may sit left of the item before it, CommonMark 0.31.2
      // §5.3; PR #280 review, note 1); one at or past that content would open
      // a nested list, which must start at 1 to interrupt the item's
      // paragraph (PR #279 review).
      const continuesList = open.length > 0 && marker < open[open.length - 1]!;
      const isItem =
        i === 0 ||
        item[2] === undefined ||
        Number(item[2]) === 1 ||
        previous.trim() === "" ||
        (i === 1 && afterHeading) ||
        continuesList;
      if (!isItem) return line;
      const strip = (): string =>
        ordered === null ? line : " ".repeat(ordered[0].length) + line.slice(ordered[0].length);
      // The first line of a list-item definition is the rest of the defining
      // line, whose columns are not the document's: its number is removed,
      // and the defining item stays the open item.
      if (i === 0 && base > 0) return strip();
      // An item's content is right of its marker, so this one pass closes the
      // items it is not nested in, its previous sibling included.
      while (open.length > 0 && open[open.length - 1]! > marker) open.pop();
      const contentStart = /^[ \t]*\S+[ \t]+/.exec(line)?.[0] ?? item[0];
      open.push(indentWidth(contentStart.replace(/\S/g, " ")));
      return strip();
    })
    .join("\n");
}

/**
 * A table column whose cells are metadata of the requirement, never its
 * statement: identifier, dependency, priority, status, estimate and owner
 * columns (EN + FR). A number in one of them (`P1`, `3` story points) does
 * not bound the statement. source: PR #275 review, note 1.
 */
const METADATA_HEADER =
  /^(?:(?:[\p{L}]+[ \t]+)?ids?|depends[ \t]+on|dependenc(?:y|ies)|blocked[ \t]+by|dépend[ \t]+de|dépendances?|priority|priorité|prio|moscow|status|statut|state|état|story[ \t]+points?|points?|sps?|estimate|estimation|effort|owner|responsable)$/iu;

/** The cells of a table row, split on unescaped pipes only (`\|` is a literal pipe). */
function cellsOf(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((c) => c.replace(/\*\*/g, "").trim());
}

function isSeparatorRow(row: string): boolean {
  return /^[ \t]*\|[ \t:|-]*$/.test(row) && row.includes("-");
}

/** The indexes of the metadata columns of a table, read from its header row. */
function metadataColumns(header: readonly string[]): ReadonlySet<number> {
  const out = new Set<number>();
  header.forEach((cell, i) => {
    if (METADATA_HEADER.test(cell)) out.add(i);
  });
  return out;
}

/**
 * The statement of a requirement row: its cells after the identifier, less
 * the metadata columns of the table's header. With no header, every cell
 * after the identifier is read.
 */
function statementOf(cells: readonly string[], metadata: ReadonlySet<number>): string {
  return cells
    .slice(1)
    .filter((_, i) => !metadata.has(i + 1))
    .join(" | ");
}

interface RequirementDefinition {
  readonly id: string;
  readonly text: string;
  /** The first line of `text` is the rest of a heading. */
  readonly afterHeading: boolean;
  /** Content indentation of the defining list item; 0 for any other definition. */
  readonly base: number;
}

/** A heading line (any level). */
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]/;
/** A list item, with its indentation in group 1. */
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]/;
/** A table row. */
const TABLE_ROW = /^[ \t]*\|/;

/**
 * The header of a key-value table: two columns, the second naming the value
 * (`| Field | Value |`, `| Champ | Valeur |`). Its rows are one field each,
 * named by their first cell. Another header (`| Attribute | Detail |`, or a
 * third `Notes` column) is not read as one, so a metadata row under it still
 * bounds the statement: a missed finding, chosen over a false positive on a
 * table whose first column is not a field name (PR #279 review, note 2).
 */
function isKeyValueHeader(header: readonly string[]): boolean {
  return header.length === 2 && /^(?:values?|valeurs?)$/iu.test(header[1]!);
}

/**
 * The lines of a heading's body with each table read as a requirement row
 * is: the separator row is dropped, and the metadata columns named by the
 * table's header are removed from every row, the header included. A header
 * is a table row right above a separator that opens its table. Without this,
 * a `| Priority | Story Points |` table under `### FR-001` was read as plain
 * text and its `3` bounded the statement (PR #276 review, note 2). In a
 * key-value table (`isKeyValueHeader`), a row whose first cell names a
 * metadata field (`| Story Points | 3 |` under `| Field | Value |`) is
 * dropped whole (PR #277 review, note 2). In any other table the first cell
 * is a value of its column, not a field name: under `| Metric | Target |`,
 * `| State | restored within 2 s |` states a bound and is kept (PR #278
 * review, note 2).
 */
function withoutMetadataCells(lines: readonly string[]): string[] {
  const out: string[] = [];
  let metadata: ReadonlySet<number> = new Set();
  let keyValue = false;
  lines.forEach((line, i) => {
    if (!TABLE_ROW.test(line)) {
      metadata = new Set();
      keyValue = false;
      out.push(line);
      return;
    }
    if (isSeparatorRow(line)) return;
    const next = lines[i + 1];
    const opensTable = i === 0 || !TABLE_ROW.test(lines[i - 1]!);
    const cells = cellsOf(line);
    const isHeader = opensTable && next !== undefined && isSeparatorRow(next);
    if (isHeader) {
      metadata = metadataColumns(cells);
      keyValue = isKeyValueHeader(cells);
    } else if (keyValue && METADATA_HEADER.test(cells[0] ?? "")) {
      out.push("");
      return;
    }
    out.push(cells.filter((_, c) => !metadata.has(c)).join(" | "));
  });
  return out;
}

/** The width of a run of leading spaces and tabs, a tab counting as four. */
function indentWidth(indent: string): number {
  let width = 0;
  for (const ch of indent) width += ch === "\t" ? 4 : 1;
  return width;
}

/** How the text of an open list or heading definition goes on. */
interface OpenDefinition {
  readonly id: string;
  readonly kind: "heading" | "item";
  /** Indentation of the list item; 0 for a heading or a bold line. */
  readonly indent: number;
  /** Content indentation of the list item; 0 for a heading or a bold line. */
  readonly content: number;
  readonly lines: string[];
}

/**
 * Whether `line` belongs to the open definition. A heading's text runs to
 * the next heading, blank lines included; a list item's (or a bold line's)
 * runs to the next blank line, heading, table row, or list item that is not
 * nested under it.
 */
function continues(open: OpenDefinition, line: string): boolean {
  if (HEADING.test(line)) return false;
  if (open.kind === "heading") return true;
  if (line.trim() === "" || TABLE_ROW.test(line)) return false;
  const item = LIST_ITEM.exec(line);
  return item === null || indentWidth(item[1]!) > open.indent;
}

/**
 * The requirement definitions of a section with their text: the rest of a
 * table row; or the rest of the opening line of a list item, heading or bold
 * line, plus the lines that go on with it (`continues`). A nested definition
 * closes the one above it. One pass over the lines.
 */
function definitionsIn(content: string): RequirementDefinition[] {
  const out: RequirementDefinition[] = [];
  let open: OpenDefinition | null = null;
  const close = (): void => {
    if (open !== null) {
      const lines = open.kind === "heading" ? withoutMetadataCells(open.lines) : open.lines;
      out.push({ id: open.id, text: lines.join("\n"), afterHeading: open.kind === "heading", base: open.content });
    }
    open = null;
  };
  let metadata: ReadonlySet<number> = new Set();
  let previous: string | null = null;
  for (const line of content.split(LINE_BREAK)) {
    if (!TABLE_ROW.test(line)) {
      metadata = new Set();
    } else if (isSeparatorRow(line) && previous !== null && TABLE_ROW.test(previous)) {
      // The row above a separator is the header of a new table.
      metadata = metadataColumns(cellsOf(previous));
    }
    previous = line;
    const row = TABLE_DEFINITION.exec(line);
    const listed = row === null ? LIST_DEFINITION.exec(line) : null;
    if (row !== null) {
      close();
      out.push({ id: row[1]!, text: statementOf(cellsOf(line), metadata), afterHeading: false, base: 0 });
    } else if (listed !== null) {
      close();
      const item = LIST_ITEM.exec(line);
      open = {
        id: listed[1]!,
        kind: HEADING.test(line) ? "heading" : "item",
        indent: item === null ? 0 : indentWidth(item[1]!),
        content: item === null ? 0 : indentWidth(/^[ \t]*\S+[ \t]+/.exec(line)![0].replace(/\S/g, " ")),
        lines: [listed[2] ?? ""],
      };
    } else if (open !== null && continues(open, line)) {
      (open as OpenDefinition).lines.push(line);
    } else {
      close();
    }
  }
  close();
  return out;
}

/**
 * The text in which a bound is looked for: code spans, list markers and the
 * tokens that are not a quantity are removed, but quoted text is kept, since
 * a quote may state the bound (`"p95 under 2 s"`; PR #275 review, note 2).
 */
function quantitiesOf(text: string, afterHeading: boolean, base: number): string {
  let out = withoutListMarkers(text, afterHeading, base).replace(CODE_SPAN, " ");
  for (const pattern of NOT_A_QUANTITY) out = out.replace(pattern, " ");
  return out;
}

/**
 * The first unbounded term of a requirement text when the text holds no
 * number, else null. The term is looked for outside quoted text and code
 * spans; the number anywhere but in a code span, an identifier, a priority
 * code or a list number. `base` is the content indentation of the defining
 * list item (see `containerOf`).
 */
export function unboundedTermIn(text: string, afterHeading = false, base = 0): string | null {
  if (NUMBER.test(quantitiesOf(text, afterHeading, base))) return null;
  return UNBOUNDED_TERM.exec(text.replace(NAMED_TEXT, " "))?.[0] ?? null;
}

export function checkDocumentMeasurableRequirements(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const flagged = new Set<string>();
  const quoted: string[] = [];
  for (const section of sections) {
    // Fences are removed per section, as in dependency-target-rules.ts.
    const content = linesOutsideFences(section.content).join("\n");
    for (const { id, text, afterHeading, base } of definitionsIn(content)) {
      const term = unboundedTermIn(text, afterHeading, base);
      if (term === null || flagged.has(id)) continue;
      flagged.add(id);
      quoted.push(`${id} ("${term.toLowerCase()}")`);
    }
  }
  if (flagged.size === 0) return [];
  const names = listedIds(quoted);
  return [
    makeViolation(
      "measurable_requirements",
      null,
      `${flagged.size} requirement(s) state an unbounded quality with no number: ${names}`,
      `Unmeasurable: ${names}`,
    ),
  ];
}
