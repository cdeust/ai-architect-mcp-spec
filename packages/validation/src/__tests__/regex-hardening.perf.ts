/**
 * Growth (anti-ReDoS) assertions for the hard-output-rule patterns.
 *
 * SEPARATE FILE, AND RUN SEPARATELY — that is the point of it.
 *
 * These assert that doubling the input does not quadruple the time, which is
 * the honest way to pin "no quadratic pattern was reintroduced": a wall-clock
 * budget ("under N ms") is a flake generator on a shared runner, a growth
 * ratio is not.
 *
 * But a growth ratio is still a wall-clock measurement, and while the vitest
 * workspace runs ~97 files in parallel it is measuring the scheduler as much as
 * the code. That showed: with the assertions inside the parallel suite, the
 * `typeStartPattern` case failed roughly one full-suite run in six — on an
 * unchanged tree, at ratios just over the ceiling — while the same case
 * measured 1.87–1.95 across five trials when nothing else was running. Three
 * successive attempts to fix it in the estimator (interleaving the pair,
 * switching from the median to the fastest observation, raising the input size
 * so the work dominates GC) each reduced the rate without reaching zero,
 * because the remaining variance is contention, not method.
 *
 * So the measurement moved out of the contended environment instead:
 *
 *     pnpm test        # the parallel suite — no timing assertions
 *     pnpm test:perf   # this file, alone, its own CI step
 *
 * Excluded from the default `include` glob in packages/validation/vitest.config.ts.
 */

import { describe, expect, it } from "vitest";
import { validateSection } from "../index.js";
import { checkProseSPTotal, checkSPArithmetic } from "../hard-output-rules/rules/sp-rules.js";
import { checkDocumentDependencyTargetsDefined } from "../hard-output-rules/rules/dependency-target-rules.js";
import { checkDocumentMeasurableRequirements } from "../hard-output-rules/rules/measurable-requirement-rules.js";
import { checkDocumentTestableAcceptanceCriteria } from "../hard-output-rules/rules/testable-acceptance-criteria-rules.js";
import { checkDocumentContradictoryRequirements } from "../hard-output-rules/rules/contradictory-requirement-rules.js";

/**
 * Floor for a single sample, in milliseconds. Below this, two timings are
 * mostly clock granularity and their quotient carries no information.
 */
const MIN_SAMPLE_MS = 0.5;

/**
 * Growth ratio between `large` and `small`, taken from the FASTEST observation
 * of each size.
 *
 * The minimum, not the median, because scheduler noise and GC pauses only ever
 * ADD time: the fastest run of a fixed workload is the one least perturbed by
 * anything except the workload itself. Measured over five trials of each case
 * in this file, the median estimator produced 1.70–3.03 for `typeStartPattern`
 * and a single 11.32 outlier for the bash-function case, straddling a 2.5
 * ceiling that the underlying patterns are nowhere near — the growth is real
 * but modest (validateSection runs 44 rules over the input), and the variance
 * was the measurement's, not the code's.
 *
 * The pair is timed BACK-TO-BACK, and that is the whole point. The previous
 * implementation timed every `small` sample, then every `large` sample, so any
 * ambient-load drift between the two blocks landed entirely in the numerator.
 * With 89 test files running in parallel that drift is routine, and it made
 * this assertion fail on an UNCHANGED tree: `main` produced ratio 3.42 (ceiling
 * 2.5) on one full-suite run and passed the next two, with no quadratic pattern
 * anywhere in the diff. The file header claimed the ratio "holds regardless of
 * how loaded the machine is"; that is true of the property and was false of the
 * measurement.
 *
 * Timing both sizes adjacently also puts them under the same ambient load, so
 * the load term is common to numerator and denominator. Growth in the INPUT is
 * what survives: a quadratic worker still lands near 4x, because that factor
 * comes from the input doubling and not from the scheduler.
 *
 * source: measured pre-fix growth of the three patterns in this repo
 * (each ~3.9–4.0x per doubling; see the comments at their definitions).
 */
function growthRatio(run: (input: string) => void, small: string, large: string, pairs = 7): number {
  let fastestSmall = Infinity;
  let fastestLarge = Infinity;

  for (let i = 0; i < pairs; i++) {
    const startedSmall = performance.now();
    run(small);
    fastestSmall = Math.min(fastestSmall, performance.now() - startedSmall);

    const startedLarge = performance.now();
    run(large);
    fastestLarge = Math.min(fastestLarge, performance.now() - startedLarge);
  }

  return fastestLarge / Math.max(fastestSmall, MIN_SAMPLE_MS);
}

