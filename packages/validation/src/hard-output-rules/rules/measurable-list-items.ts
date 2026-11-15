// List items of a requirement text, for the Measurable Requirements rule
// (measurable-requirement-rules.ts): which numbers at a line start are list
// markers (CommonMark 0.31.2 §5.2-5.3), and which list item a defining item
// is nested in. Split from that file to keep each under 500 lines (§4.1).
//
// source: issue #118.

import { indentWidth } from "./fenced-blocks.js";

/** A heading line (any level). */
export const HEADING = /^[ \t]{0,3}#{1,6}[ \t]/;
/** A list item, with its indentation in group 1. */
export const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]/;
/** A table row. */
export const TABLE_ROW = /^[ \t]*\|/;
/** The start of a block quote (CommonMark 0.31.2 §5.1). */
const BLOCK_QUOTE = /^[ \t]{0,3}>/;
/** The block quote markers at a line start, nested ones included, each with its optional space. */
const QUOTE_MARKERS = /^(?:[ \t]{0,3}>[ \t]?)+/;

/** The width of a run of leading spaces and tabs, a tab moving to the next tab stop. */
export { indentWidth };

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
 * note 1; PR #282 review, note 1). In `withoutListMarkers`, when the
 * requirement is defined by a list item (`base` > 0), that item is the
 * innermost open item when the text starts, and when it is nested in another
 * item (`container` > 0) that parent is the one below it on the stack, so a
 * marker under it is measured from its content and a sibling of it from its
 * parent's content (PR #283 review, note 3; PR #284 review, note 2; PR #285
 * review, note 2; PR #286 review, note 2). `open`
 * holds the content indentations of the open items, strictly increasing, so
 * a binary search finds the container: a line that opens no item never
 * pushes on the stack, and a rescan of the stack on every such line would
 * cost its depth each time (PR #282 review, note 3).
 */
export function containerOf(open: readonly number[], marker: number): number {
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
 * Opens the list item of `line`, whose marker is at column `marker`. An
 * item's content is right of its marker, so this one pass closes the items
 * it is not nested in, its previous sibling included.
 */
function openItem(open: number[], line: string, marker: number, markerText: string): void {
  while (open.length > 0 && open[open.length - 1]! > marker) open.pop();
  const contentStart = /^[ \t]*\S+[ \t]+/.exec(line)?.[0] ?? markerText;
  open.push(indentWidth(contentStart.replace(/\S/g, " ")));
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
 * it is measured from it (PR #283 review, note 3). `container` is the content
 * indentation of the open item the defining item is nested in, so a sibling
 * of a defining item nested at column 4 or more is measured from its parent's
 * content, not from column 0 (`1. Group` / `   1. NFR-001: … fast and` /
 * `    2. …`; PR #284 review, note 2).
 */
export function withoutListMarkers(text: string, afterHeading: boolean, base: number, container: number): string {
  const lines = text.split("\n");
  /** Content indentation of each open item, innermost last; the defining item and its parent first. */
  const open: number[] = base === 0 ? [] : container > 0 ? [container, base] : [base];
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
      // The first line of a list-item definition is the rest of the defining
      // line, whose columns are not the document's: its number is removed,
      // and the defining item stays the open item.
      if (i > 0 || base === 0) openItem(open, line, marker, item[0]);
      return ordered === null ? line : " ".repeat(ordered[0].length) + line.slice(ordered[0].length);
    })
    .join("\n");
}

/** The number of an ordered list marker at a line start, in group 1. */
const ORDERED_NUMBER = /^[ \t]*(\d{1,9})[.)]/;

/** The body of a thematic break (`---`, `***`, `___`; CommonMark 0.31.2 §4.1), also a setext underline after text. */
const THEMATIC_BREAK_BODY = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** A line of `=` signs: a setext underline after paragraph text, paragraph text otherwise (§4.3). */
const EQUALS_LINE = /^[ \t]*=+[ \t]*$/;

/**
 * Whether `line` is a thematic break: its body is one, and it sits less than
 * 4 columns right of its container (the content of the innermost open item
 * it is inside, or the line start), as a list marker must (§4.1, §5.2). A
 * thematic break takes precedence over a list item, so `* * *` and `- - -`
 * open no item (§5.2; PR #288 review, note 3).
 */
function isThematicBreak(open: readonly number[], line: string): boolean {
  const indent = indentWidth(/^[ \t]*/.exec(line)![0]);
  return indent - containerOf(open, indent) < 4 && THEMATIC_BREAK_BODY.test(line.trim());
}

/**
 * The block a line of a section leaves open for the next one: a paragraph, a
 * table, or none. Only a paragraph matters to `trackItems`: after one, an
 * ordered list may start only at 1 (CommonMark 0.31.2 §5.2).
 */
export type BlockState = "none" | "paragraph" | "table";

/**
 * The block open after `line`, given the one open before it and `open`, the
 * content indentations of the list items open at the line (`trackItems`, run
 * on the line first). A blank line, a heading and a thematic break end any
 * block; a table row opens a table, and any other line right under a table
 * is a row of it (GFM 0.29 §4.10), so a `===` there is no setext underline
 * (PR #288 review, note 1), unless it starts another block: a list item, a
 * block quote, or a line that `left` the list item the table is in (`left`:
 * `trackItems` closed an item at the line, which only a line left of the
 * content of an item containing the table does; PR #289 review, note 2). A
 * block quote leaves a paragraph open only when it holds paragraph text, not
 * when it is empty or holds a heading or a thematic break (PR #292 review,
 * Codex P2). Under paragraph text, a line of `=` is a setext underline, which ends the paragraph, except when it
 * is left of the content of the innermost open item, or 4 or more columns
 * right of its container: a setext underline cannot be a lazy continuation
 * line nor indented 4 columns (§4.3), so `- Intro` / `===` goes on with the
 * item's paragraph (PR #288 review, note 2). Any other line is
 * paragraph text, a list item's first line and a `===` with no paragraph
 * above included (PR #286 review, Codex P2; PR #287 review, Codex P2). The
 * caller ends any block at the place of a fenced block, whose lines it does
 * not pass (PR #288 review, note 1).
 */
export function blockAfter(line: string, before: BlockState, open: readonly number[], left = false): BlockState {
  if (line.trim() === "" || HEADING.test(line) || isThematicBreak(open, line)) return "none";
  if (BLOCK_QUOTE.test(line)) {
    // A block quote leaves a paragraph open only when its content is
    // paragraph text: an empty quote, a heading or a thematic break in it
    // leaves none (§5.1; PR #292 review, Codex P2).
    const inner = line.replace(QUOTE_MARKERS, "");
    return inner.trim() === "" || HEADING.test(inner) || isThematicBreak([], inner) ? "none" : "paragraph";
  }
  const endsTable = left || LIST_ITEM.test(line);
  if (TABLE_ROW.test(line) || (before === "table" && !endsTable)) return "table";
  if (EQUALS_LINE.test(line) && before === "paragraph") {
    const indent = indentWidth(/^[ \t]*/.exec(line)![0]);
    const lazy = open.length > 0 && indent < open[open.length - 1]!;
    return lazy || indent - containerOf(open, indent) >= 4 ? "paragraph" : "none";
  }
  return "paragraph";
}

/**
 * Follows the list items open at each line of a section, as a stack of their
 * content indentations (the rules of `withoutListMarkers`, except that it
 * also tells a thematic break from a list item, and takes the paragraph state
 * of `blockAfter`, which reads table rows, thematic breaks and setext
 * underlines): a list item closes the items it is not inside and opens its
 * own, unless its marker is 4 or more columns right of its container; a
 * heading, a table row, a thematic break (`---`, `* * *`, `- - -`, never read
 * as a list item; PR #288 review, note 3), or a line of text where no
 * paragraph is open (after a blank line, a table, a fenced block, a heading or
 * a thematic break) closes the items whose content it is left of. A line of
 * text right after paragraph text goes on with its paragraph (a lazy
 * continuation, which only a paragraph takes: CommonMark 0.31.2 §5.1-5.2) and
 * closes nothing (PR #289 review, notes 1 and 2). An ordered list may interrupt a paragraph only when it starts at 1
 * (CommonMark 0.31.2 §5.2), so right after a line of text an ordered marker of
 * another number opens an item only as a sibling left of the content of the
 * innermost open item; else it goes on with the paragraph (`Text line` /
 * `2. note`; PR #285 review, note 1). `inParagraph` says a paragraph is open
 * before the line (`blockAfter` gave `"paragraph"`; PR #286 to #288 reviews).
 * Returns the content indentation of the item the line's own list item is
 * nested in, or 0 (PR #284 review, note 2).
 */
export function trackItems(open: number[], line: string, inParagraph: boolean): number {
  const indent = indentWidth(/^[ \t]*/.exec(line)![0]);
  const thematicBreak = isThematicBreak(open, line);
  const item = thematicBreak ? null : LIST_ITEM.exec(line);
  if (item !== null && indent - containerOf(open, indent) < 4) {
    const number = ORDERED_NUMBER.exec(line)?.[1];
    const continuesList = open.length > 0 && indent < open[open.length - 1]!;
    if (number === undefined || Number(number) === 1 || !inParagraph || continuesList) {
      openItem(open, line, indent, item[0]);
      return open.length > 1 ? open[open.length - 2]! : 0;
    }
    return 0;
  }
  if (line.trim() !== "" && (!inParagraph || thematicBreak || HEADING.test(line) || TABLE_ROW.test(line))) {
    while (open.length > 0 && indent < open[open.length - 1]!) open.pop();
  }
  return 0;
}
