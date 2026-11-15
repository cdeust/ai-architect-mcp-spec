/**
 * Fenced code blocks, shared by the document rules that skip them
 * (`sp_arithmetic` prose total, `dependency_targets_defined`).
 */

/** Lines of a section, with CRLF and LF endings alike. */
export const LINE_BREAK = /\r?\n/;

/**
 * A fence line: three or more backticks or tildes after any indentation, so a
 * fence nested in a list item (indented four spaces or more) is still one.
 *
 * The rest of the line is read with `[\s\S]*`, not `.*`: `.` does not match a
 * lone `\r`, so on a run of backticks followed by one the match failed only
 * after `{3,}` had given back each backtick in turn, an O(n²) scan (measured
 * 10, 41 and 170 ms at 5k, 10k and 20k backticks; review of #228). With
 * `[\s\S]*` the rest of the line always matches, so the first split succeeds.
 */
export const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})([\s\S]*)$/;

/**
 * Whether a fence line opens a block. As in CommonMark, the info string of a
 * backtick fence cannot contain a backtick: ```` ```npm i``` installs ```` is
 * a code span in a paragraph, not a fence. Read as a fence it opened a block
 * that never closed and hid the rest of the section from both blocking rules
 * (review of #231). A tilde fence takes any info string.
 */
function opensBlock(fence: RegExpExecArray): boolean {
  return fence[1]![0] !== "`" || !fence[2]!.includes("`");
}

/** The lines of a section outside its fenced blocks, and where each block was. */
export interface LinesOutsideFences {
  readonly lines: string[];
  /** The index in `lines` of each line that follows a removed block. */
  readonly afterBlock: ReadonlySet<number>;
}

/**
 * The lines of a section outside its fenced blocks, which show proposed code.
 * As in CommonMark, a block closes only on a fence of the same character, at
 * least as long as the opening one and with nothing after it, so a shorter or
 * other fence inside the block (a nested example) stays inside it.
 * `afterBlock` names the kept lines a removed block came right before, so a
 * reader that follows paragraphs can end one there (CommonMark 0.31.2 §4.5: a
 * fenced block interrupts a paragraph; PR #288 review, note 1).
 */
export function splitOutsideFences(content: string): LinesOutsideFences {
  const lines: string[] = [];
  const afterBlock = new Set<number>();
  let open: string | null = null;
  let removed = false;
  for (const line of content.split(LINE_BREAK)) {
    const fence = FENCE_LINE.exec(line);
    if (open === null) {
      if (fence && opensBlock(fence)) {
        open = fence[1]!;
        removed = true;
      } else {
        if (removed) afterBlock.add(lines.length);
        removed = false;
        lines.push(line);
      }
    } else if (
      fence &&
      fence[1]![0] === open[0] &&
      fence[1]!.length >= open.length &&
      fence[2]!.trim() === ""
    ) {
      open = null;
    }
  }
  return { lines, afterBlock };
}

/** The lines of a section outside its fenced blocks (`splitOutsideFences`). */
export function linesOutsideFences(content: string): string[] {
  return splitOutsideFences(content).lines;
}
