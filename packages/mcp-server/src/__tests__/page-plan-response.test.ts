/**
 * Unit tests for the paging of verification plans (#125) and the page
 * fitting it relies on. The sweeps run at small budgets: the search compares
 * sizes with the budget and nothing else, and the real 100,000-char budget
 * is held end to end by verification-response-budget.test.ts.
 */
import { describe, expect, it } from "vitest";
import { MAX_RESPONSE_CHARS } from "@prd-gen/orchestration";
import type { VerificationPlan } from "@prd-gen/verification";
import { largestFittingCount, selfMeasuredChars } from "../fit-page.js";
import { pagePlanResponse, planWireText, type PlanPage } from "../page-plan-response.js";

function plan(requests: number, excerptChars: number, claims = 3): VerificationPlan {
  const claim = (i: number) => ({
    claim_id: `FR-${String(i).padStart(3, "0")}`,
    claim_type: "fr_traceability" as const,
    text: `Requirement ${i}`,
    evidence: `- FR-${i}: evidence`,
    source_section: "requirements" as const,
  });
  const all = Array.from({ length: claims }, (_, i) => claim(i));
  return {
    claims: all,
    judge_requests: Array.from({ length: requests }, (_, i) => ({
      judge: { kind: "genius" as const, name: "dijkstra" as const },
      claim: claim(i),
      context: { prd_excerpt: `${i}:` + "x".repeat(excerptChars), codebase_excerpts: [], memory_excerpts: [] },
    })),
    mechanical_claims: all.slice(0, 1),
  } as unknown as VerificationPlan;
}

function walk(p: VerificationPlan, budget?: number): PlanPage[] {
  const pages: PlanPage[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = pagePlanResponse(p, offset, budget);
    if ("error" in page) throw new Error(page.error);
    pages.push(page);
    offset = page.__page.next_offset;
    if (pages.length > 10_000) throw new Error("walk does not terminate");
  }
  return pages;
}

describe("selfMeasuredChars", () => {
  it("is the size of the response that carries it", () => {
    // `zero` is the size with a 0 placeholder; the shipped size replaces that
    // one character by its own digits. 99,995 and 99,996 sit on each side of
    // the step from five to six digits.
    for (const [zero, shipped] of [
      [9, 9],
      [10, 11],
      [98, 99],
      [99, 101],
      [99_995, 99_999],
      [99_996, 100_001],
      [100_000, 100_005],
    ] as const) {
      expect(selfMeasuredChars(zero)).toBe(shipped);
      expect(shipped - String(shipped).length).toBe(zero - 1);
    }
  });
});

describe("largestFittingCount", () => {
  it("finds the largest count that fits, for every capacity and remainder up to 40", () => {
    // Items of size 1 under a budget equal to the capacity: the answer is
    // min(capacity, remaining), and 1 when nothing fits.
    for (let remaining = 1; remaining <= 40; remaining++) {
      for (let capacity = 0; capacity <= 41; capacity++) {
        const probes: number[] = [];
        const found = largestFittingCount(
          (n) => {
            probes.push(n);
            return n;
          },
          remaining,
          capacity,
        );
        expect(found, `remaining ${remaining}, capacity ${capacity}`).toBe(
          Math.max(1, Math.min(capacity, remaining)),
        );
        for (const n of probes) {
          expect(n).toBeGreaterThanOrEqual(1);
          expect(n).toBeLessThanOrEqual(remaining);
          // No probe measures more than twice the page it ends up returning,
          // plus the one item that proves the next size does not fit.
          expect(n).toBeLessThanOrEqual(2 * found + 1);
        }
      }
    }
  });
});

