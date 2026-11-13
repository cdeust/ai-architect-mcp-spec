import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { listedIds } from "./listed-ids.js";
import { linesOutsideFences } from "./fenced-blocks.js";

/** A line is a table row when its first non-indent character is `|`. */
const TABLE_ROW_START = /^[ \t]*\|/;
/** A cell names the SP column. Horizontal space only — a cell cannot wrap. */
const SP_CELL = /Story[ \t]*Points?/i;

// Rule 8: SP Not In FR Table
export function checkSPNotInFRTable(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  // Was one regex: `^\s*\|(?:[^|]*\|)*[^|]*(?:Story\s*Points?)[^|]*\|`.
  //
  // It was quadratic (js/polynomial-redos). On a single row whose cell holds
  // many near-misses of the literal, `[^|]*(?:Story\s*Points?)` offers a
  // candidate at each one and the trailing `[^|]*\|` rescans to end-of-input
  // for every candidate. Measured 3.94x, 3.99x, 4.02x per doubling
  // (41 ms at 22 KB, 2.6 s at 176 KB) — textbook O(n²).
  //
  // No line-scoped regex fixes it: the rescan is WITHIN one row, so narrowing
  // the classes to `[^|\n]` still measured 3.86x–4.07x per doubling. The
  // rescan has to go, which means the cell boundary must be found once rather
  // than re-derived per candidate — hence the split, exactly the restructure
  // `checkUnevenSPDistribution` below already carries for the same reason.
  //
  // BEHAVIOUR CHANGE, deliberate — the old pattern was never row-scoped:
  // `\s` and `[^|]` both match `\n`, so the greedy cell loop ran to the LAST
  // SP cell in the whole section and reported ONE violation spanning every
  // row in between (an offendingContent of "| ID | Story Points |\n|---|---|\n
  // | FR-001 | Login | 5 |\n\n## Roadmap\n\n| Sprint | Story Points |" for a
  // two-table document). Two offending rows now yield two violations, each
  // carrying its own row as evidence. Pinned by the tests in
  // __tests__/regex-hardening.test.ts, which fail on the pre-fix code.
  const violations: HardOutputRuleViolation[] = [];
  for (const line of content.split("\n")) {
    if (!TABLE_ROW_START.test(line)) continue;
    if (!line.split("|").some((cell) => SP_CELL.test(cell))) continue;
    violations.push(
      makeViolation(
        "sp_not_in_fr_table",
        sectionType,
        "FR table contains Story Points column — SP belongs only in Implementation Roadmap",
        line.substring(0, 120),
      ),
    );
  }
  return violations;
}

// Rule 9: Uneven SP Distribution
export function checkUnevenSPDistribution(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  // Matched per LINE rather than across the whole document. The previous
  // single regex used `\d+[^|]*?\|`, where the digit run and the lazy any-run
  // compete for the same characters — polynomial backtracking on a row of many
  // digits (js/polynomial-redos). Since a sprint and its SP always live in one
  // table row, scanning line by line is both linear and closer to the rule's
  // actual meaning.
  //
  // Semantics preserved exactly: a line still has to name sprint/iteration
  // FOLLOWED BY A NUMBER (so "Sprint planning | 5 SP" is not a sprint row),
  // and the SP cell is still `| <digits> SP|story points`.
  const sprintLabel = /(?:sprint|iteration)\s*\d+/i;
  const spCell = /\|\s*(\d+)\s*(?:SP|story\s*points?)/i;

  const spValues: number[] = [];
  for (const line of content.split("\n")) {
    if (!sprintLabel.test(line)) continue;
    const match = spCell.exec(line);
    if (!match) continue;
    const val = parseInt(match[1], 10);
    if (!isNaN(val)) spValues.push(val);
  }

  if (spValues.length < 3) return [];

  const allSame = new Set(spValues).size === 1;
  if (allSame) {
    return [
      makeViolation(
        "uneven_sp_distribution",
        sectionType,
        `All ${spValues.length} sprints have identical SP (${spValues[0]}) — real projects have uneven complexity`,
        `Sprint SP values: ${listedIds(spValues.map(String))}`,
      ),
    ];
  }

  return [];
}