/**
 * Assert that doubling the input length does not multiply the time by ~4.
 *
 * A quadratic pattern lands near 4.0. What these cases measure is NOT a single
 * pattern, though — `validateSection` runs 44 rules over the input, so the
 * baseline is the aggregate of all of them and sits near 2.0 rather than near
 * 1.0. The old 2.5 ceiling was calibrated as if one pattern were under test,
 * which left roughly 0.5 of headroom over the real baseline and made the
 * assertion trip on ordinary variance.
 *
 * source: measured on this workspace at the sizes below, five trials per case,
 * fastest-observation estimator —
 *   typeStart 1.87–1.95   bash-fn 1.95–2.85   todo 1.59–2.21
 *   storypoint 1.02–1.78  matrix 0.57–1.16
 * against an injected O(n²) worker at 3.88 idle and 5.72 under eight competing
 * CPU spinners. 3.0 sits above every measured baseline and below the quadratic
 * signal it exists to catch.
 */
const QUADRATIC_GROWTH_CEILING = 3.0;

function expectSubQuadratic(build: (n: number) => string, section: Parameters<typeof validateSection>[1]): void {
  // 16k, not 4k. At 4k both sizes complete in ~35 ms, where a single GC pause
  // is a large fraction of the measurement and the ratio swings wildly (an
  // 11.3 outlier was observed for the bash-function case). At 16k/32k the same
  // case sits at 1.95–2.01 across trials, because the work now dominates the
  // noise instead of competing with it.
  const base = 16000;
  const small = build(base);
  const large = build(base * 2);
  // Warm the JIT on BOTH sizes so no first sample carries compilation cost.
  validateSection(small, section);
  validateSection(large, section);
  const ratio = growthRatio((input) => validateSection(input, section), small, large);
  expect(ratio).toBeLessThan(QUADRATIC_GROWTH_CEILING);
}

