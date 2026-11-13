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

/**
 * The lines of a section outside its fenced blocks, which show proposed code.
 * As in CommonMark, a block closes only on a fence of the same character, at
 * least as long as the opening one and with nothing after it, so a shorter or
 * other fence inside the block (a nested example) stays inside it.
 */
export function linesOutsideFences(content: string): string[] {
  const kept: string[] = [];
  let open: string | null = null;
  for (const line of content.split(LINE_BREAK)) {
    const fence = FENCE_LINE.exec(line);
    if (open === null) {
      if (fence && opensBlock(fence)) open = fence[1]!;
      else kept.push(line);
    } else if (
      fence &&
      fence[1]![0] === open[0] &&
      fence[1]!.length >= open.length &&
      fence[2]!.trim() === ""
    ) {
      open = null;
    }
  }
  return kept;
}
