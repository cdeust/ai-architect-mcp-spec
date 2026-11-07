/**
 * Growth assertion for the symbol-existence resolution (PR #174 review
 * r4501819785). Timing-sensitive, so it runs alone under `pnpm test:perf`;
 * see `regex-hardening.perf.ts` for why timing stays out of `pnpm test`.
 *
 * Worst case for a per-bucket scan: every graph entry shares the reference's
 * last segment, and every reference is unresolved, so doubling both the graph
 * and the reference count quadruples a scan (refs × bucket). The suffix trie
 * walks O(segments) per reference, so the same doubling only doubles the work
 * (building the trie plus the lookups).
 */

import { describe, expect, it } from "vitest";
import { checkSymbolExistence } from "../index.js";

/** Below this a sample is mostly clock granularity. */
const MIN_SAMPLE_MS = 0.5;

/**
 * A quadratic worker lands near 4.0 per doubling, a linear one near 2.0.
 * source: the same ceiling and fastest-observation estimator as
 * regex-hardening.perf.ts; the trie measured 2.16–2.34 at 2k/4k references
 * (20k/40k graph entries), three runs of seven pairs, on this workspace.
 */
const QUADRATIC_GROWTH_CEILING = 3.0;

function workload(n: number): [string, string[]] {
  const graph = Array.from({ length: n * 10 }, (_, i) => `K${i}.run`);
  const prd = Array.from({ length: n }, (_, i) => `\`Q${i}.run()\``).join(" ");
  return [prd, graph];
}

function growthRatio(small: number, large: number, pairs = 7): number {
  const [ps, gs] = workload(small);
  const [pl, gl] = workload(large);
  let fastestSmall = Infinity;
  let fastestLarge = Infinity;
  for (let i = 0; i < pairs; i++) {
    let t = performance.now();
    checkSymbolExistence(ps, gs);
    fastestSmall = Math.min(fastestSmall, performance.now() - t);
    t = performance.now();
    checkSymbolExistence(pl, gl);
    fastestLarge = Math.min(fastestLarge, performance.now() - t);
  }
  return fastestLarge / Math.max(fastestSmall, MIN_SAMPLE_MS);
}

/**
 * Graph entries at the schema's 512-character bound, deep and nested.
 * Measured 2.13–2.19 at 1k/2k entries, three runs of five pairs.
 */
function pathological(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? "<".repeat(250) + ">".repeat(250) + `G${i}`
      : "a.".repeat(250) + `x${i}`);
}

function normalizationRatio(small: number, large: number, pairs = 5): number {
  const gs = pathological(small);
  const gl = pathological(large);
  let fastestSmall = Infinity;
  let fastestLarge = Infinity;
  for (let i = 0; i < pairs; i++) {
    let t = performance.now();
    checkSymbolExistence("`G0()`", gs);
    fastestSmall = Math.min(fastestSmall, performance.now() - t);
    t = performance.now();
    checkSymbolExistence("`G0()`", gl);
    fastestLarge = Math.min(fastestLarge, performance.now() - t);
  }
  return fastestLarge / Math.max(fastestSmall, MIN_SAMPLE_MS);
}

describe("checkSymbolExistence — resolution growth", () => {
  it("normalizes deep and nested graph entries in linear time (PR #174 review r4501850098)", () => {
    expect(normalizationRatio(1_000, 2_000)).toBeLessThan(QUADRATIC_GROWTH_CEILING);
  });

  it("doubling a shared-last-segment graph and the references does not quadruple the time", () => {
    // The workload must exercise resolution, not collapse to nothing.
    const [prd, graph] = workload(2_000);
    expect(checkSymbolExistence(prd, graph).unresolvedSymbols).toHaveLength(2_000);
    const ratio = growthRatio(2_000, 4_000);
    expect(ratio).toBeLessThan(QUADRATIC_GROWTH_CEILING);
  });
});