/**
 * Every run of digits in a table cell.
 *
 * Module scope is safe ONLY because the sole consumer is `matchAll`, which
 * per spec clones the regex before iterating and so never advances this
 * object's `lastIndex`. The row-matching patterns below are deliberately NOT
 * hoisted: they are driven by `.exec` in a loop, which does mutate
 * `lastIndex`, so each call must get a fresh object.
 */
const NUMBER_PATTERN = /(\d+)/g;

/**
 * The SP value a table row contributes = the LAST number in its cell text
 * (earlier numbers are sprint indices, dates, or ID fragments; the estimate
 * is conventionally the rightmost numeric column).
 *
 * Precondition: `cellsText` is the captured cell run of one table row.
 * Postcondition: returns that trailing number, or null when the row carries
 *   no digits at all (caller skips such rows).
 */
function trailingNumberIn(cellsText: string): number | null {
  const numbers = [...cellsText.matchAll(NUMBER_PATTERN)].map((m) =>
    parseInt(m[1], 10),
  );
  return numbers.length > 0 ? numbers[numbers.length - 1] : null;
}

/**
 * One character of `\s` that does not end a line: `\s` minus `\n`, `\r`,
 * U+2028 and U+2029, the line terminators of the `m` flag. A loop over it
 * cannot cross a line, so a row pattern anchored with `^` stays linear on a
 * run of blank lines.
 */
const INLINE_SPACE = "[^\\S\\n\\r\\u2028\\u2029]";

/**
 * The first cell of a total row, up to its closing pipe: Total, Totals, Sum,
 * Grand Total or Grand Totals, in optional bold, and nothing else.
 *
 * The total row and the lookahead of the data row share this one definition,
 * so every row is either a total or a data row. With a label prefix in the
 * lookahead (`Total|Sum` then `\b`) and the whole cell in the total row, the
 * two disagreed: `| Totals | 10 |` was counted as data and never read as a
 * total, so beside `| **Grand Total** | 10 |` a right total was reported as
 * `sum to 20`, and `| Total SP |`, `| Sum-up task |` or `| Totalité |` was
 * skipped from the sum without being read as a total (`\b` is ASCII only and
 * stops at any non-word character; review of #246). A first cell that only
 * starts with a label (`| Summary task |`, `| Totals carried |`) is data
 * (review of #242).
 */
const TOTAL_LABEL = `(?:\\*{0,2})(?:Totals?|Sum|Grand${INLINE_SPACE}+Totals?)`;
const TOTAL_CELL = `${TOTAL_LABEL}(?:\\*{0,2})${INLINE_SPACE}*\\|`;

/**
 * The table rows of `checkSPArithmetic`, as sources: each call builds its own
 * objects (see `NUMBER_PATTERN`).
 *
 * Inline space only around the leading pipe. With the `m` flag, `^\s*` let
 * `\s` run across newlines: each line start of a run of n blank lines rescanned
 * the rest of the run before failing, an O(n²) scan (measured 20, 88 and
 * 362 ms at 5k, 10k and 20k blank lines; review of #231). `INLINE_SPACE` is
 * `\s` without the line terminators, so a row indented with a tab, a no-break
 * space, `\f` or `\v` is read as it was with `\s*`.
 *
 * The data row has no space loop between its pipe and its first cell: the
 * cell starts at the pipe and reads the spaces itself. With a `[ \t]*` there,
 * both loops matched a run of spaces, so a `|` followed by n spaces and no
 * closing pipe split the run in O(n²) ways before failing (50, 206 and 856 ms
 * at 5k, 10k and 20k spaces; review of #232). The lookahead keeps its own
 * space loop, so a separator or a total row is still skipped whatever the
 * space after its pipe; the first cell is not read (only the cells after it
 * carry the estimate).
 *
 * The first cell holds neither a pipe nor a line terminator (`\n`, `\r`,
 * U+2028, U+2029). With `[^|]+` it crossed the line end, so a row whose first
 * cell has no closing pipe (`|` alone, or `| draft`) read the next line as the
 * rest of its row, and the lookahead, which looks only after that pipe, did
 * not skip the next line when it was a total (review of #234). The other
 * loops of both rows are `.`, `INLINE_SPACE` or the `\*{0,2}` of the bold
 * markers, none of which matches a line terminator, so neither row pattern
 * spans two lines (review of #242).
 */
