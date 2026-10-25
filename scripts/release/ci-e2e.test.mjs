// Contract: ci.json must exercise its built bundle through the existing runtime
// and MCPB entrypoints. Sources: scripts/smoke-portable-hosts.mjs and
// scripts/release/smoke-mcpb.sh; no model or native client account is involved.
import { afterEach, expect, test } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const COMMAND = JSON.parse(readFileSync(join(ROOT, "ci.json"), "utf8")).e2e;
const REQUIRED = [
  ["npm", "install", "-g", "pnpm@10"],
  ["pnpm", "install", "--frozen-lockfile"],
  ["pnpm", "build"],
  ["pnpm", "bundle"],
  ["pnpm", "run", "test:portable"],
  ["pnpm", "run", "test:portable:runtime"],
  ["bash", "scripts/release/smoke-mcpb.sh"],
];
const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "spec-ci-e2e-"));
  temporary.push(root);
  const log = join(root, "calls.jsonl");
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const call = [path.basename(process.argv[1]), ...process.argv.slice(2)];
fs.appendFileSync(process.env.CI_E2E_CALLS, JSON.stringify(call) + '\\n');
if (JSON.stringify(call) === process.env.CI_E2E_FAIL) process.exit(42);
`;
  for (const executable of ["npm", "pnpm", "bash"]) {
    const path = join(root, executable);
    writeFileSync(path, stub);
    chmodSync(path, 0o755);
  }
  return { root, log };
}

function execute({ root, log }, fail = null) {
  writeFileSync(log, "");
  const result = spawnSync("/bin/bash", ["-eo", "pipefail", "-c", COMMAND], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      CI_E2E_CALLS: log,
      CI_E2E_FAIL: JSON.stringify(fail),
    },
  });
  const lines = readFileSync(log, "utf8").trim();
  return { result, calls: lines ? lines.split("\n").map(JSON.parse) : [] };
}

test("E2E builds once and tests manifest, portable runtime and staged MCPB in order", () => {
  const { result, calls } = execute(fixture());
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(calls).toEqual(REQUIRED);
});

test("each failed E2E prerequisite or acceptance check stops all later commands", () => {
  const files = fixture();
  for (const [index, failure] of REQUIRED.entries()) {
    const { result, calls } = execute(files, failure);
    expect(result.error).toBeUndefined();
    expect(result.status, JSON.stringify(failure)).toBe(42);
    expect(calls).toEqual(REQUIRED.slice(0, index + 1));
  }
});
