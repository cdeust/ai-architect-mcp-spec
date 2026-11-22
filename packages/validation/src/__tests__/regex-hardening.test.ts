/**
 * Regressions for the CodeQL regex findings closed alongside this file.
 *
 * Two kinds of assertion live here, and they are different in nature:
 *
 *  - BEHAVIOUR: two of the flagged patterns were not merely slow, they were
 *    wrong. `[:<≤<=]` never matched the `<=` operator, and the unanchored
 *    bash-function pattern matched `test_foo` inside `mytest_foo`. Those get
 *    ordinary contract tests, each of which fails on the pre-fix code.
 *
 *  - COMPLEXITY: the growth assertions that pin those same patterns as
 *    sub-quadratic live in `regex-hardening.perf.ts`, NOT here. They measure
 *    wall-clock ratios, and a wall-clock ratio taken while 96 other test
 *    files compete for the CPU is not a measurement of the code. See that
 *    file's header for what moved and why.
 */

import { describe, expect, it } from "vitest";
import { validateSection } from "../index.js";

describe("NFR operator matching — js/regex/duplicate-in-character-class", () => {
  // The old class `[:<≤<=]` is a SET, so the two-character `<=` was
  // unreachable: every NFR written the ordinary way escaped the rule.
  const withVerdicts = (nfr: string) =>
    ["## Verification", "", nfr, "", "Verdict: PASS", "Verdict: PASS", ""].join("\n");

  it.each(["p95 <= 200", "latency <= 300", "response time <= 1"])(
    "treats %s as an NFR (fails pre-fix: `<=` never matched)",
    (nfr) => {
      const report = validateSection(withVerdicts(nfr), "performance_requirements");
      const flagged = report.violations.some(
        (v) => v.rule === "honest_verification_verdicts",
      );
      expect(flagged).toBe(true);
    },
  );

  it.each(["p95 < 200", "p95 ≤ 200", "p95: 200", "p95 = 200"])(
    "still treats %s as an NFR (operators the old class already matched)",
    (nfr) => {
      const report = validateSection(withVerdicts(nfr), "performance_requirements");
      const flagged = report.violations.some(
        (v) => v.rule === "honest_verification_verdicts",
      );
      expect(flagged).toBe(true);
    },
  );

  it("does not treat an unrelated comparison as an NFR", () => {
    const report = validateSection(withVerdicts("p99 >= 5"), "performance_requirements");
    const flagged = report.violations.some(
      (v) => v.rule === "honest_verification_verdicts",
    );
    expect(flagged).toBe(false);
  });
});

describe("bash test-function detection — word boundary", () => {
  const matrixRow = (name: string) => `| ${name} | covers AC-1 |`;

  it("counts test_foo() as defining test_foo", () => {
    const content = [
      matrixRow("test_foo"),
      "```bash",
      "test_foo() {",
      "  assert_true",
      "}",
      "```",
    ].join("\n");
    const report = validateSection(content, "testing");
    const missing = report.violations.filter(
      (v) => v.rule === "test_traceability_integrity",
    );
    expect(missing).toHaveLength(0);
  });

  it("does NOT accept mytest_foo() as defining test_foo (fails pre-fix)", () => {
    const content = [
      matrixRow("test_foo"),
      "```bash",
      "mytest_foo() {",
      "  assert_true",
      "}",
      "```",
    ].join("\n");
    const report = validateSection(content, "testing");
    const missing = report.violations.filter(
      (v) => v.rule === "test_traceability_integrity",
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].offendingContent).toBe("test_foo");
  });
});

// The third flagged pattern, `typeKeywordPattern`, is deliberately NOT pinned
// here. Its quadratic witness is a run of newlines, and its caller splits the
// code block on "\n" before testing, so no reachable input ever contains one —
// a growth test through `validateSection` passes on the PRE-fix code too, which
// makes it a test that asserts nothing. The `(?:^|\n)` → `^` change is still
// correct (it deletes an unreachable alternative and the ambiguity CodeQL
// flagged), but the hazard it removes is latent, not live, and pretending
// otherwise with a green-either-way test would be worse than saying so.

