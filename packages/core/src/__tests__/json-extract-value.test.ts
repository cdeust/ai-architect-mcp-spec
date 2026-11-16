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

  it("throws on an unbalanced array", () => {
    expect(() => extractJsonValue('[{"a": 1}')).toThrow(/unbalanced JSON array/);
  });

  it("leaves extractJsonObject reading the first object past a leading array", () => {
    expect(extractJsonObject('[1] {"verdict": "PASS"}')).toEqual({ verdict: "PASS" });
  });
});
