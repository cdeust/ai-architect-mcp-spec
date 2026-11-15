// List items of a requirement text, for the Measurable Requirements rule
// (measurable-requirement-rules.ts): which numbers at a line start are list
// markers (CommonMark 0.31.2 §5.2-5.3), and which list item a defining item
// is nested in. Split from that file to keep each under 500 lines (§4.1).
//
// source: issue #118.

/** A heading line (any level). */
export const HEADING = /^[ \t]{0,3}#{1,6}[ \t]/;
/** A list item, with its indentation in group 1. */
export const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]/;
/** A table row. */
export const TABLE_ROW = /^[ \t]*\|/;

/** The width of a run of leading spaces and tabs, a tab counting as four. */
export function indentWidth(indent: string): number {
  let width = 0;
  for (const ch of indent) width += ch === "\t" ? 4 : 1;
  return width;
}

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

/**
 * A line that ends a block without being paragraph text: a thematic break
 * (`---`, `***`, `___`, CommonMark 0.31.2 §4.1) or a setext underline (`===`,
 * §4.3; `---` under text is one too). After it an ordered list of any number
 * may start (PR #286 review, Codex P2).
 */
const BLOCK_END = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|=+[ \t]*)$/;

/** Whether a line is paragraph text, which an ordered list interrupts only from 1. */
function isParagraphText(line: string | null): boolean {
  return (
    line !== null && line.trim() !== "" && !HEADING.test(line) && !TABLE_ROW.test(line) && !BLOCK_END.test(line)
  );
}

/**
 * Follows the list items open at each line of a section, as a stack of their
 * content indentations (the same rules as `withoutListMarkers`): a list item
 * closes the items it is not inside and opens its own, unless its marker is
 * 4 or more columns right of its container; a heading, a table row, or a
 * line of text after a blank line closes the items whose content it is left
 * of. A line of text right after another goes on with its paragraph (a lazy
 * continuation) and closes nothing. An ordered list may interrupt a
 * paragraph only when it starts at 1 (CommonMark 0.31.2 §5.2), so right
 * after a line of text an ordered marker of another number opens an item
 * only as a sibling left of the content of the innermost open item; else it
 * goes on with the paragraph (`Text line` / `2. note`; PR #285 review,
 * note 1). A blank line, a heading, a table row, a thematic break or a
 * setext underline is not paragraph text (PR #286 review). Returns the content indentation of the item the line's own list
 * item is nested in, or 0 (PR #284 review, note 2).
 */
export function trackItems(open: number[], line: string, previous: string | null): number {
  const item = LIST_ITEM.exec(line);
  const indent = indentWidth(/^[ \t]*/.exec(line)![0]);
  const afterBlank = previous === null || previous.trim() === "";
  if (item !== null && indent - containerOf(open, indent) < 4) {
    const number = ORDERED_NUMBER.exec(line)?.[1];
    const continuesList = open.length > 0 && indent < open[open.length - 1]!;
    if (number === undefined || Number(number) === 1 || !isParagraphText(previous) || continuesList) {
      openItem(open, line, indent, item[0]);
      return open.length > 1 ? open[open.length - 2]! : 0;
    }
    return 0;
  }
  if (line.trim() !== "" && (afterBlank || HEADING.test(line) || TABLE_ROW.test(line))) {
    while (open.length > 0 && indent < open[open.length - 1]!) open.pop();
  }
  return 0;
}
