import { describe, it, expect } from "vitest";
import { extractJsonObject, extractJsonValue } from "../utils/json-extract.js";

describe("extractJsonValue", () => {
  it("returns the array when it opens before any object", () => {
    expect(extractJsonValue('Here:\n```json\n[{"a": 1}, {"b": [2]}]\n```\ndone')).toEqual([{ a: 1 }, { b: [2] }]);
  });

  it("returns the object when it opens first, its inner arrays included", () => {
    expect(extractJsonValue('{"caveats": ["x]"], "n": 1} trailing [9]')).toEqual({ caveats: ["x]"], n: 1 });
  });

  it("throws when the text holds no JSON array or object", () => {
    expect(() => extractJsonValue("no json here")).toThrow(/no JSON array or object/);
  });

  it("throws when nothing balances", () => {
    expect(() => extractJsonValue('[{"a": 1')).toThrow(/unbalanced JSON/);
  });

  it("stops at a bracket that never closes, so a cut array is not read as its first object", () => {
    expect(() => extractJsonValue('[{"a": 1}')).toThrow(/unbalanced JSON array/);
  });

  it("stays linear on a long reply of unclosed and unparseable brackets", () => {
    const t0 = performance.now();
    expect(() => extractJsonValue("{".repeat(200_000))).toThrow(/unbalanced/);
    expect(() => extractJsonValue("[x]".repeat(100_000))).toThrow();
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it("leaves extractJsonObject reading the first object past a leading array", () => {
    expect(extractJsonObject('[1] {"verdict": "PASS"}')).toEqual({ verdict: "PASS" });
  });
});

describe("extractJsonValue skips a bracket of the prose (review note 1 of #325)", () => {
  it("reads the object after a bracketed identifier", () => {
    expect(extractJsonValue('Verdict for [AC-001]: {"verdict": "PASS"}')).toEqual({ verdict: "PASS" });
  });

  it("reads the array after a stray brace", () => {
    expect(extractJsonValue('Use {braces} sparingly. [{"claim_id": "A"}]')).toEqual([{ claim_id: "A" }]);
  });

  it("still reports the failure when no candidate parses", () => {
    expect(() => extractJsonValue("see [note] and {aside}")).toThrow();
  });
});

describe("extractJsonValue with a shape filter (review note 3 of #326)", () => {
  const isList = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "object" && x !== null);

  it("skips a span that parses but that the filter refuses", () => {
    expect(extractJsonValue('See [1] and [ ]: [{"claim_id": "A"}]', isList)).toEqual([{ claim_id: "A" }]);
  });

  it("throws, naming the shape, when every span is refused", () => {
    expect(() => extractJsonValue("only [1] here", isList)).toThrow(/expected shape/);
  });
});
