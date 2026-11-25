// The wall-clock invariant of the test suite (see vitest.shared.mts):
//   1. no project relies on Vitest's default 5 s test timeout;
//   2. no test starts a synchronous child without a limit of its own, because
//      Vitest cannot interrupt a blocked event loop and a hang would end only
//      when the CI job is killed, with no name for the cause.
// scripts/gate is left out: the delivery gate is not touched by this change
// (its tests already bound each child with PROCESS.timeout = 30 s).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CHILD_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../../vitest.shared.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIPPED = new Set(["node_modules", "dist", ".claude", ".git", "gate"]);
const SYNC_CALL = /\b(?:spawnSync|execFileSync|execSync)\(/g;

function* testSources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* testSources(path);
    else if (/\.(?:ts|mjs)$/.test(entry.name) && /(?:\.test\.|__tests__)/.test(path) && path !== fileURLToPath(import.meta.url)) yield path;
  }
}

/** Code of the call whose opening parenthesis is at `open`, with string contents and comments blanked. */
export function callText(source, open) {
  let depth = 0;
  let code = "";
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
      code += '""';
    } else if (c === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i < 0) break;
    } else {
      code += c;
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return code;
    }
  }
  throw new Error("unbalanced call");
}

export function unboundedSyncCalls(source) {
  const found = [];
  for (const match of source.matchAll(SYNC_CALL)) {
    const call = callText(source, match.index + match[0].length - 1);
    if (!/\btimeout\b/.test(call)) found.push(source.slice(0, match.index).split("\n").length);
  }
  return found;
}

describe("the wall-clock limits of the test suite", () => {
  it("keeps the child limit below the test limit", () => {
    expect(CHILD_TIMEOUT_MS).toBeLessThan(TEST_TIMEOUT_MS);
  });

  it("sets the test timeout of every project except the delivery gate", async () => {
    const root = readFileSync(join(ROOT, "vitest.config.mts"), "utf8");
    const projects = [...root.matchAll(/"\.\/([^"]+vitest\.config\.m?ts)"/g)].map(m => m[1]).filter(p => !p.startsWith("scripts/gate/"));
    expect(projects.length).toBeGreaterThanOrEqual(10);
    for (const project of projects) {
      const config = (await import(pathToFileURL(join(ROOT, project)).href)).default;
      expect({ project, timeout: config.test?.testTimeout }).toEqual({ project, timeout: TEST_TIMEOUT_MS });
    }
  });

  it("bounds every synchronous child started by a test", () => {
    const unbounded = [];
    for (const dir of ["packages", "scripts"]) {
      for (const file of testSources(join(ROOT, dir))) {
        for (const line of unboundedSyncCalls(readFileSync(file, "utf8"))) unbounded.push(`${relative(ROOT, file)}:${line}`);
      }
    }
    expect(unbounded).toEqual([]);
  });

  it("ends a hung child in a named error instead of a silent wait", () => {
    // source: 300 ms is far below any real child here; the child would otherwise sleep for 10 s.
    const run = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { timeout: 300 });
    expect(run.error?.code).toBe("ETIMEDOUT");
    expect(run.signal).toBe("SIGTERM");
  });

  it("recognises a call without a limit, whatever its arguments contain", () => {
    expect(unboundedSyncCalls('spawnSync("a", ["-c", "timeout"])')).toEqual([1]);
    expect(unboundedSyncCalls('x\nspawnSync("a", [], { timeout: 1 })')).toEqual([]);
    expect(unboundedSyncCalls("execFileSync(f, a, {\n  encoding: 'utf8' })")).toEqual([1]);
    expect(unboundedSyncCalls("execSync(`a (${b}`, {timeout})")).toEqual([]);
  });
});