describe("pagePlanResponse", () => {
  it("returns a plan that fits whole, on one page, with its size", () => {
    const p = plan(4, 200);
    const page = pagePlanResponse(p, 0) as PlanPage;
    expect(page.claims).toEqual(p.claims);
    expect(page.judge_requests).toEqual(p.judge_requests);
    expect(page.mechanical_claims).toEqual(p.mechanical_claims);
    expect(page.__page).toMatchObject({ offset: 0, count: 4, total: 4, next_offset: null });
    expect(page.__page.budget_chars).toBe(MAX_RESPONSE_CHARS);
    expect(page.__page.final_chars).toBe(planWireText(page).length);
  });

  it("returns a plan with no judge request as one page that keeps its claims", () => {
    const p = plan(0, 0);
    const page = pagePlanResponse(p, 0) as PlanPage;
    expect(page.claims).toEqual(p.claims);
    expect(page.mechanical_claims).toEqual(p.mechanical_claims);
    expect(page.__page).toMatchObject({ offset: 0, count: 0, total: 0, next_offset: null });
  });

  it("fills every page and visits every request once, for page sizes 1 to 17", () => {
    const budget = 10_000;
    // Measured, not guessed: the wire cost of one request with an empty
    // excerpt, and of a page that holds none.
    const perRequest = Math.ceil(
      (planWireText({ judge_requests: plan(20, 0).judge_requests, __page: {} as never }).length -
        planWireText({ judge_requests: [], __page: {} as never }).length) /
        20,
    );
    const firstPageBase = (pagePlanResponse(plan(0, 0), 0) as PlanPage).__page.final_chars;
    const seenCounts = new Set<number>();
    for (let size = 1; size <= 17; size++) {
      const excerpt = Math.floor((budget - firstPageBase) / (size + 0.5)) - perRequest;
      expect(excerpt).toBeGreaterThan(0);
      for (const requests of [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 33, 50]) {
        const p = plan(requests, excerpt);
        const pages = walk(p, budget);
        for (const page of pages) {
          expect(page.__page.final_chars).toBe(planWireText(page).length);
          expect(page.__page.final_chars).toBeLessThanOrEqual(budget);
          expect(page.__page.budget_chars).toBe(budget);
          const { offset, count, next_offset } = page.__page;
          if (next_offset === null) continue;
          const bigger = { ...page, judge_requests: p.judge_requests.slice(offset, offset + count + 1) };
          expect(planWireText(bigger).length).toBeGreaterThan(budget);
          seenCounts.add(count);
        }
        expect(pages.flatMap((page) => page.judge_requests)).toEqual(p.judge_requests);
        expect(pages[0].claims).toEqual(p.claims);
        for (const later of pages.slice(1)) {
          expect(later).not.toHaveProperty("claims");
          expect(later).not.toHaveProperty("mechanical_claims");
        }
      }
    }
    for (let size = 1; size <= 17; size++) expect(seenCounts).toContain(size);
  });

  it("returns a request larger than the budget whole, on its own page, with the overshoot visible", () => {
    const p = plan(3, 10);
    (p.judge_requests[1].context as { prd_excerpt: string }).prd_excerpt = "y".repeat(3_000);
    const pages = walk(p, 2_000);
    const oversize = pages.find((page) => page.__page.offset === 1)!;
    expect(oversize.__page.count).toBe(1);
    expect(oversize.__page.final_chars).toBeGreaterThan(oversize.__page.budget_chars);
    expect(oversize.judge_requests[0]).toEqual(p.judge_requests[1]);
    expect(pages.flatMap((page) => page.judge_requests)).toEqual(p.judge_requests);
  });

  it("rejects NaN, negative, fractional and out-of-range offsets", () => {
    const p = plan(3, 10);
    for (const bad of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(pagePlanResponse(p, bad)).toMatchObject({
        error: expect.stringContaining("is not a non-negative integer"),
      });
    }
    expect(pagePlanResponse(p, 3)).toMatchObject({
      error: expect.stringContaining("the plan has 3 judge requests"),
    });
    expect(pagePlanResponse(plan(0, 0), 1)).toMatchObject({
      error: expect.stringContaining("the plan has 0 judge requests"),
    });
  });
});
