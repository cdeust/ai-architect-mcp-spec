import { describe, it, expect } from "vitest";
import type { HardOutputRuleViolation } from "@prd-gen/core";
import { mapFailuresToRetrievals } from "../failure-mapper.js";

const v = (rule: string, message = "m"): HardOutputRuleViolation =>
  ({ rule, message, isCritical: false }) as unknown as HardOutputRuleViolation;

describe("mapFailuresToRetrievals", () => {
  it("recommends a retrieval for a retrievable category", () => {
    const r = mapFailuresToRetrievals([v("auth_on_every_endpoint", "no auth")]);
    expect(r.retryLikely).toBe(true);
    expect(r.correctiveRetrievals).toHaveLength(1);
    expect(r.correctiveRetrievals[0]!.triggeringRule).toBe("auth_on_every_endpoint");
    expect(r.correctiveRetrievals[0]!.reason).toContain("missing_security");
    expect(r.correctiveRetrievals[0]!.reason).toContain("no auth");
    expect(r.failureSummary).toContain("1 corrective retrievals");
  });

  it("deduplicates violations of the same category", () => {
    const r = mapFailuresToRetrievals([v("clean_architecture"), v("solid_compliance")]);
    expect(r.correctiveRetrievals).toHaveLength(1);
    expect(r.failureSummary).toContain("2 violations across 1 categories");
  });

  it("covers every retrievable category with a non-empty query", () => {
    const r = mapFailuresToRetrievals([
      v("clean_architecture"),
      v("no_orphan_ddl"),
      v("no_placeholder_tests"),
      v("resilience_patterns"),
      v("no_any_codable"),
      v("structured_logging"),
    ]);
    expect(r.correctiveRetrievals).toHaveLength(6);
    for (const c of r.correctiveRetrievals) {
      expect(c.query.length).toBeGreaterThan(0);
      expect(c.maxResults).toBeGreaterThan(0);
    }
  });

  it("says retry is unlikely for arithmetic and claim failures", () => {
    const r = mapFailuresToRetrievals([v("sp_arithmetic"), v("metrics_disclaimer")]);
    expect(r.retryLikely).toBe(false);
    expect(r.correctiveRetrievals).toEqual([]);
    expect(r.failureSummary).toContain("no retrieval will help");
  });

  it("treats unmapped rules as uncategorized with no retrieval", () => {
    const r = mapFailuresToRetrievals([v("totally_unknown_rule")]);
    expect(r.retryLikely).toBe(false);
    expect(r.correctiveRetrievals).toEqual([]);
  });

  it("handles no violations", () => {
    const r = mapFailuresToRetrievals([]);
    expect(r.retryLikely).toBe(false);
    expect(r.failureSummary).toContain("0 violations across 0 categories");
  });
});
