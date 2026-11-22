import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import { findPatternViolations, makeViolation } from "./helpers.js";

const PLACEHOLDER_MESSAGE =
  "Found placeholder test with empty or TODO-only body";

const PLACEHOLDER_COMMENT = /\/\/\s*(?:TODO|FIXME|PLACEHOLDER)/;
const MATRIX_PLACEHOLDER = /^[ \t]*\|[ \t]*test\w+[ \t]*\|[^|\n]*\|[ \t]*(?:`[ \t]*)?\/\/[ \t]*(?:TODO|Setup)/gm;

/**
 * Read Swift test headers in source order. A new declaration starts fresh
 * when a draft signature is unfinished. Parentheses in tuple and function
 * parameter types belong to that signature.
 */
function* swiftTestHeaders(content: string) {
  const headerTokens = /\bfunc\s+test\w+\s*\(|[()"]|\/\/|\/\*/g;
  // Inside a signature, comments and string defaults can contain punctuation.
  const parameterTrivia = /"(?:\\[^\r\n]|[^"\\\r\n])*"?|\/\/[^\r\n]*|\/\*(?:[^*]|\*(?!\/))*(?:\*\/|$)/y;
  const bodyOpening = /\s*(?:throws\s+)?(?:async\s+)?(?:throws\s+)?\{/y;
  let start = 0;
  let depth = 0;

  let token: RegExpExecArray | null;
  while ((token = headerTokens.exec(content)) !== null) {
    if (token[0].startsWith("func")) {
      start = token.index;
      depth = 1;
    } else if (depth > 0) {
      if (token[0] === "(") {
        depth++;
      } else if (token[0] === ")") {
        if (--depth === 0) {
          bodyOpening.lastIndex = headerTokens.lastIndex;
          if (bodyOpening.test(content)) yield { start, bodyStart: bodyOpening.lastIndex };
        }
      } else {
        parameterTrivia.lastIndex = token.index;
        if (parameterTrivia.test(content)) headerTokens.lastIndex = parameterTrivia.lastIndex;
      }
    }
  }
}

// Rule 7: No Placeholder Tests
export function checkNoPlaceholderTests(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const comments: HardOutputRuleViolation[] = [];
  const empty: HardOutputRuleViolation[] = [];
  const emptyBody = /\s*\}/y;
  let end = -1;

  const finding = (start: number, endExclusive: number) => makeViolation(
    "no_placeholder_tests", sectionType, PLACEHOLDER_MESSAGE,
    content.slice(start, endExclusive).substring(0, 120),
  );

  for (const { start, bodyStart } of swiftTestHeaders(content)) {
    // The rule inspects the body up to its first closing brace. Process each
    // such span once, including when it contains another declaration.
    if (start > end) {
      end = content.indexOf("}", bodyStart);
      if (end === -1) break;
      if (PLACEHOLDER_COMMENT.test(content.slice(bodyStart, end))) {
        comments.push(finding(start, end + 1));
      }
    }
    // An empty nested test is independently reportable. Its whitespace can
    // only extend to the next token, so this check never rescans a body.
    emptyBody.lastIndex = bodyStart;
    if (emptyBody.test(content)) empty.push(finding(start, emptyBody.lastIndex));
  }

  return [
    ...comments, ...empty,
    ...findPatternViolations(MATRIX_PLACEHOLDER, content, "no_placeholder_tests", sectionType, PLACEHOLDER_MESSAGE),
  ];
}

// Rule 17: Test Traceability Integrity
export function checkTestTraceabilityIntegrity(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const matrixRowPattern = /^\s*\|\s*(test\w+)\s*\|/gm;
  const matrixTestNames: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = matrixRowPattern.exec(content)) !== null) {
    matrixTestNames.push(match[1]);
  }

  if (matrixTestNames.length === 0) return [];

  // source: bug found 2026-07-15, e2e run run_mrlqa0aj_u2rh15 — a testing
  // section for a bash script defined every coverage-table test as
  // `test_xxx() { ... }` and `function test_xxx() { ... }` inside fenced
  // code blocks (```bash and untagged), but the old pattern only matched
  // the Swift-style `func test_xxx(` keyword form, so every bash test was
  // reported as "no matching func found" even though it was defined.
  // Detection is language-agnostic: each pattern targets one function-
  // definition syntax; a name is "defined" if ANY pattern matches it,
  // independent of the fence's language tag (extractCodeBlocks is not
  // needed here — code block bodies are already part of `content`).
  const testFuncPatterns: readonly RegExp[] = [
    // Swift/Kotlin: func test_xxx(...)
    /func\s+(test\w+)\s*\(/g,
    // JS/TS/PHP/bash named-function keyword: function test_xxx(...)
    /function\s+(test\w+)\s*\(/g,
    // Python: def test_xxx(...)
    /def\s+(test\w+)\s*\(/g,
    // Rust: fn test_xxx(...)
    /fn\s+(test\w+)\s*\(/g,
    // Bash implicit-function form: test_xxx() { ... } / test_xxx () { ... }
    // (optional space before both the parens and the opening brace)
    //
    // `\b` is load-bearing, not decoration. This is the only pattern here with
    // no keyword prefix to anchor it, so without a boundary the engine restarts
    // at every embedded "test" and re-scans the identifier run from each one.
    // Measured on `"test".repeat(n)`: 2000 → 8.0 ms, 4000 → 30.8 ms,
    // 8000 → 122.4 ms, 16000 → 488.2 ms — quadratic (js/polynomial-redos).
    // A boundary cannot occur inside a run of word characters, so the restarts
    // collapse: flat at ≤0.1 ms across the same range.
    //
    // It also tightens the rule. `mytest_foo() {` used to register `test_foo`
    // as defined, so a matrix row naming `test_foo` passed traceability against
    // a function that is not it. Differential check over 65,290 lines of this
    // repo found 0 names that only the old form matched, so nothing real is
    // lost by requiring the boundary.
    /\b(test\w+)\s*\(\s*\)\s*\{/g,
    // Bash explicit "function" form without parens: function test_xxx { ... }
    /function\s+(test\w+)\s*\{/g,
  ];

  const definedTestNames = new Set<string>();
  for (const pattern of testFuncPatterns) {
    let funcMatch: RegExpExecArray | null;
    while ((funcMatch = pattern.exec(content)) !== null) {
      definedTestNames.add(funcMatch[1]);
    }
  }

  const violations: HardOutputRuleViolation[] = [];
  for (const matrixName of matrixTestNames) {
    if (!definedTestNames.has(matrixName)) {
      violations.push(
        makeViolation(
          "test_traceability_integrity",
          sectionType,
          `Test '${matrixName}' listed in traceability matrix but no matching func ${matrixName}() found in test code`,
          matrixName,
        ),
      );
    }
  }

  return violations;
}

// Document-Level Rule 17: Cross-Section Test Traceability
export function checkDocumentTestTraceability(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const testSections = sections.filter((s) => s.type === "testing");
  if (testSections.length === 0) return [];

  const combinedTestContent = testSections
    .map((s) => s.content)
    .join("\n\n");
  return checkTestTraceabilityIntegrity(combinedTestContent, "testing");
}
