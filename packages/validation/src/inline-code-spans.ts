/**
 * Inline code spans of PRD markdown, outside fenced blocks (issue #118).
 *
 * A small CommonMark subset, written as linear scans (no backtracking regex
 * over the document): the repo ships no markdown parser, and the symbol check
 * only needs the text of inline code spans.
 *  - Fenced blocks are removed: they show proposed code.
 *  - Spans pair within a paragraph (blank-line separated block), so a span
 *    hard-wrapped onto the next line is still one span; its line break reads
 *    as a space (CommonMark 6.1).
 *  - A run of N backticks opens a span that only the next run of exactly N
 *    backticks closes; an opener with no closer is literal text.
 *  - A backslash-escaped backtick is literal and cannot open a span; inside a
 *    span a backslash is literal, so it does not stop a closer (CommonMark 6.1).
 */

/**
 * A fence line. A backtick fence's info string cannot contain a backtick
 * (CommonMark 4.5), so ```` ```Ghost.run()``` is new ```` is inline code, not
 * a fence that would swallow the rest of the section. The fence may follow a
 * container prefix — any indentation, blockquote markers and one list marker
 * — because PRDs nest proposed-code fences in list items and quotes
 * (`- Proposed:` then an indented fence, `1. ```ts`, `> ```ts`). The scanner
 * tracks no container, so it cannot apply CommonMark's container-relative
 * 3-space limit (PR #174 reviews r4501809320, r4501828721).
 */
const CONTAINER_PREFIX = /^(?:\s*>)*\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)?/;
const FENCE = /^(`{3,}(?=[^`]*$)|~{3,})/;
const BACKTICK_RUN = /`+/g;
const BLANK_LINE = /\n[ \t]*\n/;

/**
 * `content` with every fenced code block removed, by a single line scan. A
 * fence closes on a line holding only at least as many of the same fence
 * characters; an unclosed fence runs to the end, as in CommonMark. A removed
 * block leaves a blank line, so it also ends the paragraph around it.
 */
function stripFencedBlocks(content: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const rest = line.replace(CONTAINER_PREFIX, "");
    const open = FENCE.exec(rest);
    if (fence === null) {
      if (open) {
        fence = open[1];
        kept.push("");
      } else kept.push(line);
    } else if (open && open[1][0] === fence[0] && open[1].length >= fence.length
      && rest.trim() === open[1]) {
      fence = null;
    }
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
  return stripFencedBlocks(content).split(BLANK_LINE).flatMap(blockSpans);
}
