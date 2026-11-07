/**
 * Issue #118: the validators' optional `known_symbols` input. Without it the
 * report is returned unchanged (no new field for existing callers); with it
 * the report gains `symbolExistence`.
 */

import { describe, expect, it } from "vitest";
import { KnownSymbolsSchema, withSymbolCheck } from "../symbol-check.js";

describe("withSymbolCheck", () => {
  const report = { totalScore: 1 };

  it("returns the report unchanged when no symbols are supplied", () => {
    expect(withSymbolCheck(report, "`Ghost.run()`", undefined)).toBe(report);
  });

  it("adds symbolExistence when the host sends its graph symbols", () => {
    const out = withSymbolCheck(report, ["`Ghost.run()`", "`parseConfig()`"], ["parseConfig"]);
    expect(out.totalScore).toBe(1);
    expect(out.symbolExistence).toEqual({
      checkedSymbols: 2,
      knownSymbols: 1,
      unresolvedSymbols: [{ symbol: "Ghost.run", occurrences: 1 }],
    });
  });

  it("checks against an empty graph when an empty list is sent", () => {
    expect(withSymbolCheck(report, "`a()`", []).symbolExistence?.unresolvedSymbols)
      .toEqual([{ symbol: "a", occurrences: 1 }]);
  });
});

describe("KnownSymbolsSchema", () => {
  it("is optional and accepts a list of strings only", () => {
    expect(KnownSymbolsSchema.parse(undefined)).toBeUndefined();
    expect(KnownSymbolsSchema.parse(["A.b"])).toEqual(["A.b"]);
    expect(KnownSymbolsSchema.safeParse([1]).success).toBe(false);
  });
});
