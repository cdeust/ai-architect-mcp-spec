// HTML blocks of a section, for the requirement definitions of the
// Measurable Requirements rule (requirement-definitions.ts). An HTML block
// other than a comment is read again as markdown; this module gives the
// parts of its source that are read, and the comment lines between them.
// No pattern is used to parse HTML (CodeQL js/bad-tag-filter, PR #301): the
// tags and comments are found by plain searches.
//
// source: issue #118.

/**
 * Whether an HTML block is a comment (CommonMark 0.31.2 §4.6, start
 * condition 2: the block opens with `<!--`). markdown-it has already found
 * where the block ends; this only classifies it, so a prefix test is enough.
 */
export const isHtmlComment = (content: string): boolean => content.trimStart().startsWith("<!--");

/**
 * The tag that ends a raw-text block opened by a line (CommonMark 0.31.2
 * §4.6, start condition 1: `<pre`, `<script`, `<style` or `<textarea`,
 * then a space, `>` or the line's end), or null. Its content is not markdown,
 * so, like a code block, it defines nothing (PR #302 review, note 1).
 */
function rawTextEnd(line: string): string | null {
  const head = line.trimStart().slice(0, 10).toLowerCase();
  const tag = ["pre", "script", "style", "textarea"].find((name) => head.startsWith(`<${name}`) && /^[\s>]|^$/.test(head.slice(name.length + 1)));
  return tag === undefined ? null : `</${tag}>`;
}

/**
 * The end (exclusive) of the HTML comment that opens at `start` (CommonMark
 * 0.31.2 §6.6: `<!-->`, `<!--->`, or `<!--` to the next `-->`), or -1 when it
 * is not closed: inside an HTML block, an unclosed `<!--` is text, not a
 * comment (PR #303 review, note 1). A plain search, with no pattern.
 */
function commentEnd(source: string, start: number): number {
  if (source.startsWith(">", start + 4)) return start + 5;
  if (source.startsWith("->", start + 4)) return start + 6;
  const close = source.indexOf("-->", start + 4);
  return close < 0 ? -1 : close + 3;
}

/**
 * A part of an HTML block's source: lines read again as markdown, or a run
 * of lines that only a comment filled. `first` and `end` are lines of the
 * block, 0-based, end exclusive; a text part's `source` has one line for
 * each of them, so its lines map back by an offset.
 */
export type HtmlPart =
  | { readonly kind: "text"; readonly source: string; readonly first: number; readonly end: number }
  | { readonly kind: "comment"; readonly first: number; readonly end: number };

/** The index of the line of `source` that holds the character at `at`, from the start index of each line. */
function lineOf(lineStarts: readonly number[], at: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid]! <= at) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * The source of an HTML block with its comments blanked. A `<!--` on a line
 * of a code block (`codeLines`: a fenced or indented block of the source
 * read as markdown, CommonMark 0.31.2 §4.4 and §4.5) is code, not a comment
 * (PR #304 review, Codex P2).
 */
function withoutComments(source: string, codeLines: ReadonlySet<number>): string {
  const lineStarts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  let stripped = "";
  let from = 0;
  let search = 0;
  for (let start = source.indexOf("<!--"); start >= 0; start = source.indexOf("<!--", search)) {
    if (codeLines.has(lineOf(lineStarts, start))) {
      search = start + 4;
      continue;
    }
    const end = commentEnd(source, start);
    if (end < 0) break;
    stripped += source.slice(from, start) + source.slice(start, end).replace(/[^\n]/g, "");
    from = end;
    search = end;
  }
  return stripped + source.slice(from);
}

/**
 * The parts of an HTML block's source, in order. Each comment is removed
 * (PR #302 review, Codex P2), and the lines it leaves blank are a comment
 * part, which the caller treats as a top-level comment block: it interrupts
 * the paragraph above it, which goes on with the paragraph right under it
 * (PR #303 review, note 1). The text on each side is parsed on its own, so
 * removing the comment neither leaves a hole in the line numbers (PR #304
 * review, note 1) nor joins the lines around it into one block, which made
 * `---` under `**FR-001** …` / `<!-- end -->` a setext underline (PR #304
 * review, note 2). The lines of a raw-text block, at the block's top or
 * nested in it, are blanked, so they define nothing (PR #303 review,
 * note 3); one is not opened on a line of a code block (`codeLines`; PR
 * #304 review, Codex P2). Linear.
 */
export function htmlParts(source: string, codeLines: ReadonlySet<number>): HtmlPart[] {
  const before = source.split("\n");
  const parts: HtmlPart[] = [];
  let text: string[] = [];
  let first = 0;
  const flush = (end: number): void => {
    if (end > first) parts.push({ kind: "text", source: text.join("\n"), first, end });
    text = [];
  };
  let rawEnd: string | null = null;
  withoutComments(source, codeLines)
    .split("\n")
    .forEach((line, i) => {
      if (line.trim() === "" && before[i]!.trim() !== "") {
        flush(i);
        const last = parts[parts.length - 1];
        if (last?.kind === "comment" && last.end === i) parts[parts.length - 1] = { ...last, end: i + 1 };
        else parts.push({ kind: "comment", first: i, end: i + 1 });
        first = i + 1;
        return;
      }
      if (rawEnd === null && !codeLines.has(i)) rawEnd = rawTextEnd(line);
      if (rawEnd !== null) {
        if (line.toLowerCase().includes(rawEnd)) rawEnd = null;
        line = "";
      }
      text.push(line);
    });
  flush(before.length);
  return parts;
}
