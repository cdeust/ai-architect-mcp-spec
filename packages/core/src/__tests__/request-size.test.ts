/**
 * The size of a request (#119): the values of each size, and the two
 * functions every consumer reads them through.
 */
import { describe, expect, it } from "vitest";
import {
  PRDContextSchema,
  PRD_CONTEXT_CONFIGS,
  REQUEST_SIZE_CONFIGS,
  REQUEST_SIZE_DEFAULT,
  RequestSizeSchema,
  clarificationRangeFor,
  effectiveRequestSize,
  requestSizePlan,
} from "../index.js";

describe("RequestSize", () => {
  it("has two sizes, standard by default, and a config for each", () => {
    expect(RequestSizeSchema.options).toEqual(["standard", "tiny"]);
    expect(REQUEST_SIZE_DEFAULT).toBe("standard");
    expect(Object.keys(REQUEST_SIZE_CONFIGS).sort()).toEqual(["standard", "tiny"]);
    expect(RequestSizeSchema.safeParse("huge").success).toBe(false);
  });

  it("leaves a standard run to its kind", () => {
    expect(REQUEST_SIZE_CONFIGS.standard).toEqual({ displayName: "Standard", plan: null });
  });

  it("gives a tiny run the four sections #119 names and the smallest range any kind uses", () => {
    expect(REQUEST_SIZE_CONFIGS.tiny.displayName).toBe("Tiny change");
    expect(REQUEST_SIZE_CONFIGS.tiny.plan).toEqual({
      clarificationRange: [4, 5],
      sections: ["overview", "requirements", "acceptance_criteria", "testing"],
      notFor: ["incident"],
    });
    const smallest = Math.min(...PRDContextSchema.options.map((k) => PRD_CONTEXT_CONFIGS[k].clarificationRange[0]));
    expect(REQUEST_SIZE_CONFIGS.tiny.plan!.clarificationRange[0]).toBe(smallest);
  });
});

describe("effectiveRequestSize", () => {
  it("holds a kind the size is not for to standard, and keeps the declared size of every other kind", () => {
    for (const kind of PRDContextSchema.options) {
      expect(effectiveRequestSize(kind, "tiny"), kind).toBe(kind === "incident" ? "standard" : "tiny");
      expect(effectiveRequestSize(kind, "standard"), kind).toBe("standard");
    }
  });
});

describe("requestSizePlan", () => {
  it("is the plan of the size the kind takes: none for standard, none for a kind the size is not for", () => {
    expect(REQUEST_SIZE_CONFIGS.tiny.plan!.notFor).toContain("incident");
    for (const kind of PRDContextSchema.options) {
      expect(requestSizePlan(kind, "standard"), kind).toBeNull();
      expect(requestSizePlan(kind, "tiny"), kind).toBe(kind === "incident" ? null : REQUEST_SIZE_CONFIGS.tiny.plan);
    }
  });
});

describe("clarificationRangeFor", () => {
  it("is the range of the size when it sets one, else the range of the kind", () => {
    for (const kind of PRDContextSchema.options) {
      const ownRange = PRD_CONTEXT_CONFIGS[kind].clarificationRange;
      expect(clarificationRangeFor(kind, "standard"), kind).toEqual(ownRange);
      expect(clarificationRangeFor(kind, "tiny"), kind).toEqual(kind === "incident" ? ownRange : [4, 5]);
    }
  });
});
