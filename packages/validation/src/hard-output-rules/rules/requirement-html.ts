// HTML blocks of a section, for the requirement definitions of the
// Measurable Requirements rule (requirement-definitions.ts). An HTML block
// other than a comment is read again as markdown; inside it, a comment or a
// raw-text block is opened by a block rule of the parser (`opaqueHtmlBlock`),
// so the parser itself orders it against fences, code blocks and containers.
// #304 and #305 removed the comments from the text before parsing it, then
// rebuilt that order and the containers by hand, and each pass missed a case
// the parser handles (PR #305 review, two Codex P2 findings and note 2).
// No pattern is used to parse HTML (CodeQL js/bad-tag-filter, PR #301): the
// tags and comments are found by plain searches.
//
// source: issue #118.

import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";

/**
 * Whether an HTML block is a comment (CommonMark 0.31.2 §4.6, start
 * condition 2: the block opens with `<!--`). markdown-it has already found
 * where the block ends; this only classifies it, so a prefix test is enough.
 */
export const isHtmlComment = (content: string): boolean => content.trimStart().startsWith("<!--");

/** The raw-text tags of CommonMark 0.31.2 §4.6, start condition 1. */
const RAW_TEXT_TAGS = ["pre", "script", "style", "textarea"] as const;

/** What closes a comment (CommonMark 0.31.2 §4.6, end condition 2). */
const COMMENT_ENDS = ["-->"] as const;

/**
 * What closes a raw-text block: any of the four end tags, whichever tag
 * opened it (CommonMark 0.31.2 §4.6, end condition 1, as markdown-it's
 * `html_block` rule reads it), so `<pre>` / `</style>` closes the block
 * (PR #306 review, note 1).
 */
const RAW_TEXT_ENDS = RAW_TEXT_TAGS.map((name) => `</${name}>`);

/**
 * What may close the opaque block a line opens, or null: `-->` for a comment
 * (start condition 2: `<!--`), any raw-text end tag for a raw-text block
 * (start condition 1: `<pre`, `<script`, `<style` or `<textarea`, then a
 * space, a tab, `>` or the line's end, in any case). A raw-text block is not
 * markdown, so, like a code block, it defines nothing (PR #302 review,
 * note 1). Plain prefix tests, with no pattern.
 */
function opaqueEnds(line: string): readonly string[] | null {
  if (line.startsWith("<!--")) return COMMENT_ENDS;
  const head = line.slice(0, 10).toLowerCase();
  const opensRawText = RAW_TEXT_TAGS.some((name) => {
    if (!head.startsWith(`<${name}`)) return false;
    const next = head.charAt(name.length + 1);
    return next === "" || next === " " || next === "\t" || next === ">";
  });
  return opensRawText ? RAW_TEXT_ENDS : null;
}

/**
 * A block rule that opens an HTML comment or a raw-text block where
 * CommonMark 0.31.2 §4.6 opens one (start conditions 1 and 2), and no other
 * HTML block: it takes the place of markdown-it's `html_block` rule in the
 * parser that reads an HTML block's source again, where every other HTML
 * line is text. It is modelled on that rule: the block may interrupt a
 * paragraph, opens less than 4 columns right of its container, and runs to
 * the first line that holds its end, or to the end of its container, or of
 * the source when it is never closed. Like markdown-it's rule, it stops at
 * the first line left of its container's content: in a list item, an empty
 * line (its `sCount` is 0, under `blkIndent`), a line of fewer spaces than
 * the item's content, or a dedented sibling item. A comment in a list item,
 * closed further down or not, thus hides the item only up to that line,
 * while at the top level an unclosed one runs to the source's end (PR #307
 * review, note 1; PR #308 review, notes 1 and 2). A line of spaces as deep as
 * the item's content does not stop it. Linear in the lines it covers, times the four
 * end tags at most. Since it is a block rule, a `<!--` or `<pre>` on a line
 * of a fenced or indented code block is code (PR #304 review, Codex P2), a fence inside
 * a comment or raw-text block opens nothing (PR #305 review, Codex P2 and
 * note 1), and a comment inside a list item stays in that item (PR #305
 * review, Codex P2 and note 2).
 */
export function opaqueHtmlBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const lineText = (line: number): string => state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]!);
  const ends = opaqueEnds(lineText(startLine));
  if (ends === null) return false;
  if (silent) return true;
  const closes = (line: number): boolean => {
    const text = lineText(line).toLowerCase();
    return ends.some((end) => text.includes(end));
  };
  let nextLine = startLine + 1;
  if (!closes(startLine)) {
    for (; nextLine < endLine; nextLine++) {
      if (state.sCount[nextLine]! < state.blkIndent) break;
      if (closes(nextLine)) {
        nextLine++;
        break;
      }
    }
  }
  state.line = nextLine;
  const token = state.push("html_block", "", 0);
  token.map = [startLine, nextLine];
  token.content = state.getLines(startLine, nextLine, state.blkIndent, true);
  return true;
}
