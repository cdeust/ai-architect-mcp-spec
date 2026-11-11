/**
 * Paging tests for `get_pipeline_state(run_id, format:"action")` (#125).
 *
 * The refetch a host follows after a bounded spawn_subagents envelope returned
 * the whole unbounded action in one response: about 112k chars in the
 * 2026-10-10 audit of v0.8.0, above the 100,000-char budget the server
 * declares. These tests hold every page to that budget and prove that walking
 * `next_offset` returns every invocation, prompt intact, exactly once.
 */
import { describe, expect, it } from "vitest";
import { MAX_RESPONSE_CHARS } from "@prd-gen/orchestration";
import { pageActionResponse, selfMeasuredChars, type ActionPage } from "../page-action-response.js";

function judgeBatch(count: number, promptChars: number) {
  return {
    kind: "spawn_subagents" as const,
    batch_id: "self_check_verify",
    purpose: "judge",
    invocations: Array.from({ length: count }, (_, i) => ({
      invocation_id: `self_check_judge_${String(i).padStart(4, "0")}`,
      subagent_type: "zetetic-team-subagents:dijkstra",
      description: `Judge claim ${i}`,
      prompt: `${i}:` + "x".repeat(promptChars),
      isolation: "none" as const,
    })),
  };
}

function wireChars(value: unknown): number {
  return JSON.stringify(value, null, 2).length;
}

function walk(action: unknown, budgetChars?: number): ActionPage[] {
  const pages: ActionPage[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = pageActionResponse("run_page", action, offset, budgetChars);
    if ("error" in page) throw new Error(page.error);
    pages.push(page);
    offset = page.__page.next_offset;
    if (pages.length > 10_000) throw new Error("walk does not terminate");
  }
  return pages;
}

