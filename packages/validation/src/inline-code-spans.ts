/**
 * Inline code spans of PRD markdown, outside fenced blocks (issue #118).
 *
 * A small CommonMark subset, written as linear scans (no backtracking regex
 * over the document): the repo ships no markdown parser, and the symbol check
 * only needs the text of inline code spans.
 *  - Fenced blocks are removed: they show proposed code.
 *  - Spans pair within a block, so a span hard-wrapped onto the next line is
 *    still one span; its line break reads as a space (CommonMark 6.1). A
 *    block ends at a blank line and before each list item, heading, table
 *    row or quote line, which are separate blocks in CommonMark (PR #174
 *    review r4501850253).
 *  - A run of N backticks opens a span that only the next run of exactly N
 *    backticks closes; an opener with no closer is literal text.
 *  - A backslash-escaped backtick is literal and cannot open a span; inside a
 *    span a backslash is literal, so it does not stop a closer (CommonMark 6.1).
 */

/**
 * A fence line. A backtick fence's info string cannot contain a backtick
 * (CommonMark 4.5), so ```` ```Ghost.run()``` is new ```` is inline code, not
 * a fence that would swallow the rest of the section. The fence may follow a
 * container prefix — any indentation, blockquote and list markers in any
 * order — because PRDs nest proposed-code fences in list items and quotes
 * (`- Proposed:` then an indented fence, `1. ```ts`, `> ```ts`). The scanner
 * tracks no container, so it cannot apply CommonMark's container-relative
 * 3-space limit (PR #174 reviews r4501809320, r4501828721).
 */
