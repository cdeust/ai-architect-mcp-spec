/**
 * CPU time consumed by this process, in milliseconds.
 *
 * The growth ratios in the *.perf.ts files compare the cost of an input with
 * the cost of twice that input. Wall-clock time counts the time the process
 * spent waiting for a core, and when sibling pipelines or a loaded machine
 * hold the cores that wait lands unevenly on the two sizes: a ratio of 3.17
 * against a ceiling of 3.0 was seen on a linear workload (PR #405, passed on
 * retry). CPU time counts only the cycles the process ran, so the load that
 * made the wall clock drift mostly drops out, and a quadratic worker still
 * costs four times as many cycles per doubling.
 *
 * source: measured by scripts/perf-load-injection.mjs (`pnpm test:perf:load`);
 * results are in the PR that introduced this file.
 */
export function cpuMillis(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}
