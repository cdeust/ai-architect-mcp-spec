import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";

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
        `Sprint SP values: ${spValues.join(", ")}`,
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

// Rule 1: SP Arithmetic
export function checkSPArithmetic(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const totalRowPattern =
    /^\s*\|\s*(?:\*{0,2})(?:Total|Sum|Grand\s+Total)(?:\*{0,2})\s*\|(.+)\|/gim;
  const dataRowPattern =
    /^\s*\|\s*(?!\s*(?:-|(?:\*{0,2})(?:Total|Sum|Grand\s+Total)))([^|]+)\|(.+)\|/gim;

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

/** Lines of a section, with CRLF and LF endings alike. */
const LINE_BREAK = /\r?\n/;
/** A fence line: three or more backticks or tildes after any indentation. */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
/** A list item: its indentation, then a bullet or an ordinal, then a space. */
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/;
/**
 * A total line: optional list bullet and emphasis, then the word Total, Sum or
 * Grand Total as the first word. Bounded prefix, so the match is linear.
 */
const PROSE_TOTAL_START = /^[ \t]*(?:[-*+][ \t]+)?[*_]{0,2}[ \t]*(?:grand[ \t]+)?(?:total|sum)\b/i;
/**
 * A story-point amount with its unit. The number is at most nine digits and
 * one decimal part, so `Number()` is exact; the unit is required, so a total
 * of stories or of days is not read as points.
 */
const SP_AMOUNT = /(?<![\d.])(\d{1,9}(?:\.\d{1,3})?)[ \t]*(?:SP|story[ \t]+points?)\b/gi;

/** The last story-point amount on a line, or null when it names none. */
function lastSPAmount(line: string): number | null {
  const amounts = [...line.matchAll(SP_AMOUNT)];
  return amounts.length > 0 ? Number(amounts[amounts.length - 1]![1]) : null;
}

/** The lines of a section outside its fenced blocks (CommonMark closing rule). */
function linesOutsideFences(content: string): string[] {
  const kept: string[] = [];
  let open: string | null = null;
  for (const line of content.split(LINE_BREAK)) {
    const fence = FENCE_LINE.exec(line);
    if (open === null) {
      if (fence) open = fence[1]!;
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

/** Equal to the precision `SP_AMOUNT` reads (three decimals). */
const sameAmount = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/**
 * Prose SP total (#118, seeded defect `wrong_number`): a user-story list whose
 * stated total differs from the sum of its stories.
 *
 * Reads the list items that carry a story-point amount (`- STORY-1: … — 2 SP`)
 * and the one line that starts with Total, Sum or Grand Total and carries an
 * amount (`Total: 5 SP`). Only the items at the shallowest indentation are
 * summed, so a story broken into indented tasks is counted once. A table row
 * starts with a pipe, so neither pattern reads it: rows are left to
 * `checkSPArithmetic`. Fenced blocks are skipped.
 *
 * Fires only when exactly one total line is found: with several (subtotals
 * per epic, then a grand total), which stories each one covers is not
 * readable from the text, so nothing is reported rather than a guess.
 */
export function checkProseSPTotal(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const totals: number[] = [];
  const items: { indent: number; amount: number }[] = [];
  for (const line of linesOutsideFences(content)) {
    const amount = lastSPAmount(line);
    if (amount === null) continue;
    if (PROSE_TOTAL_START.test(line)) {
      totals.push(amount);
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) items.push({ indent: item[1]!.replace(/\t/g, "    ").length, amount });
  }
  if (totals.length !== 1 || items.length === 0) return [];

  const top = Math.min(...items.map((i) => i.indent));
  const sum = items
    .filter((i) => i.indent === top)
    .reduce((acc, i) => acc + i.amount, 0);
  const stated = totals[0]!;
  if (sameAmount(sum, stated)) return [];
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
