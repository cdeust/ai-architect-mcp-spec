// Contract: the frozen-baseline provenance guard runs in CI. ci.json regression
// discovers only `test_ci_codex*.py`, so `pnpm test` (the unit job) runs the
// standard-library guard scripts/tests/test_frozen_baseline_is_provenance.py here.
import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = "test_frozen_baseline_is_provenance.py";

// Above vitest's 5000ms default: the test starts a Python interpreter, and
// under full-suite parallel load that start scales with runner load. On
// windows-latest it took 1178ms in run 43287696855 (job 131426502011) and
// 6080ms in run 43293575660 (job 131446875348, PR #219), a timeout, not a
// guard failure. 30s follows code-oracle.test.ts: the same headroom, and a
// hung interpreter still fails.
// source: the two job logs above; precedent packages/benchmark/calibration/__tests__/code-oracle.test.ts.
const GUARD_TIMEOUT_MS = 30_000;

test("plan and calibration sources carry no commit gate", () => {
  const run = spawnSync(
    // The Windows runner image and python.org installers name it `python`.
    process.platform === "win32" ? "python" : "python3",
    ["-B", "-m", "unittest", "discover", "-s", "scripts/tests", "-p", GUARD, "-v"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const output = [run.error, run.stdout, run.stderr].filter(Boolean).join("\n");
  expect(run.status, output).toBe(0);
  expect(output).toMatch(/^Ran 2 tests/m);
}, GUARD_TIMEOUT_MS);