describe("pageActionResponse", () => {
  it("holds every page of an oversized judge batch within the declared budget", () => {
    // 3 × 37k ≈ the audit's 112k refetch; 89 × 37k is the e2e 3.5MB batch.
    for (const count of [3, 89]) {
      const action = judgeBatch(count, 37_000);
      expect(wireChars(action)).toBeGreaterThan(MAX_RESPONSE_CHARS);
      for (const page of walk(action)) {
        const shipped = wireChars(page);
        expect(shipped).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
        expect(page.__page.final_chars).toBe(shipped);
        expect(page.__page.budget_chars).toBe(MAX_RESPONSE_CHARS);
      }
    }
  });

  it("returns every invocation exactly once, in order, with its prompt whole", () => {
    const action = judgeBatch(89, 37_000);
    const pages = walk(action);
    const seen = pages.flatMap(
      (p) => (p.action as { invocations: unknown[] }).invocations,
    );
    expect(seen).toEqual(action.invocations);
    let expectedOffset = 0;
    for (const page of pages) {
      expect(page.__page.offset).toBe(expectedOffset);
      expect(page.__page.total).toBe(89);
      expectedOffset += page.__page.count;
    }
    expect(pages[pages.length - 1].__page.next_offset).toBeNull();
  });

  it("keeps every non-invocation field of the action on each page", () => {
    for (const page of walk(judgeBatch(5, 37_000))) {
      const a = page.action as Record<string, unknown>;
      expect(a.kind).toBe("spawn_subagents");
      expect(a.batch_id).toBe("self_check_verify");
      expect(a.purpose).toBe("judge");
    }
  });

  it("packs as many invocations as fit, so a small batch is a single page", () => {
    const action = judgeBatch(40, 500);
    const pages = walk(action);
    expect(pages).toHaveLength(1);
    expect(pages[0].action).toEqual(action);
    expect(pages[0].__page).toMatchObject({ offset: 0, count: 40, total: 40, next_offset: null });
  });

  it("fills each page: adding the next invocation would overshoot the budget", () => {
    const action = judgeBatch(30, 9_000);
    for (const page of walk(action)) {
      const { offset, count, next_offset } = page.__page;
      if (next_offset === null) continue;
      const bigger = {
        ...page,
        action: { ...action, invocations: action.invocations.slice(offset, offset + count + 1) },
      };
      expect(wireChars(bigger)).toBeGreaterThan(MAX_RESPONSE_CHARS);
    }
  });

  it("returns an invocation larger than the budget whole, on its own page, with the overshoot visible", () => {
    const action = judgeBatch(2, MAX_RESPONSE_CHARS + 5_000);
    const pages = walk(action);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page.__page.count).toBe(1);
      expect(page.__page.final_chars).toBeGreaterThan(page.__page.budget_chars);
    }
    const first = (pages[0].action as { invocations: Array<{ prompt: string }> }).invocations[0];
    expect(first.prompt).toBe(action.invocations[0].prompt);
  });

  it("returns a non-spawn_subagents action whole on one page", () => {
    const action = { kind: "done", summary: "ok", artifacts: [] };
    const page = pageActionResponse("run_page", action, 0);
    expect("error" in page).toBe(false);
    expect((page as ActionPage).action).toEqual(action);
    expect((page as ActionPage).__page.next_offset).toBeNull();
  });

  it("rejects NaN, negative and fractional offsets instead of dropping or misplacing invocations", () => {
    const action = judgeBatch(3, 37_000);
    for (const bad of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(pageActionResponse("run_page", action, bad)).toMatchObject({
        error: expect.stringContaining("is not a non-negative integer"),
      });
    }
  });

  it("returns an empty batch as one empty page", () => {
    const action = judgeBatch(0, 10);
    const page = pageActionResponse("run_page", action, 0) as ActionPage;
    expect(page.__page).toMatchObject({ offset: 0, count: 0, total: 0, next_offset: null });
    expect(page.action).toEqual(action);
  });

  it("walks a mixed batch (small, oversize, small) without losing an invocation", () => {
    const action = judgeBatch(3, 10);
    action.invocations[1].prompt = "y".repeat(MAX_RESPONSE_CHARS + 1_000);
    const pages = walk(action);
    expect(pages.map((p) => p.__page.count)).toEqual([1, 1, 1]);
    expect(pages[0].__page.final_chars).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(pages[1].__page.final_chars).toBeGreaterThan(MAX_RESPONSE_CHARS);
    expect(pages[2].__page.final_chars).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const seen = pages.flatMap((p) => (p.action as { invocations: unknown[] }).invocations);
    expect(seen).toEqual(action.invocations);
  });

  it("finds full pages for every batch and page size around the doubling boundaries", () => {
    // The sweep runs at a tenth of the server's budget. The search compares
    // serialized sizes with the budget and nothing else, so the page sizes
    // it must find (both edges of every doubling bracket) are the same at
    // any budget, and the real 100,000-char budget is held by the tests
    // above. At the real budget this sweep serialized 300 MB of JSON in
    // 3,916 passes: 1.1 to 2.2 s alone and 2.1 to 5.1 s inside `pnpm test`,
    // against vitest's 5 s timeout (30 and 10 runs on 2026-11-11, one
    // timeout). A tenth leaves the largest page (17 invocations) prompts of
    // about 330 chars, above the per-invocation overhead measured below.
    const budget = MAX_RESPONSE_CHARS / 10;
    // Prompt sizes chosen so a page holds each of 1 to 17 invocations: both
    // edges of every doubling bracket up to 16, and the sizes inside each
    // bracket, which only the binary search reaches (a search that skipped
    // a candidate passed the edges-only sweep).
    const pageSizes = Array.from({ length: 17 }, (_, i) => i + 1);
    // Measured, not guessed: the envelope of an empty page and the wire cost
    // of one invocation with an empty prompt (its `${i}:` prefix included).
    const envelope = wireChars({
      run_id: "run_page",
      action: judgeBatch(0, 0),
      __page: { offset: 0, count: 0, total: 0, next_offset: null, final_chars: budget, budget_chars: budget },
    });
    const perInvocation = Math.ceil((wireChars(judgeBatch(20, 0)) - wireChars(judgeBatch(0, 0))) / 20);
    const promptSizes = pageSizes.map(
      (n) => Math.floor((budget - envelope) / (n + 0.5)) - perInvocation,
    );
    for (const promptChars of promptSizes) expect(promptChars).toBeGreaterThan(0);
    const seenPageSizes = new Set<number>();
    for (const [count, promptChars] of [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 33].flatMap((c) =>
      promptSizes.map((p) => [c, p] as const),
    )) {
      const action = judgeBatch(count, promptChars);
      const pages = walk(action, budget);
      for (const page of pages) {
        expect(page.__page.budget_chars).toBe(budget);
        expect(page.__page.final_chars).toBe(wireChars(page));
        expect(page.__page.final_chars).toBeLessThanOrEqual(budget);
        const { offset, count: n, next_offset } = page.__page;
        if (next_offset === null) continue;
        const bigger = {
          ...page,
          action: { ...action, invocations: action.invocations.slice(offset, offset + n + 1) },
        };
        expect(wireChars(bigger)).toBeGreaterThan(budget);
        seenPageSizes.add(n);
      }
      const seen = pages.flatMap((p) => (p.action as { invocations: unknown[] }).invocations);
      expect(seen).toEqual(action.invocations);
    }
    for (const n of pageSizes) expect(seenPageSizes).toContain(n);
  });

  it("reports as final_chars the size of the response that carries it", () => {
    // `zero` is the size with `final_chars: 0`; the shipped size replaces
    // that one character by its own digits. 99,995 and 99,996 sit on each
    // side of the step from five to six digits.
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

  it("rejects an offset past the end of the batch, and any offset on a non-batch action", () => {
    expect(pageActionResponse("run_page", judgeBatch(3, 10), 3)).toMatchObject({
      error: expect.stringContaining("the batch has 3 invocations"),
    });
    for (const action of [{ kind: "done" }, null]) {
      expect(pageActionResponse("run_page", action, 1)).toMatchObject({
        error: expect.stringContaining("is not a spawn_subagents batch"),
      });
    }
  });
});
