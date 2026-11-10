// Contract: the frozen-baseline provenance guard runs in CI. ci.json regression
// discovers only `test_ci_codex*.py`, so `pnpm test` (the unit job) runs the
// standard-library guard scripts/tests/test_frozen_baseline_is_provenance.py here.
import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = "test_frozen_baseline_is_provenance.py";

test("plan and calibration sources carry no commit gate", () => {
  const run = spawnSync(
    "python3",
    ["-B", "-m", "unittest", "discover", "-s", "scripts/tests", "-p", GUARD, "-v"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const output = [run.error, run.stdout, run.stderr].filter(Boolean).join("\n");
  expect(run.status, output).toBe(0);
  expect(output).toMatch(/^Ran 2 tests/m);
});