describe("polynomial-ReDoS patterns stay sub-quadratic", () => {
  it("modifier runs on a declaration line (typeStartPattern)", () => {
    expectSubQuadratic(
      (n) => ["```kotlin", "abstract ".repeat(n), "```"].join("\n"),
      "technical_specification",
    );
  });

  it("identifier runs in test code (bash function pattern)", () => {
    expectSubQuadratic((n) => ["| test_a |", "```bash", "test".repeat(n), "```"].join("\n"), "testing");
  });

  // The three witnesses below are CodeQL's own, taken verbatim from the
  // js/polynomial-redos report. Each measured 3.9x–4.0x per doubling before
  // the fix; the shared `findPatternViolations` call site was the reported
  // location, but the quadratic lived in the patterns passed to it.
  it("near-miss runs in one SP table cell (sp_not_in_fr_table)", () => {
    expectSubQuadratic((n) => "|storypoint" + "storypoints".repeat(n), "requirements");
  });

  it("comment runs in an unterminated test body (no_placeholder_tests)", () => {
    expectSubQuadratic((n) => "func testa(){{//TODO" + "//TODO".repeat(n), "testing");
  });

  it("space runs after a matrix row's third cell (no_placeholder_tests)", () => {
    expectSubQuadratic((n) => "|testa||" + " ".repeat(n), "testing");
  });

  // Review of #228: the first PROSE_TOTAL_START put two whitespace loops side
  // by side; a line of spaces ending in an amount measured 13, 55 and 269 ms
  // at 5k, 10k and 20k spaces. The prose total is a document-level check, so
  // it is timed directly rather than through validateSection.
  it("space runs before a story-point amount (prose sp_arithmetic)", () => {
    const build = (n: number): string => " ".repeat(n) + "x 1 SP";
    const run = (input: string): void => void checkProseSPTotal(input, "user_stories");
    const small = build(64000);
    const large = build(128000);
    run(small);
    run(large);
    expect(growthRatio(run, small, large)).toBeLessThan(QUADRATIC_GROWTH_CEILING);
  });

  // Review of #271: the prose total reads `Sub total` with a run of spaces
  // between the two words, and a story-point amount as `story points` with
  // a run between them. Each run lies between two letters, so a long run that
  // ends without the second word fails in linear time.
  it("space runs after Sub and after story (prose sp_arithmetic)", () => {
    const run = (input: string): void => void checkProseSPTotal(input, "user_stories");
    for (const build of [
      (n: number): string => "- Sub" + " ".repeat(n) + "x",
      (n: number): string => "- 1 story" + " ".repeat(n) + "x",
    ]) {
      const small = build(64000);
      const large = build(128000);
      run(small);
      run(large);
      expect(growthRatio(run, small, large)).toBeLessThan(QUADRATIC_GROWTH_CEILING);
    }
  });

  // Review of #231: the table rows of sp_arithmetic were found with `^\s*\|`
  // under the `m` flag, so `\s` ran across a run of blank lines from each line
  // start (20, 88 and 362 ms at 5k, 10k and 20k blank lines).
  it("blank-line runs before a table row (table sp_arithmetic)", () => {
    const build = (n: number): string => "\n".repeat(n) + "|";
    const run = (input: string): void => void checkSPArithmetic(input, "timeline");
    const small = build(64000);
    const large = build(128000);
    run(small);
    run(large);
    expect(growthRatio(run, small, large)).toBeLessThan(QUADRATIC_GROWTH_CEILING);
  });

  // Review of #232: the data row read `\|[ \t]*` then the cell `([^|]+)`, two
  // loops that both match spaces, so a pipe followed by a run of spaces and no
  // closing pipe split the run in O(n²) ways before failing.
  it("a pipe followed by a run of spaces and no closing pipe (table sp_arithmetic)", () => {
    const build = (n: number): string => "|" + " ".repeat(n);
    const run = (input: string): void => void checkSPArithmetic(input, "timeline");
    const small = build(16000);
    const large = build(32000);
    run(small);
    run(large);
    expect(growthRatio(run, small, large)).toBeLessThan(QUADRATIC_GROWTH_CEILING);
  });

  // Issue #118: the data row reads its whole row to tell a separator from a
  // row whose first cell is a hyphen. Each separator cell ends at its pipe,
  // so a long run of hyphen cells that ends with a cell of another kind
  // fails in linear time.
  it("a run of hyphen cells that is not a separator (table sp_arithmetic)", () => {
    const build = (n: number): string => "|" + " - |".repeat(n) + " x";
    const run = (input: string): void => void checkSPArithmetic(input, "timeline");
    const small = build(16000);
    const large = build(32000);
    run(small);
    run(large);
    expect(growthRatio(run, small, large)).toBeLessThan(QUADRATIC_GROWTH_CEILING);
  });

  // Review of #254: the space loop after a total label must be the only one
  // before the rest of the cell, so a label then a run of spaces and no
  // closing pipe fails in linear time. It was pinned by a wall-clock budget
  // (< 500 ms) in prose-sp-total.test.ts. Review of #270: `Sub total` takes
  // a space loop inside the subtotal label, followed by the literal `total`,
  // and the unit `story points` one before the literal `points`; the heads
  // `| Sub`, `| Sub total` and `| Total story` measure both.
  it("a total label then a run of spaces and no closing pipe (table sp_arithmetic)", () => {
    const run = (input: string): void => void checkSPArithmetic(input, "timeline");
    const ratios: Record<string, number> = {};
    for (const head of ["| Total", "| Sub", "| Sub total", "| Total story"]) {
      const build = (n: number): string => head + " ".repeat(n);
      const small = build(16000);
      const large = build(32000);
      run(small);
      run(large);
      ratios[head] = growthRatio(run, small, large);
    }
    const over = Object.entries(ratios).filter(([, ratio]) => !(ratio < QUADRATIC_GROWTH_CEILING));
    expect(over, JSON.stringify(ratios)).toEqual([]);
  });

  // Review of #256: no case passed the total label, so nothing measured the
  // emphasis branch of the rest of a total cell (a lookbehind on one space,
  // then one to three `*` or `_`). Each input is one line, and the row
  // pattern is anchored with `^`, so the branch is tried once, after the
  // space that follows the label; what can grow is the work inside that one
  // try. A run of `*` or of `_` is what a marker loop that overlaps the rest
  // of the cell would split in O(n²) ways; `***(` repeated passes the branch
  // and makes the rest read to the line end, so it measures the path that
  // matches. Every input is measured before the assertion, so a failure
  // reports the ratio of each (review of #262).
  // Measured on mutations of `sp-rules.ts`, every input each time (the #118
  // follow-up entries of CHANGELOG.md say which trials measured which
  // mutation). With the marker loop unbounded (`[*_]+`): when only `*` may
  // start the rest, the `*` run fails (3.80 to 4.59 per doubling); when only
  // `_` may, the `_` run fails (3.94 to 4.74); when both may, both runs
  // fail (3.42 to 4.77 and 3.87 to 4.58). Every other input of those
  // mutations, and every input with the loop bounded to three (whatever may
  // start the rest) or with the loop unbounded and neither allowed, stayed
  // under the ceiling of 3 (2.47 at most, the `_` run with the loop bounded
  // and both allowed). The ratios of a trial vary with the machine, so the
  // ceiling, not a single trial, is what an input is compared with. Spaced
  // markers (` *`, ` __`) reach the branch, but the run there ends at the
  // next space after one or two markers, so the work in the branch does not
  // grow with the input: against each of the three failing mutations they
  // stayed under the ceiling (2.08 at most, ` __` with both allowed) and are
  // not kept (reviews of #258 and #263).
  it("emphasis runs after a total label and no closing pipe (table sp_arithmetic)", () => {
    const run = (input: string): void => void checkSPArithmetic(input, "timeline");
    const ratios: Record<string, number> = {};
    for (const unit of ["*", "_", "***("]) {
      const build = (n: number): string => "| **Total** " + unit.repeat(n);
      const small = build(Math.floor(16000 / unit.length));
      const large = build(Math.floor(32000 / unit.length));
      run(small);
      run(large);
      ratios[unit] = growthRatio(run, small, large);
    }
    const over = Object.entries(ratios).filter(([, ratio]) => !(ratio < QUADRATIC_GROWTH_CEILING));
    expect(over, JSON.stringify(ratios)).toEqual([]);
  });

  // Issue #118: after a story-point unit, the rest of a total cell may start
  // with a letter (`Total SP delivered`). That rest and the punctuation rest
  // start with disjoint characters, so a unit then a long run of words and
  // no closing pipe is read once; the subtotal cell of the data-row
  // lookahead has the same shape.
  it("a unit then words and no closing pipe (table sp_arithmetic)", () => {
    const run = (input: string): void => void checkSPArithmetic(input, "timeline");
    const ratios: Record<string, number> = {};
    for (const head of ["| Total SP ", "| **Subtotal SP** ", "| Total story-points ", "| Sub total SPs ", "| Total storypoints "]) {
      const build = (n: number): string => head + "word ".repeat(n);
      const small = build(3200);
      const large = build(6400);
      run(small);
      run(large);
      ratios[head] = growthRatio(run, small, large);
    }
    const over = Object.entries(ratios).filter(([, ratio]) => !(ratio < QUADRATIC_GROWTH_CEILING));
    expect(over, JSON.stringify(ratios)).toEqual([]);
  });

  // Review 2 of #228: FENCE_LINE read the rest of the line with `.*`, which
  // stops at a lone `\r`, so a run of backticks followed by one failed after
  // O(n²) backtracking (10, 41 and 170 ms at 5k, 10k and 20k backticks). Both
  // document rules that skip fenced blocks share the pattern.
  it("space runs inside a two-word unbounded term and an unclosed quote (measurable_requirements)", () => {
    const run = (input: string): void =>
      void checkDocumentMeasurableRequirements([{ type: "requirements", content: input }]);
    for (const head of ["| FR-1 | as", '| FR-1 | "if', "- FR-1: `as"]) {
      const build = (n: number): string => head + " ".repeat(n) + "x";
      const small = build(64000);
      const large = build(128000);
      run(small);
      run(large);
      expect(growthRatio(run, small, large), head).toBeLessThan(QUADRATIC_GROWTH_CEILING);
    }
  });

  it("many rows of one form with distinct quantities, and long number runs (contradictory_requirements)", () => {
    const run = (input: string): void =>
      void checkDocumentContradictoryRequirements([{ type: "requirements", content: input }]);
    const builders: ReadonlyArray<readonly [string, (n: number) => string]> = [
      // Every row shares one cut form and a new value: each is compared with the first only.
      ["rows", (n) => Array.from({ length: n }, (_, i) => `| FR-${i + 1} | A session expires after ${i} minutes. |`).join("\n")],
      // One statement of digits and separators, and one of number words.
      ["digits", (n) => "- FR-1: " + "1.".repeat(n) + "2 s"],
      ["words", (n) => "- FR-1: " + "two ".repeat(n) + "s"],
      // Review 1 of #319, note 3: a number with a long glued run, and a long word of letters and digits.
      ["glued", (n) => "- FR-1: 1" + "a1".repeat(n) + " s"],
      ["alnum", (n) => "- FR-1: B" + "2B".repeat(n) + " 1 s"],
      // Review 1 of #320, note 2: a long glued run of numbers and units, every one read.
      ["durations", (n) => "- FR-1: 1" + "h1".repeat(n) + " s"],
      // Review 1 of #330, note 1: rows of one form whose twelve spaced durations
      // measure their minutes or not by the bits of the row number modulo 1024,
      // so the rows hold up to 1024 sets of measured numbers; each row is
      // compared with three references at most. Review 1 of #331, note 3: the
      // second row measures every number and a row from 1024 on meets the first
      // of its set, so the "same measured" and "all measured" references are
      // both compared.
      [
        "measured",
        (n) =>
          Array.from(
            { length: n },
            (_, i) =>
              `| FR-${i + 1} | A job lasts ` +
              Array.from({ length: 12 }, (_, b) => `${b + 1} h ${i === 1 || ((i % 1024) >> b) & 1 ? 30 : 5},`).join(" ") +
              ` then ${i} s. |`,
          ).join("\n"),
      ],
      // Review 1 of #332, note 2: with `% 1024` every row from 1024 on meets an
      // earlier row of its set, so a return to comparing all pairs, which stops
      // at the first contradiction, stayed under the ceiling. Here every row
      // measures its own set of minutes (the bits of the row number, below
      // 4096), no two rows contradict each other, and all pairs would be
      // compared.
      [
        "distinct",
        (n) =>
          Array.from(
            { length: n },
            (_, i) =>
              `| FR-${i + 1} | A job lasts ` +
              Array.from({ length: 12 }, (_, b) => `${b + 1} h ${(i >> b) & 1 ? 30 : 5},`).join(" ") +
              ` then ${i} s. |`,
          ).join("\n"),
      ],
    ];
    for (const [name, build] of builders) {
      const rows = name === "rows" || name === "measured" || name === "distinct";
      const small = build(rows ? 2000 : 32000);
      const large = build(rows ? 4000 : 64000);
      run(small);
      run(large);
      expect(growthRatio(run, small, large), name).toBeLessThan(QUADRATIC_GROWTH_CEILING);
    }
  });

  it("space runs and unclosed quotes in an acceptance criterion (testable_acceptance_criteria)", () => {
    const run = (input: string): void =>
      void checkDocumentTestableAcceptanceCriteria([{ type: "acceptance_criteria", content: input }]);
    for (const head of ["| AC-1 | lo", '| AC-1 | "love', "- AC-1: `love", "- AC-1: \u201clove"]) {
      const build = (n: number): string => head + " ".repeat(n) + "x";
      const small = build(64000);
      const large = build(128000);
      run(small);
      run(large);
      expect(growthRatio(run, small, large), head).toBeLessThan(QUADRATIC_GROWTH_CEILING);
    }
  });

  // Review 1 of #316, note 3: the "J'aime" exemption runs on every criterion
  // text, so runs of its prefix and of the whole name are measured.
  it("runs of the \"J'aime\" prefix and name in an acceptance criterion (testable_acceptance_criteria)", () => {
    const run = (input: string): void =>
      void checkDocumentTestableAcceptanceCriteria([{ type: "acceptance_criteria", content: input }]);
    for (const unit of ["j'", "j\u2019aim", "j'aime ", "j'aimej'aime"]) {
      const build = (n: number): string => "- AC-1: " + unit.repeat(n) + "love";
      const small = build(8000);
      const large = build(16000);
      run(small);
      run(large);
      expect(growthRatio(run, small, large), unit).toBeLessThan(QUADRATIC_GROWTH_CEILING);
    }
  });

  it("runs of opening curly or guillemet quotes with no closing mark (measurable_requirements)", () => {
    const run = (input: string): void =>
      void checkDocumentMeasurableRequirements([{ type: "requirements", content: input }]);
    for (const mark of ["\u201c", "\u00ab"]) {
      const build = (n: number): string => "| FR-1 | " + mark.repeat(n);
      const small = build(16000);
      const large = build(32000);
      run(small);
      run(large);
      expect(growthRatio(run, small, large), mark).toBeLessThan(QUADRATIC_GROWTH_CEILING);
    }
  });

  // PR #275 review, notes 1 and 4: the header of a table is matched against
  // METADATA_HEADER and the statement is cleared of identifiers before the
  // number search; neither may grow faster than linearly on a long cell.
  it("a long table header cell and a run of identifier-like tokens (measurable_requirements)", () => {
    const run = (input: string): void =>
      void checkDocumentMeasurableRequirements([{ type: "requirements", content: input }]);
    const builds: Record<string, (n: number) => string> = {
      header: (n) => "| " + "a".repeat(n) + " ".repeat(n) + "x |\n|---|\n| FR-1 | fast |",
      identifiers: (n) => "| FR-1 | fast " + "AB-".repeat(n) + " |",
      // PR #276 review, notes 1 and 2: the list-marker lookahead after a
      // number alone on a line, and a heading body made of a long table.
      listMarker: (n) => "### FR-1 fast\n1." + " ".repeat(n) + "\n",
      headingTable: (n) => "### FR-1 fast\n| Priority |\n|---|\n" + "| a |\n".repeat(n / 8),
      // PR #277 review, notes 1 and 2: every line of a list item opens with a
      // number, so each is checked against the line above; and a heading
      // table made of key-value rows of a metadata field.
      wrappedMarkers: (n) => "- FR-1: fast\n" + "  1000. x\n".repeat(n / 10),
      keyValueTable: (n) => "### FR-1 fast\n| Field | Value |\n|---|---|\n" + "| Points | 3 |\n".repeat(n / 16),
      // PR #278 review, note 1: open list items wrapped over several lines,
      // each closed by a paragraph after a blank line, so the stack of open
      // items is pushed and popped on every few lines.
      openListStack: (n) => "### FR-1 fast\n" + "1. a\n   b\n\nc\n".repeat(n / 16),
      // PR #279 review, note 3: items nested three deep then a sibling of the
      // outermost one, so the stack grows to three, the pop loop empties it on
      // every sibling, and the push puts it back to one item (PR #281 review,
      // note 2).
      nestedListStack: (n) => "### FR-1 fast\n" + "- a\n  - b\n    - c\n- d\n".repeat(n / 24),
      // PR #282 review, note 3: a deep stack of open items, then lines whose
      // marker is 4 columns past a container far down the stack, so each
      // opens no item and leaves the stack as it is. A linear rescan of the
      // stack would cost its depth on each such line; since indentation grows
      // with depth, the depth is at most the square root of the input, so
      // that rescan is O(n^1.5) and stays under the ceiling (measured: the
      // linear rescan passes this case too). The case was written for the
      // line scanner #299 replaced; it now guards the block parse of a deep
      // stack of nested lists against a quadratic regression.
      rejectedMarkers: (n) => {
        const depth = Math.floor(Math.sqrt(n) / 2);
        const nested = Array.from({ length: depth }, (_, k) => " ".repeat(5 + 2 * k) + "- b\n").join("");
        return "### FR-1 fast\n- a\n" + nested + "      - c\n".repeat(Math.floor(n / 20));
      },
    };
    for (const [name, build] of Object.entries(builds)) {
      const small = build(32000);
      const large = build(64000);
      run(small);
      run(large);
      expect(growthRatio(run, small, large), name).toBeLessThan(QUADRATIC_GROWTH_CEILING);
    }
  });

  it("backtick runs before a lone carriage return (fenced blocks, both rules)", () => {
    const build = (n: number): string => "`".repeat(n) + "\r";
    const prose = (input: string): void => void checkProseSPTotal(input, "user_stories");
    const deps = (input: string): void =>
      void checkDocumentDependencyTargetsDefined([{ type: "user_stories", content: input }]);
    const small = build(64000);
    const large = build(128000);
    for (const run of [prose, deps]) {
      run(small);
      run(large);
      expect(growthRatio(run, small, large)).toBeLessThan(QUADRATIC_GROWTH_CEILING);
    }
  });
});
