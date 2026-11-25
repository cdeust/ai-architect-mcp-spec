// One place for the wall-clock limits of the test suite, so that no test depends
// on Vitest's own default of 5 s.
//
// A test that is only slow under load (a runner starved by sibling pipelines, a
// cold TypeScript transform, a file-heavy dry run) is not hung, and 5 s is a
// guess about the idle machine. Measured on windows-latest:
//   - frozen-baseline-provenance: 1178 ms (run 43287696855), 6080 ms (run 43293575660).
//   - real-run-cli "writes five dry-run records": 1.1 s on runs 45694096488 and
//     45694083528, more than 5 s on run 45694105645 (four pipelines at once).
// source: those job logs; precedent packages/benchmark/calibration/__tests__/code-oracle.test.ts
// and scripts/release/frozen-baseline-provenance.test.mjs (30 s).
export const TEST_TIMEOUT_MS = 30_000;

// A synchronous child (spawnSync, execFileSync) blocks the event loop, so Vitest
// cannot interrupt it: only a limit on the child itself turns a hang into a named
// error (ETIMEDOUT in `error`) instead of a silent wait for the job limit. It sits
// below the test limit so that the named error is the one reported.
// source: margin of 5 s left to Vitest to report; review of PR #219.
export const CHILD_TIMEOUT_MS = TEST_TIMEOUT_MS - 5_000;