describe("SP-in-FR-table detection is row-scoped", () => {
  const spViolations = (content: string) =>
    validateSection(content, "requirements").violations.filter(
      (v) => v.rule === "sp_not_in_fr_table",
    );

  // Pre-fix, `\s` and `[^|]` both matched `\n`, so the greedy cell loop ran to
  // the LAST SP cell in the section and reported ONE violation whose evidence
  // spanned every row in between. Two offending rows are two violations.
  it("reports one violation per offending row (fails pre-fix: coalesced to 1)", () => {
    const content = [
      "| ID | Story Points |",
      "|---|---|",
      "| FR-002 | Story Points |",
    ].join("\n");
    expect(spViolations(content)).toHaveLength(2);
  });

  it("carries only its own row as evidence (fails pre-fix: evidence spanned rows)", () => {
    const content = [
      "| ID | Story Points |",
      "|---|---|",
      "| FR-002 | Story Points |",
    ].join("\n");
    expect(spViolations(content).map((v) => v.offendingContent)).toEqual([
      "| ID | Story Points |",
      "| FR-002 | Story Points |",
    ]);
  });

  it.each([
    ["| ID | Story Points |", "canonical spelling"],
    ["| ID | story  points |", "lowercase, double space"],
    ["  | ID | StoryPoint |", "indented, singular, no space"],
    ["| ID | Story\tPoints |", "tab between the words"],
  ])("still flags %s (%s)", (row) => {
    expect(spViolations(row)).toHaveLength(1);
  });

  it.each([
    ["| ID | Title | Priority |", "table with no SP column"],
    ["Story Points are tracked in the roadmap.", "prose, not a table row"],
    ["|---|---|", "separator row"],
  ])("does not flag %s (%s)", (row) => {
    expect(spViolations(row)).toHaveLength(0);
  });
});

describe("placeholder-test detection", () => {
  const placeholderViolations = (content: string) =>
    validateSection(content, "testing").violations.filter(
      (v) => v.rule === "no_placeholder_tests",
    );

  it.each([
    ["func testA() { // TODO }", "TODO body"],
    ["func testA() { // FIXME }", "FIXME body"],
    ["func testA() throws { // PLACEHOLDER }", "PLACEHOLDER body, throws"],
    ["func testA() { func testB() { //TODO } }", "comment in a nested brace run"],
  ])("flags %s (%s)", (content) => {
    expect(placeholderViolations(content)).toHaveLength(1);
  });

  it.each([
    ["func testA() { assertTrue(x) }", "real body"],
    ["func testA() { no todo } func testB() { assert() }", "two real bodies"],
  ])("does not flag %s (%s)", (content) => {
    expect(placeholderViolations(content)).toHaveLength(0);
  });

  it("flags only the placeholder among several test funcs", () => {
    const content = "func testA() { assert() } func testB() { // TODO }";
    const violations = placeholderViolations(content);
    expect(violations).toHaveLength(1);
    expect(violations[0].offendingContent).toContain("testB");
  });

  it("reads nested Swift parameters and preserves the finding for each placeholder", () => {
    const pending = "func testInvoice(period: (Int, Int)) async throws { // TODO }";
    const empty = "func testBalance(completion: (Int) -> Void) {  }";
    const ready = "func testTotals() { XCTAssertEqual(total, expected) }";
    expect(placeholderViolations([empty, ready, pending].join("\n")).map((v) => v.offendingContent))
      .toEqual([pending, empty]);
  });

  it("keeps punctuation inside parameter comments and string defaults out of the signature", () => {
    const tests = [
      'func testCurrency(label: String = "(") { }',
      "func testInvoice( // invoice group (draft\n  id: Int) { }",
      "func testBalance(/* account group ( */ id: Int) { }",
    ];
    expect(placeholderViolations(tests.join("\n")).map((v) => v.offendingContent)).toEqual(tests);
  });

  it("attributes a complete test following an unfinished declaration to its own name", () => {
    const pending = "func testInvoice() { // TODO }";
    expect(placeholderViolations("func testDraft(\n" + pending).map((v) => v.offendingContent))
      .toEqual([pending]);
  });

  it.each([
    "| test_a | covers AC-1 | // TODO",
    "| test_a | covers AC-1 | ` // TODO",
    "| test_a | covers AC-1 |   `   // Setup",
  ])("flags the matrix row %s", (row) => {
    expect(placeholderViolations(row)).toHaveLength(1);
  });

  // The one behavioural delta the differential found: `\s` matched `\n`, so a
  // comment on the NEXT line was read as the row's own third cell. A markdown
  // row cannot wrap, so this was a false positive, not a lost detection.
  it("does not flag a comment on the line AFTER the row (fails pre-fix)", () => {
    expect(placeholderViolations("| test_a | covers AC-1 |\n// TODO")).toHaveLength(0);
  });
});
