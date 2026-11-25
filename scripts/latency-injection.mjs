// Replays the failure of PR #403 on demand: `pnpm test:latency`.
//
// Run 45694105645 (windows-latest, four pipelines at once) timed out
// real-run-cli.test.ts "writes five dry-run records…" at 5 s; the same test takes
// about 1.1 s on idle runners. This slows every file write of that test by
// SLOW_FS_MS (scripts/slow-fs.mjs) and runs it twice:
//   before  with the 5 s limit of vitest's default  -> must time out;
//   after   with the limit of the workspace config  -> must pass.
// Latency, not code, is the variable: a test that does not time out under
// injection proves nothing about the limit.
//
// source: 400 ms per write measured here at about 7 s for this test (16 writes),
// above the 5 s default and well below TEST_TIMEOUT_MS.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST = join(dirname(createRequire(join(ROOT, "packages/benchmark/package.json")).resolve("vitest/package.json")), "vitest.mjs");
const SLOW_FS_MS = 400;
// source: heuristic provisional; twice the longest observed run (about 7 s) plus startup.
const RUN_LIMIT_MS = 120_000;

function run(label, extraArgs) {
  const result = spawnSync(process.execPath, [
    VITEST, "run", ...extraArgs, "src/__tests__/real-run-cli.test.ts", "-t", "writes five dry-run records",
  ], {
    cwd: join(ROOT, "packages/benchmark"),
    encoding: "utf8",
    timeout: RUN_LIMIT_MS,
    env: { ...process.env, SLOW_FS_MS: String(SLOW_FS_MS), NODE_OPTIONS: `--import ${pathUrl(join(ROOT, "scripts/slow-fs.mjs"))}` },
  });
  if (result.error) throw new Error(`${label}: ${result.error.code ?? result.error.message}`);
  const output = `${result.stdout}${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  console.log(`${label}: exit ${result.status}; ${/Test timed out in \d+ms/.exec(output)?.[0] ?? "no timeout"}`);
  return { status: result.status, output };
}

function pathUrl(path) {
  return new URL(`file://${path.startsWith("/") ? "" : "/"}${path.replaceAll("\\", "/")}`).href;
}

const before = run("before (5 s limit)", ["--testTimeout=5000"]);
const after = run("after  (workspace limit)", []);
const failures = [];
if (before.status === 0 || !/Test timed out in 5000ms/.test(before.output)) failures.push("the 5 s limit did not expire under injected latency");
if (after.status !== 0) failures.push("the workspace limit did not hold under injected latency");
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("latency injection: the old limit expires, the workspace limit passes");