const TOTAL_ROW_SOURCE = `^${INLINE_SPACE}*\\|${INLINE_SPACE}*${TOTAL_CELL}(.+)\\|`;
const DATA_ROW_SOURCE = `^${INLINE_SPACE}*\\|(?!${INLINE_SPACE}*(?:-|${TOTAL_CELL}))([^|\\n\\r\\u2028\\u2029]+)\\|(.+)\\|`;

// Rule 1: SP Arithmetic
export function checkSPArithmetic(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  // Fresh objects per call: `.exec` in a loop advances `lastIndex`.
  const totalRowPattern = new RegExp(TOTAL_ROW_SOURCE, "gim");
  const dataRowPattern = new RegExp(DATA_ROW_SOURCE, "gim");

  // Collect individual SP values from data rows
  const individualSPs: number[] = [];
  let dataMatch: RegExpExecArray | null;
  while ((dataMatch = dataRowPattern.exec(content)) !== null) {
    const rowSP = trailingNumberIn(dataMatch[2]);
    if (rowSP !== null) {
      individualSPs.push(rowSP);
    }
  }

  // Check total rows
  const violations: HardOutputRuleViolation[] = [];
  let totalMatch: RegExpExecArray | null;
  while ((totalMatch = totalRowPattern.exec(content)) !== null) {
    const totalValue = trailingNumberIn(totalMatch[1]);
    if (totalValue === null) continue;

    const computedSum = individualSPs.reduce((sum, v) => sum + v, 0);

    if (computedSum > 0 && computedSum !== totalValue) {
      violations.push(
        makeViolation(
          "sp_arithmetic",
          sectionType,
          `SP total row shows ${totalValue} but individual rows sum to ${computedSum}`,
          `Total: ${totalValue}, Computed: ${computedSum}`,
        ),
      );
    }
  }

  return violations;
}

/** A list item: its indentation, then a bullet or an ordinal, then a space. */
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/;
/**
 * A total line: an optional bullet or ordinal, optional emphasis, then Total,
 * Sum, Subtotal or Grand Total as the first word.
 *
 * Linear: each run of spaces can be matched by one loop only. The bullet
 * group ends with its own `[ \t]+` and the emphasis group with its own
 * `[ \t]*`, and both groups start with a non-space character, so no two
 * whitespace loops are ever adjacent. The first version wrote
 * `[*_]{0,2}[ \t]*` after the bullet group: with both groups empty, two
 * loops split a run of n spaces in O(n²) ways when the match failed
 * (measured 13 ms, 55 ms, 269 ms at 5k, 10k, 20k spaces; review of #228).
 */
const PROSE_TOTAL_START =
  /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(?:[*_]{1,2}[ \t]*)?(?:grand[ \t]+|sub-?)?(?:total|sum)\b/i;
/**
 * A story-point amount with its unit. The number is at most nine digits and
 * one decimal part, so `Number()` is exact; the unit is required, so a total
 * of stories or of days is not read as points.
 */
const SP_AMOUNT = /(?<![\d.])(\d{1,9}(?:\.\d{1,3})?)[ \t]*(?:SP|story[ \t]+points?)\b/gi;
/** Emphasis markers, removed before an amount is read (`**1** SP`). */
const EMPHASIS = /[*_]/g;

/**
 * The first or last story-point amount on a line, or null when it names none.
 * A story states its estimate last (`- STORY-1: … (3 SP stretch) — 2 SP`); a
 * total states its own amount first (`Total: 3 SP of 5 SP capacity`; review
 * of #228: the last amount read that total as 5).
 */
