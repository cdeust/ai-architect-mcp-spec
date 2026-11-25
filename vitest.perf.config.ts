import { defineConfig } from "vitest/config";
import { TEST_TIMEOUT_MS } from "./vitest.shared.mts";

/**
 * Timing-sensitive assertions, run alone.
 *
 * The growth (anti-ReDoS) checks in `*.perf.ts` compare how long a validator
 * takes on an input and on twice that input. That ratio is only a property of
 * the code when the process is not fighting ~97 other test files for the CPU;
 * inside the parallel workspace it measured the scheduler often enough to fail
 * one full-suite run in six on an unchanged tree.
 *
 * So they are excluded from the default `*.test.ts` glob and run here instead:
 *
 *   fileParallelism: false   nothing else runs while a timing sample is taken
 *   maxWorkers: 1            no sibling worker competes inside this run either
 *
 * Invoked as `pnpm test:perf`, and as its own CI step so a regression is still
 * caught on every push — just not measured through a noisy instrument.
 */
export default defineConfig({
  test: {
    name: "perf",
    testTimeout: TEST_TIMEOUT_MS,
    include: ["packages/*/src/**/*.perf.ts"],
    exclude: ["**/dist/**", "**/node_modules/**", "**/.claude/**"],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
