// The check that keeps the committed dist and the shipped bundle equal to the
// build of the source. Each case is a repository where a "build" has just been
// run on top of a commit, which is the state CI sees after `pnpm build && pnpm bundle`.
import { afterEach, expect, test } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// source: 30 s test timeout minus the 5 s margin left to Vitest to report (PR #407, vitest.shared.mts).
const CHILD_TIMEOUT_MS = 25_000;

const SOURCE = fileURLToPath(new URL("../check-dist-in-sync.mjs", import.meta.url));
const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...args) => {
  const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
  expect(run.status, run.stderr).toBe(0);
};
const write = (root, path, text) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};

/** A repository whose commit holds a source, its dist and its bundle, all consistent. */
function committed() {
  const root = mkdtempSync(join(tmpdir(), "dist-in-sync-"));
  temporary.push(root);
  git(root, "init", "-q");
  write(root, "packages/app/src/a.ts", "export const a = 1;\n");
  write(root, "packages/app/dist/a.js", "export const a = 1;\n");
  write(root, "mcp-server/index.js", "var a = 1;\n");
  write(root, "mcp-server/package.json", '{"version":"1.0.0"}\n');
  mkdirSync(join(root, "scripts"));
  copyFileSync(SOURCE, join(root, "scripts/check-dist-in-sync.mjs")); // the script finds the repository from its own location
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

function check(root, { cwd = root, env: extra = {} } = {}) {
  const run = spawnSync(process.execPath, [join(root, "scripts/check-dist-in-sync.mjs")], { cwd, encoding: "utf8", timeout: CHILD_TIMEOUT_MS, env: { ...process.env, ...extra } });
  expect(run.error).toBeUndefined();
  return run;
}

test("passes when the build reproduces the committed files", () => {
  const root = committed();
  write(root, "packages/app/dist/a.js", "export const a = 1;\n"); // the build rewrites the same bytes
  const run = check(root);
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain("match the build of the source");
});

test("fails when the source changed and the dist was not rebuilt before the commit", () => {
  const root = committed();
  write(root, "packages/app/src/a.ts", "export const a = 2;\n");
  git(root, "commit", "-qam", "change the source only");
  write(root, "packages/app/dist/a.js", "export const a = 2;\n"); // what the CI build now produces
  const run = check(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(" M packages/app/dist/a.js");
  expect(run.stderr).toContain("Run 'pnpm build && pnpm bundle' and commit");
});

test("fails when only the shipped bundle is stale", () => {
  const root = committed();
  write(root, "mcp-server/index.js", "var a = 2;\n");
  const run = check(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(" M mcp-server/index.js");
  expect(run.stderr).not.toContain("packages/app/dist");
});

test("fails when the stamped version beside the bundle is stale", () => {
  const root = committed();
  write(root, "mcp-server/package.json", '{"version":"1.1.0"}\n'); // what `pnpm bundle` stamps from the root version
  const run = check(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(" M mcp-server/package.json");
});

test("fails when the build produces a file that was never committed", () => {
  const root = committed();
  write(root, "packages/app/dist/b.js", "export const b = 1;\n");
  const run = check(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("?? packages/app/dist/b.js");
});

test("ignores a change outside the generated files", () => {
  const root = committed();
  write(root, "packages/app/src/a.ts", "export const a = 3;\n");
  write(root, "README.md", "notes\n");
  expect(check(root).status).toBe(0);
});

// What a developer's own git configuration, or the directory they start from, must not change.

test("looks at the whole repository when started from a sub directory", () => {
  const root = committed();
  write(root, "mcp-server/index.js", "var a = 2;\n");
  const run = check(root, { cwd: join(root, "packages/app/src") });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(" M mcp-server/index.js");
});

test("sees a new generated file even when git is told to hide untracked files", () => {
  const root = committed();
  git(root, "config", "status.showUntrackedFiles", "no");
  const home = mkdtempSync(join(tmpdir(), "dist-in-sync-home-"));
  temporary.push(home);
  writeFileSync(join(home, "gitconfig"), "[status]\n\tshowUntrackedFiles = no\n");
  write(root, "packages/app/dist/b.js", "export const b = 1;\n");
  // the user's global configuration says the same; the script must use neither
  const run = check(root, { env: { GIT_CONFIG_GLOBAL: join(home, "gitconfig") } });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("?? packages/app/dist/b.js");
});

test("reports a path that git would quote", () => {
  const root = committed();
  write(root, "packages/app/dist/é à.js", "x\n");
  git(root, "config", "core.quotePath", "true");
  const run = check(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("?? packages/app/dist/é à.js");
});

test.skipIf(process.platform === "win32")("sees a mode change even when git is told to ignore modes", () => {
  const root = committed();
  git(root, "config", "core.fileMode", "false");
  chmodSync(join(root, "mcp-server/index.js"), 0o755);
  const run = check(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain(" M mcp-server/index.js");
});

test("refuses a generated file that git has been told not to look at", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const root = committed();
    git(root, "update-index", flag, "packages/app/dist/a.js");
    write(root, "packages/app/dist/a.js", "export const a = 9;\n");
    const run = check(root);
    expect(run.status, flag).toBe(1);
    expect(run.stderr, flag).toContain("hidden from git status");
    expect(run.stderr, flag).toContain("packages/app/dist/a.js");
  }
});

test("refuses a sparse checkout that leaves generated files out", () => {
  const root = committed();
  git(root, "sparse-checkout", "set", "--no-cone", "/scripts/", "/packages/app/src/");
  const run = check(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("hidden from git status");
});

test("fails when there is no generated file to compare", () => {
  const root = mkdtempSync(join(tmpdir(), "dist-in-sync-empty-"));
  temporary.push(root);
  git(root, "init", "-q");
  mkdirSync(join(root, "scripts"));
  copyFileSync(SOURCE, join(root, "scripts/check-dist-in-sync.mjs"));
  write(root, "README.md", "notes\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const run = check(root);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("no generated file");
});

test("refuses to run in a directory that is not the root of its repository", () => {
  const outer = mkdtempSync(join(tmpdir(), "dist-in-sync-outer-"));
  temporary.push(outer);
  git(outer, "init", "-q");
  const inner = join(outer, "nested");
  mkdirSync(join(inner, "scripts"), { recursive: true });
  copyFileSync(SOURCE, join(inner, "scripts/check-dist-in-sync.mjs"));
  const run = check(inner);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("not the root of its git repository");
});