function spAmount(line: string, which: "first" | "last"): number | null {
  const amounts = [...line.replace(EMPHASIS, "").matchAll(SP_AMOUNT)];
  if (amounts.length === 0) return null;
  return Number(amounts[which === "first" ? 0 : amounts.length - 1]![1]);
}

/** Equal to the precision `SP_AMOUNT` reads (three decimals). */
const sameAmount = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** A list item of the story list: its indentation and its amount, if any. */
type StoryItem = { readonly indent: number; readonly amount: number | null };

/** The total lines of a section, each with the list it closes. */
interface TotalLine {
  readonly amount: number;
  readonly items: readonly StoryItem[];
}

/**
 * Split a section into its total lines that carry an amount, each paired
 * with the list items between it and the previous total line that carries an
 * amount (or the start of the section). A total line without an amount
 * (`Subtotal: 1 story`) neither closes nor empties the list. Items after the
 * last such total line belong to no total: a `Deferred` list written under
 * the total is not counted in it.
 */
function totalLinesOf(content: string): TotalLine[] {
  const totals: TotalLine[] = [];
  let items: StoryItem[] = [];
  for (const line of linesOutsideFences(content)) {
    if (PROSE_TOTAL_START.test(line)) {
      // A total line without an amount (`Subtotal: 1 story`) closes nothing:
      // the stories above it still belong to the next total (review of #228;
      // emptying the list here made a right total read as wrong).
      const amount = spAmount(line, "first");
      if (amount !== null) {
        totals.push({ amount, items });
        items = [];
      }
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      items.push({ indent: item[1]!.replace(/\t/g, "    ").length, amount: spAmount(line, "last") });
    }
  }
  return totals;
}

/**
 * The sum of the shallowest items of a list, or null when it cannot be read:
 * no item, or an item at that level whose amount is not on its first line.
 */
function topLevelSum(items: readonly StoryItem[]): number | null {
  if (items.length === 0) return null;
  const top = items.reduce((min, i) => Math.min(min, i.indent), Infinity);
  let sum = 0;
  for (const i of items) {
    if (i.indent !== top) continue;
    if (i.amount === null) return null;
    sum += i.amount;
  }
  return sum;
}

/**
 * Prose SP total (#118, seeded defect `wrong_number`): a user-story list whose
 * stated total differs from the sum of its stories.
 *
 * The one line that starts with Total, Sum, Subtotal or Grand Total and
 * carries an amount (`Total: 5 SP`) is compared with the list items above
 * it (`- STORY-1: … — 2 SP`). Only the shallowest items are summed, so a story
 * broken into indented tasks counts once. A table row starts with a pipe, so
 * no pattern here reads it: rows are left to `checkSPArithmetic`. Fenced
 * blocks are skipped.
 *
 * Nothing is reported, rather than a guess, when the text does not say what
 * the total covers: several total lines (subtotals per epic), or a story of
 * the list whose amount is not on its first line.
 */
export function checkProseSPTotal(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const totals = totalLinesOf(content);
  if (totals.length !== 1) return [];
  const { amount: stated, items } = totals[0]!;
  const sum = topLevelSum(items);
  if (sum === null || sameAmount(sum, stated)) return [];
  const shown = Number(sum.toFixed(3));
  return [
    makeViolation(
      "sp_arithmetic",
      sectionType,
      `SP total line shows ${stated} but the stories sum to ${shown}`,
      `Total: ${stated}, Computed: ${shown}`,
    ),
  ];
}

// Document-Level SP Arithmetic
export function checkDocumentSPArithmetic(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const spSections = sections.filter(
    (s) =>
      s.type === "timeline" ||
      s.type === "deployment" ||
      s.type === "requirements",
  );

  const violations =
    spSections.length === 0
      ? []
      : checkSPArithmetic(spSections.map((s) => s.content).join("\n\n"), "timeline");

  // The prose total of a story list, read per section: user stories carry no
  // section-level sp_arithmetic pass, so it is reported once, here.
  for (const s of sections) {
    if (s.type === "user_stories") violations.push(...checkProseSPTotal(s.content, s.type));
  }
  return violations;
}
