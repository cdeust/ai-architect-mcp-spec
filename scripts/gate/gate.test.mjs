/**
 * The delivery gate (scripts/gate).
 *
 * Proves: (1) the perimeter of mutation is the production lines a diff adds
 * or changes, and nothing else; (2) a delivery is recognised from the tool
 * call and from the configuration alone; (3) the hook, run as the process
 * Claude Code runs, lets a delivery through only for a tree with a passed
 * verdict, in a real repository.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { changedLines, productionChanges, judgeMutants, isDelivery, resolveProfile } from "./gate-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "delivery-gate.json"), "utf8"));

const DIFF = [
  "diff --git a/packages/core/src/a.ts b/packages/core/src/a.ts",
  "--- a/packages/core/src/a.ts",
  "+++ b/packages/core/src/a.ts",
  "@@ -3 +3,2 @@ context",
  "+x",
  "+y",
  "@@ -10,4 +11,0 @@",
  "-gone",
  "@@ -20,0 +18 @@",
  "+one",
  "diff --git a/packages/core/src/__tests__/a.test.ts b/packages/core/src/__tests__/a.test.ts",
  "--- a/packages/core/src/__tests__/a.test.ts",
  "+++ b/packages/core/src/__tests__/a.test.ts",
  "@@ -1 +1 @@",
  "+t",
  "diff --git a/packages/core/src/old.ts b/packages/core/src/old.ts",
  "deleted file mode 100644",
  "--- a/packages/core/src/old.ts",
  "+++ /dev/null",
  "@@ -1,3 +0,0 @@",
  "-a",
].join("\n");

describe("changedLines", () => {
  it("keeps the added and changed lines of each file, as ranges in the new file", () => {
    const ranges = changedLines(DIFF);
    expect([...ranges.keys()]).toEqual(["packages/core/src/a.ts", "packages/core/src/__tests__/a.test.ts"]);
    // +3,2 is lines 3 to 4; +11,0 only deletes; +18 is one line.
    expect(ranges.get("packages/core/src/a.ts")).toEqual([[3, 4], [18, 18]]);
    expect(ranges.get("packages/core/src/__tests__/a.test.ts")).toEqual([[1, 1]]);
  });

  it("reads counts of several digits, and no hunk in a line of content", () => {
    const diff = [
      "+++ b/packages/core/src/b/x.ts",
      "@@ -10,12 +11,10 @@",
      "+@@ -1 +900 @@ is text the change adds, not a hunk",
    ].join("\n");
    expect([...changedLines(diff)]).toEqual([["packages/core/src/b/x.ts", [[11, 20]]]]);
  });

  it("returns nothing for an empty diff", () => {
    expect(changedLines("").size).toBe(0);
  });
});

describe("productionChanges", () => {
  it("keeps the changed ranges of production files only", () => {
    const changes = productionChanges(changedLines(DIFF), CONFIG.mutation.production);
    expect([...changes]).toEqual([["packages/core/src/a.ts", [[3, 4], [18, 18]]]]);
  });

  it("reads production from the configuration: sources of a package, not tests, declarations or scripts", () => {
    const production = new RegExp(CONFIG.mutation.production);
    expect(production.test("packages/orchestration/src/handlers/x.ts")).toBe(true);
    expect(production.test("packages/orchestration/src/__tests__/x.test.ts")).toBe(false);
    expect(production.test("packages/orchestration/src/handlers/__tests__/x.ts")).toBe(false);
    expect(production.test("packages/core/src/x.d.ts")).toBe(false);
    expect(production.test("packages/mcp-server/dist/x.js")).toBe(false);
    // The gate's decisions are mutated; its process shell is tested as a process.
    expect(production.test("scripts/gate/gate-lib.mjs")).toBe(true);
    expect(production.test("scripts/gate/gate.mjs")).toBe(false);
    expect(production.test("scripts/gate/gate.test.mjs")).toBe(false);
  });
});

describe("judgeMutants", () => {
  const mutant = (startLine, endLine, status, mutatorName = "M") => ({
    location: { start: { line: startLine, column: 1 }, end: { line: endLine, column: 2 } },
    status,
    mutatorName,
    replacement: "r",
  });
  const changes = new Map([["packages/core/src/a.ts", [[10, 12]]]]);
  const report = (mutants) => ({
    files: { "packages/core/src/a.ts": { mutants }, "packages/core/src/other.ts": { mutants: [mutant(10, 10, "Survived")] } },
  });

  it("fails on a survivor, an uncovered and an unfinished mutant of a changed line", () => {
    const { judged, undetected } = judgeMutants(
      report([mutant(10, 10, "Survived", "A"), mutant(12, 12, "NoCoverage", "B"), mutant(11, 11, "Pending", "C"), mutant(11, 11, "Killed")]),
      changes,
    );
    expect(judged).toBe(4);
    expect(undetected).toEqual([
      { file: "packages/core/src/a.ts", line: 10, mutator: "A", status: "Survived", replacement: "r" },
      { file: "packages/core/src/a.ts", line: 12, mutator: "B", status: "NoCoverage", replacement: "r" },
      { file: "packages/core/src/a.ts", line: 11, mutator: "C", status: "Pending", replacement: "r" },
    ]);
  });

  it("judges an expression written on several lines when one of its lines changed", () => {
    // Starts above the range, or ends below it: both overlap lines 10 to 12.
    expect(judgeMutants(report([mutant(8, 10, "Survived"), mutant(12, 15, "Survived")]), changes).undetected).toHaveLength(2);
  });

  it("judges a mutant that touches one of several changed ranges", () => {
    const two = new Map([["packages/core/src/a.ts", [[1, 2], [10, 12]]]]);
    expect(judgeMutants(report([mutant(11, 11, "Survived")]), two).judged).toBe(1);
  });

  it("reports a mutant that has no replacement text", () => {
    const bare = { location: { start: { line: 10, column: 1 }, end: { line: 10, column: 2 } }, status: "Survived", mutatorName: "M" };
    expect(judgeMutants(report([bare]), changes).undetected[0].replacement).toBe("");
  });

  it("leaves out the mutants of unchanged lines and of unchanged files", () => {
    expect(judgeMutants(report([mutant(9, 9, "Survived"), mutant(13, 20, "Survived")]), changes)).toEqual({ judged: 0, undetected: [] });
  });

  it("passes killed, timed-out and marked-equivalent mutants", () => {
    const { judged, undetected } = judgeMutants(report([mutant(10, 10, "Killed"), mutant(10, 10, "Timeout"), mutant(11, 11, "Ignored")]), changes);
    expect(judged).toBe(3);
    expect(undetected).toEqual([]);
  });
});

describe("isDelivery", () => {
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

  it("recognises a push and the creation of a pull request", () => {
    for (const command of ["git push", "git push -u origin fix/x", "git -C /repo push", "cd x && git push", "gh pr create --fill"]) {
      expect(isDelivery(bash(command), CONFIG.delivers), command).toBe(true);
    }
    expect(isDelivery({ tool_name: "mcp__github__create_pull_request", tool_input: {} }, CONFIG.delivers)).toBe(true);
  });

  it("lets every other call through", () => {
    for (const command of ["git status", "git commit -m 'push the button'", "git stash push -m x", "gh pr view 3", "pnpm test"]) {
      expect(isDelivery(bash(command), CONFIG.delivers), command).toBe(false);
    }
    expect(isDelivery({ tool_name: "Read", tool_input: { file_path: "git push" } }, CONFIG.delivers)).toBe(false);
    expect(isDelivery({ tool_name: "Bash", tool_input: {} }, CONFIG.delivers)).toBe(false);
    expect(isDelivery({ tool_name: "Bash" }, CONFIG.delivers)).toBe(false);
    expect(isDelivery({ tool_name: "Bash", tool_input: { command: ["git push"] } }, CONFIG.delivers)).toBe(false);
    expect(isDelivery(undefined, CONFIG.delivers)).toBe(false);
  });
});

describe("resolveProfile", () => {
  const profile = {
    description: "${ignored} is prose",
    srt: {
      network: { allowedDomains: [], allowLocalBinding: true },
      filesystem: { denyRead: ["${home}/.ssh"], allowWrite: ["${worktree}", "${tmp}"], denyWrite: ["${worktree}/.claude"] },
    },
    env: { pass: ["PATH", "LANG"], set: { HOME: "${tmp}/home", CI: "1" } },
  };
  const vars = { home: "/h", worktree: "/w", tmp: "/t" };

  it("fills every variable of the sandbox settings, at any depth, and keeps the other values", () => {
    expect(resolveProfile(profile, vars, {}).srt).toEqual({
      network: { allowedDomains: [], allowLocalBinding: true },
      filesystem: { denyRead: ["/h/.ssh"], allowWrite: ["/w", "/t"], denyWrite: ["/w/.claude"] },
    });
  });

  it("gives the operation the passed variables the host defines, then the set ones, and nothing else", () => {
    const host = { PATH: "/bin", SECRET_TOKEN: "s", HOME: "/real", CI: "0" };
    // Strict: a passed variable the host does not define (LANG) is absent, not undefined.
    expect(resolveProfile(profile, vars, host).env).toStrictEqual({ PATH: "/bin", HOME: "/t/home", CI: "1" });
  });

  it("refuses a variable it has no value for, and one it would inherit from Object", () => {
    const withUnknown = { ...profile, srt: { filesystem: { denyRead: ["${nowhere}/x"] } } };
    expect(() => resolveProfile(withUnknown, vars, {})).toThrow("profile variable ${nowhere} is not defined");
    const inherited = { ...profile, srt: { filesystem: { denyRead: ["${toString}/x"] } } };
    expect(() => resolveProfile(inherited, vars, {})).toThrow("${toString}");
  });

  it("keeps a null value as it is", () => {
    expect(resolveProfile({ ...profile, srt: { proxy: null } }, vars, {}).srt).toEqual({ proxy: null });
  });

  it("fills a variable used twice in one path", () => {
    const twice = { ...profile, srt: { p: "${tmp}:${tmp}" } };
    expect(resolveProfile(twice, vars, {}).srt).toEqual({ p: "/t:/t" });
  });
});

describe("the profiles of the gate", () => {
  const read = (name) => JSON.parse(readFileSync(join(HERE, "profiles", `${name}.json`), "utf8"));
  const used = [...new Set([...CONFIG.checks.map((c) => c.profile), CONFIG.mutation.profile])];

  it("exist for every operation, resolve with the variables the gate gives, and reach nothing outside the machine", () => {
    expect(used.sort()).toEqual(["loopback", "offline"]);
    for (const name of used) {
      const { srt, env } = resolveProfile(read(name), { home: "/h", worktree: "/w", tmp: "/t" }, { PATH: "/bin" });
      expect(srt.network.allowedDomains, name).toEqual([]);
      expect(srt.filesystem.allowWrite, name).toEqual(["/w", "/t"]);
      expect(env.HOME, name).toBe("/t/home");
    }
  });

  it("let no operation write the settings, the gate, its configuration or the git directory, nor read credentials", () => {
    for (const name of used) {
      const { filesystem } = read(name).srt;
      for (const path of ["${worktree}/.claude", "${worktree}/.git", "${worktree}/delivery-gate.json", "${worktree}/stryker.config.json", "${worktree}/scripts/gate"]) {
        expect(filesystem.denyWrite, `${name} ${path}`).toContain(path);
      }
      for (const path of ["${home}/.ssh", "${home}/.aws", "${home}/.config/gh", "${home}/.npmrc", "${home}/.claude"]) {
        expect(filesystem.denyRead, `${name} ${path}`).toContain(path);
      }
      expect(filesystem.allowRead, name).toEqual([]);
    }
  });

  it("grant the loopback to the operations that run the test suite only", () => {
    expect(read("offline").srt.network.allowLocalBinding).toBeUndefined();
    expect(read("loopback").srt.network.allowLocalBinding).toBe(true);
    expect(CONFIG.checks.filter((c) => c.profile === "loopback").map((c) => c.name)).toEqual(["unit"]);
  });
});

describe("the canary, run as a process", () => {
  const canary = (...args) => spawnSync(process.execPath, [join(HERE, "canary.mjs"), ...args], { encoding: "utf8" });

  it("reports what it could do when nothing stops it, and exits 1: a sandbox that does not hold is seen", () => {
    const dir = mkdtempSync(join(tmpdir(), "canary-"));
    const readable = join(dir, "secret");
    writeFileSync(readable, "s");
    const out = canary("--write", join(dir, "w"), "--read", readable);
    expect(out.status).toBe(1);
    expect(out.stdout.trim().split("\n")).toEqual([`wrote ${join(dir, "w")}`, `read ${readable}`]);
  });

  it("exits 0 when every attempt is refused", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "canary-")), "no-such-dir", "x");
    // Port 1 of the loopback has no listener: the connection is refused.
    const out = canary("--write", missing, "--read", missing, "--connect", "1");
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("");
  });

  it("fails on an argument it does not know, instead of proving nothing", () => {
    expect(canary("--wirte", "/x").status).toBe(1);
  });
});

describe("the hook, in a real repository", () => {
  let repo;
  const git = (...args) => {
    const out = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (out.status !== 0) throw new Error(out.stderr);
    return out.stdout.trim();
  };
  const hook = (call) =>
    spawnSync(process.execPath, [join(repo, "scripts/gate/gate.mjs"), "hook"], {
      cwd: repo,
      input: JSON.stringify({ cwd: repo, ...call }),
      encoding: "utf8",
    });
  const push = { tool_name: "Bash", tool_input: { command: "git push" } };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "gate-"));
    mkdirSync(join(repo, "scripts/gate"), { recursive: true });
    cpSync(join(HERE, "gate.mjs"), join(repo, "scripts/gate/gate.mjs"));
    cpSync(join(HERE, "gate-lib.mjs"), join(repo, "scripts/gate/gate-lib.mjs"));
    cpSync(join(ROOT, "delivery-gate.json"), join(repo, "delivery-gate.json"));
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  });

  it("refuses a delivery of a tree that has no verdict, with exit code 2 and the way out", () => {
    const out = hook(push);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain(git("rev-parse", "HEAD^{tree}"));
    expect(out.stderr).toContain("pnpm gate");
  });

  it("lets a call that delivers nothing through, verdict or not", () => {
    expect(hook({ tool_name: "Bash", tool_input: { command: "git status" } }).status).toBe(0);
  });

  it("lets the delivery through once the tree has a passed verdict, and refuses a failed one", () => {
    const tree = git("rev-parse", "HEAD^{tree}");
    const dir = join(git("rev-parse", "--path-format=absolute", "--git-common-dir"), "delivery-gate");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${tree}.json`), JSON.stringify({ tree, passed: false }));
    expect(hook(push).status).toBe(2);
    writeFileSync(join(dir, `${tree}.json`), JSON.stringify({ tree, passed: true }));
    expect(hook(push).status).toBe(0);
  });

  it("refuses again after a new commit: the verdict was for the other tree", () => {
    writeFileSync(join(repo, "new.txt"), "x");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "next");
    expect(hook(push).status).toBe(2);
  });

  it("stays out of the way where no gate is configured", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "nogate-"));
    const out = spawnSync(process.execPath, [join(HERE, "gate.mjs"), "hook"], {
      input: JSON.stringify({ cwd: elsewhere, ...push }),
      encoding: "utf8",
    });
    expect(out.status).toBe(0);
  });
});

// Stryker tests a copy of the project that does not carry `.claude`: the
// sandbox runtime lets no operation write that directory, the copy included
// (stryker.config.json, ignorePatterns). These tests read a file and mutate
// nothing, so they run in the unit check and not in a mutation run.
describe.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)(".claude/settings.json, the one permission file of the repository", () => {
  let settings;
  beforeAll(() => {
    settings = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8"));
  });

  it("denies what the CI contract forbids without condition, and the reading of secrets", () => {
    for (const rule of [
      "Bash(git merge-base *)",
      // In two parts: scripts/tests/test_no_main_comparison.py forbids the word in scripts/.
      "Bash(gh pr update" + "-branch *)",
      "Bash(git push --force*)",
      "Bash(git push * --force*)",
      "Bash(git push -f*)",
      "Bash(git push * -f*)",
      "Read(./.env)",
      "Read(**/*.key)",
    ]) {
      expect(settings.permissions.deny, rule).toContain(rule);
    }
  });

  it("allows nothing that delivers, and nothing that names a path of one machine", () => {
    for (const rule of settings.permissions.allow) {
      const command = /^Bash\((.*)\)$/.exec(rule)?.[1];
      if (command !== undefined) {
        // `*` in a rule stands for any text: the rule is tried as written and with a word in its place.
        for (const text of [command, command.replaceAll("*", "x")]) {
          expect(isDelivery({ tool_name: "Bash", tool_input: { command: text } }, CONFIG.delivers), rule).toBe(false);
        }
      }
      expect(CONFIG.delivers.tools, rule).not.toContain(rule);
      expect(rule, rule).not.toMatch(/~|\/Users\/|\/home\//);
    }
  });

  it("runs the gate's hook before every tool that can deliver", () => {
    const [entry] = settings.hooks.PreToolUse;
    expect(entry.matcher.split("|").sort()).toEqual(["Bash", ...CONFIG.delivers.tools].sort());
    expect(entry.hooks).toEqual([{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/scripts/gate/gate.mjs" hook' }]);
  });
});
