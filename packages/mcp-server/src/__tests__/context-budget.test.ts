import { describe, it, expect } from "vitest";
import { SECTIONS_BY_CONTEXT } from "@prd-gen/orchestration";
import { calculateContextBudget, SECTION_RECALL_TEMPLATES } from "../context-budget.js";

describe("calculateContextBudget", () => {
  it("splits the window into overhead, validation reserve and usable budget", () => {
    const b = calculateContextBudget("feature");
    expect(b.overheadEstimate).toBe(40_000);
    expect(b.validationReserve).toBe(20_000);
    expect(b.totalBudget).toBe(200_000 - 40_000 - 20_000);
    expect(b.cortexRecall.totalRetrievalBudget).toBe(Math.floor(b.totalBudget * 0.4));
    expect(b.generationBudget).toBe(Math.floor(b.totalBudget * 0.5));
  });

  it("plans exactly the sections of the requested context", () => {
    const b = calculateContextBudget("proposal");
    expect(b.sections.map((s) => s.sectionType)).toEqual([...SECTIONS_BY_CONTEXT.proposal]);
  });

  it("drops completed sections from the plan", () => {
    const planned = SECTIONS_BY_CONTEXT.feature;
    const b = calculateContextBudget("feature", [planned[0]!]);
    expect(b.sections.map((s) => s.sectionType)).not.toContain(planned[0]);
    expect(b.sections).toHaveLength(planned.length - 1);
  });

  it("gives code-heavy sections more retrieval than prose sections", () => {
    const b = calculateContextBudget("feature");
    const by = Object.fromEntries(b.sections.map((s) => [s.sectionType, s]));
    if (by["technical_specification"] && by["overview"]) {
      expect(by["technical_specification"].retrievalTokens).toBeGreaterThan(
        by["overview"].retrievalTokens,
      );
    }
  });

  it("never asks Cortex for fewer than one result and mirrors the lookup", () => {
    const b = calculateContextBudget("feature", [], 1_000);
    for (const s of b.sections) {
      expect(s.cortexMaxResults).toBeGreaterThanOrEqual(1);
      expect(b.cortexRecall.maxResultsPerSection[s.sectionType]).toBe(s.cortexMaxResults);
    }
  });

  it("returns an empty plan when everything is complete", () => {
    const b = calculateContextBudget("feature", [...SECTIONS_BY_CONTEXT.feature]);
    expect(b.sections).toEqual([]);
    expect(b.cortexRecall.maxResultsPerSection).toEqual({});
  });

  it("re-exports the orchestration recall templates", () => {
    expect(Object.keys(SECTION_RECALL_TEMPLATES).length).toBeGreaterThan(0);
  });
});
