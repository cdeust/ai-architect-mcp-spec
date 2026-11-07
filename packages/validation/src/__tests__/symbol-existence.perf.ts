/**
 * Growth assertion for the symbol-existence resolution (PR #174 review
 * r4501819785). Timing-sensitive, so it runs alone under `pnpm test:perf`;
 * see `regex-hardening.perf.ts` for why timing stays out of `pnpm test`.
 *
 * Worst case for a per-bucket scan: every graph entry shares the reference's
 * last segment, and every reference is unresolved, so doubling both the graph
 * and the reference count quadruples a scan (refs × bucket). The current code
 * builds a trie of the references and walks each graph entry through it once
 * (O(segments) per entry, O(segments) per reference lookup), so the same
 * doubling only doubles the work.
 */

import { describe, expect, it } from "vitest";
import { checkSymbolExistence } from "../index.js";

/** Below this a sample is mostly clock granularity. */
const MIN_SAMPLE_MS = 0.5;

/**
 * A quadratic worker lands near 4.0 per doubling, a linear one near 2.0.
 * source: the same ceiling and fastest-observation estimator as
 * regex-hardening.perf.ts; measured 2.02–2.38 at 2k/4k references (20k/40k
 * graph entries) with the reference-trie code, six runs of seven pairs.
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
 * 2,000 graph entries of a given length: nested generics and a run of `?`.
 * The count is fixed and the length doubles, so per-entry work that grows
 * with the length squared (a pass per nesting level, an unanchored
 * `/[?!]+$/`) shows near 4x, and linear work near 2x (PR #174 review
 * r4501882470). Every entry shares the reference's last segment, so all of
 * them walk the reference trie. At depth 250 vs 500 (entries up to ~505 characters,
 * inside the 512 schema bound), measured runs of five pairs: the
 * reference-trie code 1.58–2.30; the previous multi-pass `stripGenerics` with an unanchored
 * `/[?!]+$/` 3.42–3.59.
 */
function pathological(depth: number): string[] {
  return Array.from({ length: 2_000 }, (_, i) =>
    i % 2 === 0
      ? `G${i}` + "<".repeat(depth) + ">".repeat(depth) + ".run"
      : `Q${i}.run` + "?".repeat(depth));
}

function normalizationRatio(small: number, large: number, pairs = 5): number {
  const gs = pathological(small);
  const gl = pathological(large);
  let fastestSmall = Infinity;
  let fastestLarge = Infinity;
  for (let i = 0; i < pairs; i++) {
    let t = performance.now();
    checkSymbolExistence("`Ghost.run()`", gs);
    fastestSmall = Math.min(fastestSmall, performance.now() - t);
    t = performance.now();
    checkSymbolExistence("`Ghost.run()`", gl);
    fastestLarge = Math.min(fastestLarge, performance.now() - t);
  }
  return fastestLarge / Math.max(fastestSmall, MIN_SAMPLE_MS);
}

describe("checkSymbolExistence — resolution growth", () => {
  it("normalizes deep and nested graph entries in linear time (PR #174 review r4501850098)", () => {
    expect(normalizationRatio(250, 500)).toBeLessThan(QUADRATIC_GROWTH_CEILING);
  });

  it("doubling a shared-last-segment graph and the references does not quadruple the time", () => {
    // The workload must exercise resolution, not collapse to nothing.
    const [prd, graph] = workload(2_000);
    expect(checkSymbolExistence(prd, graph).unresolvedSymbols).toHaveLength(2_000);
    const ratio = growthRatio(2_000, 4_000);
    expect(ratio).toBeLessThan(QUADRATIC_GROWTH_CEILING);
  });
});