const CONTAINER_PREFIX = /^(?:\s*(?:>|(?:[-*+]|\d{1,9}[.)])(?=\s)))*\s*/;
const FENCE = /^(`{3,}(?=[^`]*$)|~{3,})/;
const BACKTICK_RUN = /`+/g;
/** A line that starts a new block: list item, ATX heading, table row, quote. */
const BLOCK_START = /^\s*(?:[-*+]\s|\d{1,9}[.)]\s|#{1,6}(?:\s|$)|\||>)/;
/** A block that is always one line: an ATX heading or a table row. */
const ONE_LINE_BLOCK = /^\s*(?:#{1,6}(?:\s|$)|\|)/;

/** `text` split into blocks; the lines of one block are joined with `\n`. */
function blocks(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) out.push(current.join("\n"));
    current = [];
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (BLOCK_START.test(line)) flush();
    current.push(line);
    // A heading or table row also ends its block, so a stray backtick in it
    // cannot pair with the next line (PR #174 review r4501867831).
    if (ONE_LINE_BLOCK.test(line)) flush();
  }
  flush();
  return out;
}

const QUOTE_PREFIX = /^(?:\s*>)*/;
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])\s/;
/**
 * Whether the line's container prefix holds a quote marker, in any order
 * with list markers (`> - x`, `- > x`) (PR #174 review r4501881974).
 */
function isQuoted(line: string): boolean {
  return (CONTAINER_PREFIX.exec(line)?.[0] ?? "").includes(">");
}

interface OpenFence {
  readonly marker: string;
  /** Opened inside a blockquote: ends with the first unquoted line. */
  readonly quoted: boolean;
  /**
   * Content column of the list item holding the fence (see containerColumn).
   * Above 0, the item ends at the first non-blank line indented less.
   */
  readonly column: number;
}

/**
 * The container column of a fence line: the content column of a list item
 * when the line carries a list marker, the indentation when it is 4 or more
 * (a fence nested in a list item's content), else 0 — a top-level fence
 * indented up to 3 spaces does not constrain its content lines.
 */
function containerColumn(unquoted: string, rest: string): number {
  const indent = unquoted.length - unquoted.trimStart().length;
  const prefix = unquoted.length - rest.length;
  if (prefix > indent) return prefix;
  return indent >= 4 ? indent : 0;
}

function openFence(line: string): OpenFence | null {
  const unquoted = line.replace(QUOTE_PREFIX, "");
  const rest = line.replace(CONTAINER_PREFIX, "");
  const open = FENCE.exec(rest);
  if (!open) return null;
  return {
    marker: open[1],
    quoted: isQuoted(line),
    // A quoted fence ends with its quote; its column is not tracked.
    column: isQuoted(line) ? 0 : containerColumn(unquoted, rest),
  };
}

/**
 * Whether `line` closes `fence` explicitly. The closer must sit in the
 * fence's own container: inside a top-level fence that shows markdown, a
 * `> ```` or `- ```` line is content, not a closer (PR #174 review
 * r4501863973).
 */
function closes(fence: OpenFence, line: string): boolean {
  if (!fence.quoted && isQuoted(line)) return false;
  const unquoted = line.replace(QUOTE_PREFIX, "");
  if (fence.column === 0 && LIST_MARKER.test(unquoted)) return false;
  const rest = line.replace(CONTAINER_PREFIX, "").trim();
  const run = FENCE.exec(rest);
  return run !== null && rest === run[1] && run[1][0] === fence.marker[0]
    && run[1].length >= fence.marker.length;
}

/**
 * Whether `line` lies outside the container `fence` was opened in, which
 * ends the fenced block without a closing fence (CommonMark 5.1, 5.2; PR
 * #174 review r4501862077).
 */
function leavesContainer(fence: OpenFence, line: string): boolean {
  if (fence.quoted && !isQuoted(line)) return true;
  if (fence.column === 0) return false;
  const unquoted = line.replace(QUOTE_PREFIX, "");
  if (unquoted.trim() === "") return false;
  const indent = unquoted.length - unquoted.trimStart().length;
  return indent < fence.column;
}

/**
 * `content` with every fenced code block removed, by a single line scan. A
 * fence closes on a line holding only at least as many of the same fence
 * characters, or when its container (quote, list item) ends; an unclosed
 * top-level fence runs to the end, as in CommonMark. A removed block leaves
 * a blank line, so it also ends the paragraph around it.
 */
function stripFencedBlocks(content: string): string {
  const kept: string[] = [];
  let fence: OpenFence | null = null;
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence !== null) {
      if (closes(fence, line)) {
        fence = null;
        continue;
      }
      if (!leavesContainer(fence, line)) continue;
      fence = null;
    }
    fence = openFence(line);
    kept.push(fence === null ? line : "");
  }
  return kept.join("\n");
}

interface Run {
  readonly start: number;
  readonly len: number;
  /** Preceded by an odd number of backslashes: its first backtick is literal. */
  readonly escaped: boolean;
}

function backtickRuns(block: string): Run[] {
  return [...block.matchAll(BACKTICK_RUN)].map((m) => {
    let slashes = 0;
    for (let k = m.index - 1; k >= 0 && block[k] === "\\"; k--) slashes += 1;
    return { start: m.index, len: m[0].length, escaped: slashes % 2 === 1 };
  });
}

/**
 * The spans of one paragraph. Linear: runs are indexed by length, and the
 * search for a closer of a given length only moves forward, because openers
 * are visited left to right.
 */
function blockSpans(block: string): string[] {
  const runs = backtickRuns(block);
  const byLen = new Map<number, number[]>();
  runs.forEach((r, i) => {
    const list = byLen.get(r.len);
    if (list) list.push(i);
    else byLen.set(r.len, [i]);
  });
  const cursor = new Map<number, number>();
  const closerAfter = (i: number, len: number): number => {
    const list = byLen.get(len) ?? [];
    let c = cursor.get(len) ?? 0;
    while (c < list.length && list[c] <= i) c += 1;
    cursor.set(len, c);
    return c < list.length ? list[c] : -1;
  };

  const spans: string[] = [];
  let i = 0;
  while (i < runs.length) {
    const r = runs[i];
    const len = r.escaped ? r.len - 1 : r.len;
    const j = len > 0 ? closerAfter(i, len) : -1;
    if (j === -1) {
      i += 1;
      continue;
    }
    spans.push(block.slice(r.start + r.len, runs[j].start).replace(/\n/g, " "));
    i = j + 1;
  }
  return spans;
}

/** The text of every inline code span in `content`, fenced blocks excluded. */
export function inlineCodeSpans(content: string): string[] {
  return blocks(stripFencedBlocks(content)).flatMap(blockSpans);
}
