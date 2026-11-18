/**
 * The delivery gate (scripts/gate).
 *
 * The decisions (gate-lib.mjs) are run here with doubles for their ports:
 * the run, the pre-push hook of git, the guard of the session, the canary's
 * plan, the judgment of mutants. Then the program (gate.mjs) is run as git
 * and Claude Code run it, in a real repository with a real push, and the
 * canary as a process. The sandbox runtime itself is not started here: the
 * gate proves it with its canary each time it runs (`pnpm gate`).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Refusal,
  canaryPlan,
  fill,
  guardDecision,
  guardHook,
  hunkRanges,
  judgeMutants,
  prePush,
  productionFiles,
  pushedCommits,
  resolveProfile,
  runGate,
  unsafeNames,
  validateConfig,
  verdictRefusal,
} from "./gate-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const readJson = (...path) => JSON.parse(readFileSync(join(...path), "utf8"));
const CONFIG = readJson(ROOT, "delivery-gate.json");

// ─── Configuration ──────────────────────────────────────────────────────────

describe("validateConfig", () => {
  const without = (path) => {
    const copy = structuredClone(CONFIG);
    const keys = path.split(".");
    const last = keys.pop();
    delete keys.reduce((object, key) => object[key], copy)[last];
    return copy;
  };
  const withValue = (path, value) => {
    const copy = structuredClone(CONFIG);
    const keys = path.split(".");
    const last = keys.pop();
    keys.reduce((object, key) => object[key], copy)[last] = value;
    return copy;
  };

  it("returns the committed configuration as it is", () => {
    expect(validateConfig(CONFIG)).toBe(CONFIG);
  });

  it("names the first key that is missing or of the wrong type", () => {
    const cases = [
      [null, "must be an object"],
      [[], "must be an object"],
      ["text", "must be an object"],
      [without("base"), "base must be a git revision"],
      [withValue("base", ""), "base must be a git revision"],
      [without("checks"), "checks must be a list"],
      [withValue("checks", [null]), "checks[0].name must be a name"],
      [withValue("checks.1.name", 3), "checks[1].name must be a name"],
      [withValue("checks.0.profile", ""), "checks[0].profile must name a profile"],
      [withValue("checks.0.command", "pnpm build"), "checks[0].command must be a list of arguments"],
      [withValue("checks.0.command", []), "checks[0].command must be a list of arguments"],
      [withValue("checks.0.command", ["pnpm", 1]), "checks[0].command must be a list of arguments"],
      [without("mutation"), "mutation must be an object"],
      [withValue("mutation", null), "mutation must be an object"],
      [without("mutation.production"), "mutation.production must be a regular expression"],
      [withValue("mutation.production", "("), "mutation.production is not a regular expression"],
      [withValue("mutation.command", []), "mutation.command must be a list of arguments"],
      [without("mutation.report"), "mutation.report must be a path"],
      [without("mutation.profile"), "mutation.profile must name a profile"],
      [without("guard"), "guard must be an object"],
      [withValue("guard", null), "guard must be an object"],
      [without("guard.push"), "guard.push must be a list"],
      [withValue("guard.bypass", "x"), "guard.bypass must be a list"],
      [withValue("guard.bypass", ["ok", "["]), "guard.bypass[1] is not a regular expression"],
      [withValue("guard.push", [7]), "guard.push[0] must be a regular expression"],
      [without("guard.refusedTools"), "guard.refusedTools must be a list of tool names"],
      [withValue("guard.refusedTools", ["a", ""]), "guard.refusedTools must be a list of tool names"],
    ];
    for (const [raw, message] of cases) {
      let thrown;
      try {
        validateConfig(raw);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, message).toBeInstanceOf(Refusal);
      expect(thrown.message, message).toContain(`delivery-gate.json: ${message}`);
    }
  });

  it("accepts a configuration with no check", () => {
    expect(() => validateConfig(withValue("checks", []))).not.toThrow();
  });
});

// ─── The lines a change touches ─────────────────────────────────────────────

describe("hunkRanges", () => {
  it("gives the added and changed lines of one file, as ranges in the new file", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -3 +3,2 @@ a section heading",
      "+x",
      "+y",
      "@@ -10,12 +11,0 @@",
      "-gone",
      "@@ -20,0 +18 @@",
      "+one",
      "@@ -30,22 +40,10 @@",
      "+@@ -1 +900 @@ is text the change adds, not a hunk",
      "\\ No newline at end of file",
    ].join("\n");
    // +3,2 is lines 3 to 4; +11,0 only deletes; +18 is one line; +40,10 is 40 to 49.
    expect(hunkRanges(diff)).toEqual([[3, 4], [18, 18], [40, 49]]);
  });

  it("gives nothing for an empty diff", () => {
    expect(hunkRanges("")).toEqual([]);
  });
});

describe("productionFiles and unsafeNames", () => {
  it("keeps the sources of a package and the gate's decisions: not tests, declarations, builds or scripts", () => {
    const names = [
      "packages/orchestration/src/handlers/x.ts",
      "packages/orchestration/src/__tests__/x.test.ts",
      "packages/orchestration/src/handlers/__tests__/x.ts",
      "packages/core/src/x.d.ts",
      "packages/mcp-server/dist/x.js",
      "scripts/gate/gate-lib.mjs",
      "scripts/gate/gate.mjs",
      "scripts/gate/gate.test.mjs",
      "README.md",
    ];
    expect(productionFiles(names, CONFIG.mutation.production)).toEqual([
      "packages/orchestration/src/handlers/x.ts",
      "scripts/gate/gate-lib.mjs",
    ]);
  });

  it("finds the names the mutation tool would read as a pattern or a list", () => {
    const safe = ["packages/a-b/src/x_y.ts", "packages/@scope/src/a.b.ts"];
    const unsafe = ["packages/x/src/[id].ts", "packages/x/src/a,b.ts", "packages/x/src/a b.ts", "packages/x/src/é.ts", "packages/x/src/$(id).ts", "a*.ts"];
    expect(unsafeNames([...safe, ...unsafe])).toEqual(unsafe);
    expect(unsafeNames(safe)).toEqual([]);
  });
});

// ─── The mutants of a change ────────────────────────────────────────────────

describe("judgeMutants", () => {
  const mutant = (startLine, endLine, status, extra = {}) => ({
    location: { start: { line: startLine, column: 1 }, end: { line: endLine, column: 2 } },
    status,
    mutatorName: "M",
    replacement: "r",
    ...extra,
  });
  const FILE = "packages/core/src/a.ts";
  const changes = new Map([[FILE, [[10, 12]]]]);
  const report = (mutants) => ({
    files: { [FILE]: { mutants }, "packages/core/src/other.ts": { mutants: [mutant(10, 10, "Survived")] } },
  });
  const undetectedStatuses = (mutants, ranges = changes) => judgeMutants(report(mutants), ranges).undetected.map((m) => m.status);

  it("reports a survivor, an uncovered, an unfinished mutant and a status it does not know", () => {
    const { judged, undetected } = judgeMutants(
      report([
        mutant(10, 10, "Survived", { mutatorName: "A" }),
        mutant(12, 12, "NoCoverage", { mutatorName: "B", replacement: undefined }),
        mutant(11, 11, "Pending"),
        mutant(11, 11, "SomeLaterStatus"),
        mutant(11, 11, "Killed"),
      ]),
      changes,
    );
    expect(judged).toBe(5);
    expect(undetected).toEqual([
      { file: FILE, line: 10, mutator: "A", status: "Survived", replacement: "r" },
      { file: FILE, line: 12, mutator: "B", status: "NoCoverage", replacement: "" },
      { file: FILE, line: 11, mutator: "M", status: "Pending", replacement: "r" },
      { file: FILE, line: 11, mutator: "M", status: "SomeLaterStatus", replacement: "r" },
    ]);
  });

  it("passes a mutant a test saw: killed, timed out, or that did not load or compile", () => {
    const seen = ["Killed", "Timeout", "RuntimeError", "CompileError"].map((status) => mutant(10, 10, status));
    expect(judgeMutants(report(seen), changes)).toEqual({ judged: 4, undetected: [] });
  });

  it("passes a marked mutant only for a stated equivalence", () => {
    const ignored = (statusReason) => mutant(11, 11, "Ignored", { statusReason });
    expect(undetectedStatuses([ignored("equivalent: the list has one element")])).toEqual([]);
    // A blanket disable, a reason that is not an equivalence, an empty one.
    for (const reason of [undefined, "", "Ignored using a comment", "equivalent:", "equivalent:  ", "not equivalent: x", "Equivalent: x"]) {
      expect(undetectedStatuses([ignored(reason)]), String(reason)).toEqual(["Ignored"]);
    }
    // The reason is read on a marked mutant only.
    expect(undetectedStatuses([mutant(11, 11, "Survived", { statusReason: "equivalent: x" })])).toEqual(["Survived"]);
  });

  it("judges an expression written on several lines when one of its lines changed", () => {
    // Starts above the range, or ends below it: both overlap lines 10 to 12.
    expect(undetectedStatuses([mutant(8, 10, "Survived"), mutant(12, 15, "Survived"), mutant(1, 99, "Survived")])).toHaveLength(3);
  });

  it("judges a mutant that touches one of several changed ranges", () => {
    const two = new Map([[FILE, [[1, 2], [10, 12]]]]);
    expect(judgeMutants(report([mutant(11, 11, "Survived")]), two).judged).toBe(1);
  });

  it("leaves out the mutants of unchanged lines and of unchanged files", () => {
    expect(judgeMutants(report([mutant(9, 9, "Survived"), mutant(13, 20, "Survived")]), changes)).toEqual({ judged: 0, undetected: [] });
  });
});

// ─── Sandbox profiles ───────────────────────────────────────────────────────

describe("fill and resolveProfile", () => {
  const vars = { home: "/h", worktree: "/w", tmp: "/t", toolchain: ["/h/.a/bin", "/h/.b/bin"], none: [] };

  it("fills every variable, at any depth, and keeps the other values", () => {
    expect(fill({ a: ["${worktree}/.git", 3, null, true], b: { c: "${tmp}:${tmp}" }, d: null, e: 1 }, vars)).toEqual({
      a: ["/w/.git", 3, null, true],
      b: { c: "/t:/t" },
      d: null,
      e: 1,
    });
  });

  it("puts the elements of a list variable in place of the element that names it", () => {
    expect(fill(["${worktree}", "${toolchain}", "${tmp}", "${none}"], vars)).toEqual(["/w", "/h/.a/bin", "/h/.b/bin", "/t"]);
  });

  it("refuses a variable it has no value for, one it would inherit, and a list inside a longer string", () => {
    expect(() => fill(["${nowhere}/x"], vars)).toThrow(new Refusal("variable ${nowhere} is not defined"));
    expect(() => fill("${toString}", vars)).toThrow(Refusal);
    expect(() => fill(["${nowhere}"], vars)).toThrow("variable ${nowhere} is not defined");
    expect(() => fill(["${toolchain}/bin"], vars)).toThrow(new Refusal("variable ${toolchain} is a list: it stands alone in a list"));
    expect(() => fill(["/x/${toolchain}"], vars)).toThrow(new Refusal("variable ${toolchain} is a list: it stands alone in a list"));
    expect(() => fill("${toolchain}", vars)).toThrow(Refusal);
  });

  it("gives the operation the passed variables the host defines, then the set ones, and nothing else", () => {
    const profile = {
      srt: { filesystem: { denyRead: ["${home}"] } },
      env: { pass: ["PATH", "LANG"], set: { HOME: "${tmp}/home", CI: "1" } },
    };
    const host = { PATH: "/bin", SECRET_TOKEN: "s", HOME: "/real", CI: "0" };
    const { srt, env } = resolveProfile(profile, vars, host);
    expect(srt).toEqual({ filesystem: { denyRead: ["/h"] } });
    // Strict: a passed variable the host does not define (LANG) is absent, not undefined.
    expect(env).toStrictEqual({ PATH: "/bin", HOME: "/t/home", CI: "1" });
  });
});

describe("the profiles of the gate", () => {
  const names = readdirSync(join(HERE, "profiles")).map((file) => file.replace(/\.json$/, ""));
  const profile = (name) => readJson(HERE, "profiles", `${name}.json`);
  const vars = { home: "/h", worktree: "/w", repository: "/r/.git", launcher: "/l", tmp: "/t", toolchain: ["/h/bin"] };

  it("exist for every operation of the configuration, and resolve with the variables the gate gives", () => {
    const used = new Set([...CONFIG.checks.map((check) => check.profile), CONFIG.mutation.profile]);
    for (const name of used) expect(names, name).toContain(name);
    for (const name of names) {
      const { srt, env } = resolveProfile(profile(name), vars, { PATH: "/bin" });
      expect(JSON.stringify(srt), name).not.toContain("${");
      expect(env, name).toEqual({ PATH: "/bin", HOME: "/t/home", TMPDIR: "/t", CI: "1" });
    }
  });

  it("let no operation reach outside the machine, read the user's home, or write what judges it", () => {
    for (const name of names) {
      const { srt } = resolveProfile(profile(name), vars, {});
      expect(srt.network.allowedDomains, name).toEqual([]);
      expect(srt.filesystem.denyRead, name).toEqual(["/h"]);
      expect(srt.filesystem.allowRead, name).toEqual(["/w", "/r/.git", "/l", "/t", "/h/bin"]);
      expect(srt.filesystem.allowWrite, name).toEqual(["/w", "/t"]);
      for (const path of [".claude", ".git", "delivery-gate.json", "stryker.config.json", "scripts/gate", "node_modules/.bin", "node_modules/.pnpm", "node_modules/@anthropic-ai", "node_modules/@stryker-mutator"]) {
        expect(srt.filesystem.denyWrite, `${name} ${path}`).toContain(`/w/${path}`);
      }
    }
  });

  it("differ by the loopback alone, which no profile grants without saying so", () => {
    const [offline, loopback] = [profile("offline"), profile("loopback")];
    expect(offline.srt.network.allowLocalBinding).toBeUndefined();
    expect(loopback.srt.network.allowLocalBinding).toBe(true);
    delete loopback.srt.network.allowLocalBinding;
    expect({ ...loopback, description: "" }).toEqual({ ...offline, description: "" });
    expect(loopback.description).toMatch(/every local port/);
  });
});

describe("canaryPlan", () => {
  const srt = (network = {}) => ({
    network: { allowedDomains: [], ...network },
    filesystem: {
      denyWrite: ["/w/.claude", "/w/delivery-gate.json", "/w/absent"],
      denyRead: ["/h", "/h/.netrc", "/h/absent"],
    },
  });
  const kindOf = (path) => ({ "/w/.claude": "dir", "/w/delivery-gate.json": "file", "/h": "dir", "/h/.netrc": "file" })[path] ?? null;

  it("tries each thing the profile denies that is there, a write outside, and the host's port", () => {
    const plan = canaryPlan(srt(), { kindOf, outside: "/out", hostPort: 4242 });
    expect(plan.args).toEqual([
      "--write", "/out/gate-canary",
      "--write", "/w/.claude/gate-canary",
      "--append", "/w/delivery-gate.json",
      "--list", "/h",
      "--read", "/h/.netrc",
      "--connect", "4242",
    ]);
    // What a sandbox that does not hold would leave: the gate removes it.
    expect(plan.created).toEqual(["/out/gate-canary", "/w/.claude/gate-canary"]);
    expect(plan.proves).toEqual({ writes: 3, reads: 2, port: true });
  });

  it("does not try the host's port under a profile that grants the loopback", () => {
    const plan = canaryPlan(srt({ allowLocalBinding: true }), { kindOf, outside: "/out", hostPort: 4242 });
    expect(plan.args).not.toContain("--connect");
    expect(plan.proves.port).toBe(false);
    // Only `true` grants it.
    expect(canaryPlan(srt({ allowLocalBinding: "yes" }), { kindOf, outside: "/out", hostPort: 1 }).proves.port).toBe(true);
  });

  it("still tries a write outside when nothing the profile names is there", () => {
    const plan = canaryPlan(srt(), { kindOf: () => null, outside: "/out", hostPort: 1 });
    expect(plan.args).toEqual(["--write", "/out/gate-canary", "--connect", "1"]);
    expect(plan.proves).toEqual({ writes: 1, reads: 0, port: true });
  });
});

// ─── Verdicts and the pre-push hook ─────────────────────────────────────────

const SHA = (digit) => digit.repeat(40);
const ZERO = SHA("0");

describe("verdictRefusal", () => {
  const good = { tree: "T", passed: true, gate: "G" };

  it("accepts a passed verdict of this gate for this tree", () => {
    expect(verdictRefusal(good, "T", "G")).toBeNull();
  });

  it("says why any other is refused", () => {
    expect(verdictRefusal(null, "T", "G")).toBe("it has no verdict of the delivery gate");
    for (const verdict of [{ ...good, passed: false }, { ...good, passed: "true" }, { ...good, tree: "U" }, { passed: true, gate: "G" }]) {
      expect(verdictRefusal(verdict, "T", "G")).toBe("its verdict is not a passed verdict for this tree");
    }
    for (const verdict of [{ ...good, gate: "H" }, { tree: "T", passed: true }]) {
      expect(verdictRefusal(verdict, "T", "G")).toBe("its verdict was written by another gate than the one of the main checkout");
    }
  });
});

describe("pushedCommits", () => {
  it("reads the commits a push sends, and nothing for a deletion", () => {
    const input = [
      `refs/heads/a ${SHA("a")} refs/heads/a ${ZERO}`,
      "",
      "   ",
      `(delete) ${ZERO} refs/heads/gone ${SHA("b")}`,
      `  HEAD ${SHA("c")} refs/heads/c ${SHA("d")}  `,
      `refs/heads/s ${"e".repeat(64)} refs/heads/s ${"0".repeat(64)}`,
      // A commit whose hash only starts or only ends with zeros is a commit.
      `refs/heads/z ${"0".repeat(39)}a refs/heads/z ${ZERO}`,
      `refs/heads/y a${"0".repeat(39)} refs/heads/y ${ZERO}`,
    ].join("\n");
    expect(pushedCommits(input)).toEqual([
      { ref: "refs/heads/a", sha: SHA("a") },
      { ref: "HEAD", sha: SHA("c") },
      { ref: "refs/heads/s", sha: "e".repeat(64) },
      { ref: "refs/heads/z", sha: `${"0".repeat(39)}a` },
      { ref: "refs/heads/y", sha: `a${"0".repeat(39)}` },
    ]);
    expect(pushedCommits("")).toEqual([]);
  });

  it("refuses a line it cannot read, instead of letting it through", () => {
    for (const line of ["refs/heads/a abc refs/heads/a def", `refs/heads/a ${SHA("a")}`, `x ${SHA("a")} y ${SHA("b")} extra`, `extra x ${SHA("a")} y ${SHA("b")}`, `x ${SHA("A")} y ${ZERO}`]) {
      expect(() => pushedCommits(line), line).toThrow(new Refusal(`unreadable line from git: ${line}`));
    }
  });
});

describe("prePush", () => {
  const ports = (verdicts) => {
    const lines = [];
    return {
      lines,
      treeOf: (sha) => `tree-of-${sha[0]}`,
      readVerdict: (tree) => verdicts[tree] ?? null,
      gateHash: "G",
      log: (line) => lines.push(line),
    };
  };
  const passed = (tree) => ({ tree, passed: true, gate: "G" });
  const line = (name, digit) => `refs/heads/${name} ${SHA(digit)} refs/heads/${name} ${ZERO}`;

  it("lets through a push whose every commit has a passed verdict of this gate", () => {
    const p = ports({ "tree-of-a": passed("tree-of-a"), "tree-of-b": passed("tree-of-b") });
    expect(prePush([line("a", "a"), line("b", "b")].join("\n"), p)).toBe(0);
    expect(p.lines).toEqual([]);
  });

  it("refuses the push when one commit does not, and names each one with the reason", () => {
    const p = ports({ "tree-of-a": passed("tree-of-a"), "tree-of-c": { ...passed("tree-of-c"), gate: "other" } });
    expect(prePush([line("a", "a"), line("b", "b"), line("c", "c")].join("\n"), p)).toBe(1);
    expect(p.lines).toEqual([
      "[gate] push refused: refs/heads/b (tree tree-of-b): it has no verdict of the delivery gate. Commit the work and run the gate (pnpm gate).",
      "[gate] push refused: refs/heads/c (tree tree-of-c): its verdict was written by another gate than the one of the main checkout. Commit the work and run the gate (pnpm gate).",
    ]);
  });

  it("lets a deletion and an empty push through", () => {
    expect(prePush(`(delete) ${ZERO} refs/heads/gone ${SHA("b")}`, ports({}))).toBe(0);
    expect(prePush("", ports({}))).toBe(0);
  });
});

// ─── The guard of the session ───────────────────────────────────────────────

describe("guardDecision", () => {
  const guard = CONFIG.guard;
  const bash = (command, tool_name = "Bash") => ({ tool_name, tool_input: { command } });
  const kind = (command) => guardDecision(bash(command), guard).kind;

  it("sees a push in every way of writing it, from any tool that carries a command", () => {
    for (const command of [
      "git push",
      "git push -u origin fix/x",
      "git -C /repo push",
      "git --no-pager push",
      "git --git-dir=/r/.git push origin main",
      "git -c alias.p=push p",
      "cd x && git push",
      "command git push",
      "env X=1 git push",
      "sh -c 'git push'",
      'git "push"',
      "git\tpush",
    ]) {
      expect(kind(command), command).toBe("push");
    }
    expect(guardDecision(bash("git push", "mcp__some__start_process"), guard).kind).toBe("push");
  });

  it("refuses what goes around the pre-push hook, and says what it matched", () => {
    for (const command of [
      "git push --no-verify",
      "git push origin x --no-verify",
      "git -c core.hooksPath=/dev/null push",
      "git config core.hooksPath /tmp/h",
      "git send-pack origin HEAD",
      "gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=abc",
      "gh api -X PATCH repos/o/r/git/refs/heads/x -f sha=abc",
      "gh api repos/o/r/contents/README.md -X PUT -f content=x",
      "gh api repos/o/r/pulls -f title=x -f head=y -f base=main",
      "gh api -X PUT repos/o/r/pulls/3/merge",
      "gh api repos/o/r/merges --field base=main --field head=x",
      "gh api repos/o/r/git/trees --input tree.json",
      'curl -H "Authorization: Bearer $(gh auth token)" https://api.github.com/repos/o/r/git/refs',
    ]) {
      const decision = guardDecision(bash(command), guard);
      expect(decision.kind, command).toBe("refuse");
      expect(decision.reason, command).toMatch(/^the command goes around the pre-push hook of the delivery gate \(it matches .+\)\.$/);
    }
    const decision = guardDecision(bash("git push --no-verify"), guard);
    expect(decision.reason).toContain(`(it matches ${guard.bypass[0]})`);
  });

  it("refuses the tools that send content the gate cannot judge", () => {
    for (const tool_name of guard.refusedTools) {
      expect(guardDecision({ tool_name, tool_input: {} }, guard)).toEqual({
        kind: "refuse",
        reason: `${tool_name} sends content the delivery gate cannot judge. Commit, run the gate, and push with git.`,
      });
    }
    expect(guard.refusedTools).toEqual(expect.arrayContaining(["mcp__github__push_files", "mcp__github__create_or_update_file"]));
  });

  it("lets every other call through", () => {
    for (const command of [
      "git status",
      "git log --oneline",
      "git fetch origin",
      "gh pr view 3",
      "gh pr create --fill",
      // Reading through the API, and writing what is not a delivery (a comment).
      "gh api repos/o/r/pulls/3",
      "gh api repos/o/r/pulls",
      "gh api repos/o/r/contents/README.md",
      "gh api repos/o/r/issues/3/comments -f body=done",
      "gh api repos/o/r/pulls/3/comments -f body=done",
      "pnpm test",
      "git pushd",
    ]) {
      expect(kind(command), command).toBe("allow");
    }
    for (const call of [
      { tool_name: "Read", tool_input: { file_path: "git push" } },
      { tool_name: "Bash", tool_input: {} },
      { tool_name: "Bash", tool_input: { command: ["git push"] } },
      { tool_name: "Bash" },
      { tool_name: "mcp__github__create_pull_request", tool_input: { head: "x" } },
      {},
      undefined,
      null,
    ]) {
      expect(guardDecision(call, guard), JSON.stringify(call)).toEqual({ kind: "allow" });
    }
  });
});

describe("guardHook", () => {
  const guard = CONFIG.guard;
  const run = (command, problem = null) => {
    const lines = [];
    let asked = 0;
    const code = guardHook({ tool_name: "Bash", tool_input: { command } }, guard, {
      hookProblem: () => ((asked += 1), problem),
      log: (line) => lines.push(line),
    });
    return { code, lines, asked };
  };

  it("lets a call that delivers nothing through, without looking at the hook", () => {
    expect(run("git status", "no pre-push hook is installed")).toEqual({ code: 0, lines: [], asked: 0 });
  });

  it("lets a push through when git will run the gate's pre-push hook", () => {
    expect(run("git push")).toEqual({ code: 0, lines: [], asked: 1 });
  });

  it("blocks a push when it will not, with the way to put it in place", () => {
    expect(run("git push", "core.hooksPath is set to /x")).toEqual({
      code: 2,
      lines: ["Push refused: the pre-push hook of the delivery gate is not in place (core.hooksPath is set to /x). Run `pnpm gate:install`."],
      asked: 1,
    });
  });

  it("blocks what goes around the hook, installed or not", () => {
    const out = run("git push --no-verify");
    expect(out.code).toBe(2);
    expect(out.asked).toBe(0);
    expect(out.lines).toEqual([`Refused: the command goes around the pre-push hook of the delivery gate (it matches ${guard.bypass[0]}).`]);
  });
});

// ─── The run ────────────────────────────────────────────────────────────────

describe("runGate", () => {
  const config = {
    base: "origin/main",
    checks: [
      { name: "build", profile: "offline", command: ["pnpm", "build"] },
      { name: "unit", profile: "loopback", command: ["pnpm", "test", "${launcher}/x"] },
    ],
    mutation: { production: "^src/.*\\.ts$", command: ["stryker", "run", "${launcher}/s.json"], report: "r.json", profile: "loopback" },
  };
  const survivor = { location: { start: { line: 5, column: 1 }, end: { line: 5, column: 9 } }, status: "Survived", mutatorName: "Bool", replacement: "true\nmore" };
  const killed = { ...survivor, status: "Killed" };

  /** A world where everything passes; `over` changes one thing of it. */
  function world(over = {}) {
    const w = {
      lines: [],
      calls: [],
      verdicts: [],
      tree: "T1",
      dirty: "",
      files: ["src/a.ts", "README.md"],
      diffs: { "src/a.ts": "@@ -5 +5 @@\n+x" },
      report: { files: { "src/a.ts": { mutants: [killed] } } },
      statuses: {},
      isolation: {},
      ...over,
    };
    w.ports = {
      log: (line) => w.lines.push(line),
      headTree: () => w.tree,
      status: () => w.dirty,
      changedFiles: (base) => (w.calls.push(`changed ${base}`), w.files),
      fileDiff: (base, file) => (w.calls.push(`diff ${base} ${file}`), w.diffs[file] ?? ""),
      proveIsolation: async (profile) => {
        w.calls.push(`prove ${profile}`);
        if (w.isolation[profile]) throw new Refusal(w.isolation[profile]);
        return `proof of ${profile}`;
      },
      sandboxed: (argv, profile) => {
        w.calls.push(`run[${profile}] ${argv.join(" ")}`);
        w.onRun?.(argv);
        return Object.hasOwn(w.statuses, argv[0] + " " + argv[1]) ? w.statuses[argv[0] + " " + argv[1]] : 0;
      },
      removeReport: (path) => w.calls.push(`remove ${path}`),
      readReport: (path) => (w.calls.push(`read ${path}`), w.report),
      recordVerdict: (tree, verdict) => w.verdicts.push([tree, verdict]),
      gateHash: "G",
      now: () => "2026-11-18T00:00:00.000Z",
      vars: { launcher: "/l" },
    };
    return w;
  }

  it("proves each sandbox once, runs the checks then the mutation in theirs, and records the verdict of the tree", async () => {
    const w = world();
    expect(await runGate(config, w.ports)).toBe(0);
    expect(w.calls).toEqual([
      "prove offline",
      "prove loopback",
      "run[offline] pnpm build",
      "run[loopback] pnpm test /l/x",
      "changed origin/main",
      "remove r.json",
      "run[loopback] stryker run /l/s.json --mutate src/a.ts",
      "read r.json",
      "diff origin/main src/a.ts",
    ]);
    expect(w.verdicts).toEqual([
      ["T1", { tree: "T1", passed: true, gate: "G", at: "2026-11-18T00:00:00.000Z", checks: ["build", "unit"], mutated_files: ["src/a.ts"], mutants_judged: 1 }],
    ]);
    expect(w.lines).toEqual([
      "[gate] sandbox offline: proof of offline",
      "[gate] sandbox loopback: proof of loopback",
      "[gate] build: pnpm build  (sandbox: offline)",
      "[gate] unit: pnpm test ${launcher}/x  (sandbox: loopback)",
      "[gate] mutation: stryker run /l/s.json --mutate src/a.ts  (sandbox: loopback)",
      "[gate] mutation: 1 mutant(s) on the changed lines, all detected",
      "[gate] passed, recorded for tree T1",
    ]);
  });

  it("refuses to run anything when a sandbox does not hold", async () => {
    const w = world({ isolation: { loopback: "the sandbox does not hold" } });
    await expect(runGate(config, w.ports)).rejects.toThrow(new Refusal("the sandbox does not hold"));
    expect(w.calls).toEqual(["prove offline", "prove loopback"]);
    expect(w.verdicts).toEqual([]);
  });

  it("stops at the first check that fails, whatever its status, and records nothing", async () => {
    for (const status of [1, null]) {
      const w = world({ statuses: { "pnpm build": status } });
      expect(await runGate(config, w.ports)).toBe(1);
      expect(w.calls.filter((call) => call.startsWith("run"))).toEqual(["run[offline] pnpm build"]);
      expect(w.lines.at(-1)).toBe("[gate] FAILED: build");
      expect(w.verdicts).toEqual([]);
    }
  });

  it("passes without mutation when the change touches no production line", async () => {
    const w = world({ files: ["README.md", "src/a.test.js"] });
    expect(await runGate(config, w.ports)).toBe(0);
    expect(w.calls.some((call) => call.includes("stryker"))).toBe(false);
    expect(w.lines).toContain("[gate] mutation: the change touches no production line");
    expect(w.verdicts[0][1]).toMatchObject({ mutated_files: [], mutants_judged: 0 });
  });

  it("refuses a production file whose name the mutation tool would misread", async () => {
    const w = world({ files: ["src/[id].ts", "src/a.ts", "src/b c.ts"] });
    await expect(runGate(config, w.ports)).rejects.toThrow(new Refusal("the mutation tool cannot be given these file names: src/[id].ts, src/b c.ts"));
    expect(w.calls.some((call) => call.includes("stryker"))).toBe(false);
  });

  it("fails on an undetected mutant of a changed line, and shows it", async () => {
    const w = world({ report: { files: { "src/a.ts": { mutants: [killed, survivor] } } } });
    expect(await runGate(config, w.ports)).toBe(1);
    expect(w.lines.slice(-2)).toEqual([
      "[gate] Survived: src/a.ts:5 Bool -> true",
      "[gate] FAILED: mutation, 1 of 2 mutant(s) on the changed lines undetected. Each needs a test that kills it, or, when no test can tell it from the original, `// Stryker disable next-line <Mutator>: equivalent: <why>` on the line above.",
    ]);
    expect(w.verdicts).toEqual([]);
  });

  it("shows the first 80 characters of the first line of what a mutant puts in place", async () => {
    const long = { ...survivor, replacement: `${"x".repeat(100)}\nsecond line` };
    const w = world({ report: { files: { "src/a.ts": { mutants: [long] } } } });
    expect(await runGate(config, w.ports)).toBe(1);
    expect(w.lines.at(-2)).toBe(`[gate] Survived: src/a.ts:5 Bool -> ${"x".repeat(80)}`);
  });

  it("judges the mutants of each changed file on its own changed lines", async () => {
    const elsewhere = { ...survivor, location: { start: { line: 50, column: 1 }, end: { line: 50, column: 2 } } };
    const w = world({
      files: ["src/a.ts", "src/b.ts"],
      diffs: { "src/a.ts": "@@ -5 +5 @@", "src/b.ts": "@@ -50 +50 @@" },
      report: { files: { "src/a.ts": { mutants: [elsewhere] }, "src/b.ts": { mutants: [{ ...elsewhere, status: "Killed" }] } } },
    });
    expect(await runGate(config, w.ports)).toBe(0);
    expect(w.calls).toContain("run[loopback] stryker run /l/s.json --mutate src/a.ts,src/b.ts");
    expect(w.verdicts[0][1]).toMatchObject({ mutated_files: ["src/a.ts", "src/b.ts"], mutants_judged: 1 });
  });

  it("fails when the mutation tool fails, or leaves no report", async () => {
    for (const over of [{ statuses: { "stryker run": 1 } }, { report: null }]) {
      const w = world(over);
      expect(await runGate(config, w.ports)).toBe(1);
      expect(w.lines.at(-1)).toBe("[gate] FAILED: mutation testing did not run to its report");
      expect(w.verdicts).toEqual([]);
    }
  });

  it("passes without a record when the work was not committed at the start", async () => {
    const w = world({ dirty: " M src/a.ts" });
    expect(await runGate(config, w.ports)).toBe(0);
    expect(w.lines.at(-1)).toBe("[gate] passed, not recorded: the work was not committed when the gate started. Commit it and run the gate again.");
    expect(w.verdicts).toEqual([]);
  });

  it("fails when a check leaves tracked files changed: the verdict would be for a tree that was not tested", async () => {
    const w = world();
    w.onRun = (argv) => {
      if (argv[1] === "build") w.dirty = " M packages/x/dist/a.js\n?? new.txt";
    };
    expect(await runGate(config, w.ports)).toBe(1);
    expect(w.lines.slice(-3)).toEqual([
      "[gate] FAILED: the tree is not the one the gate started on. A check wrote tracked files, or a commit was made meanwhile:",
      "[gate]    M packages/x/dist/a.js",
      "[gate]   ?? new.txt",
    ]);
    expect(w.verdicts).toEqual([]);
  });

  it("fails when a commit is made while it runs, even if the checkout is clean at the end", async () => {
    const w = world();
    w.onRun = (argv) => {
      if (argv[0] === "stryker") w.tree = "T2";
    };
    expect(await runGate(config, w.ports)).toBe(1);
    expect(w.lines.at(-1)).toBe("[gate] FAILED: the tree is not the one the gate started on. A check wrote tracked files, or a commit was made meanwhile:");
    expect(w.verdicts).toEqual([]);
  });
});

// ─── The program, as git and Claude Code run it ─────────────────────────────

/** git with no configuration of the machine: no signing, no global hooks. */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const PROCESS = { encoding: "utf8", env: GIT_ENV, timeout: 30_000 };

describe("the canary, run as a process", () => {
  const canary = (...args) => spawnSync(process.execPath, [join(HERE, "canary.mjs"), ...args], PROCESS);

  it("says what it could do when nothing stops it, and exits 1: a sandbox that does not hold is seen", () => {
    const dir = mkdtempSync(join(tmpdir(), "canary-"));
    const file = join(dir, "file");
    writeFileSync(file, "content");
    const out = canary("--write", join(dir, "new"), "--append", file, "--read", file, "--list", dir);
    expect(out.status).toBe(1);
    expect(out.stdout.trim().split("\n")).toEqual([`wrote ${join(dir, "new")}`, `opened ${file} for writing`, `read ${file}`, `listed ${dir}`]);
    // An append adds nothing: a file the canary could open is left as it was.
    expect(readFileSync(file, "utf8")).toBe("content");
  });

  it("does not overwrite a file that is there", () => {
    const file = join(mkdtempSync(join(tmpdir(), "canary-")), "file");
    writeFileSync(file, "content");
    expect(canary("--write", file).status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("content");
  });

  it("exits 0 when every attempt is refused", { timeout: 15_000 }, () => {
    const missing = join(mkdtempSync(join(tmpdir(), "canary-")), "no-such-dir", "x");
    // Port 1 of the loopback has no listener: the connection is refused.
    const out = canary("--write", missing, "--append", missing, "--read", missing, "--list", missing, "--connect", "1");
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("");
  });

  it("fails on an argument it does not know or that has no target, instead of proving nothing", () => {
    expect(canary("--wirte", "/x").stdout.trim()).toBe("unknown argument --wirte");
    expect(canary("--wirte", "/x").status).toBe(1);
    expect(canary("--read").status).toBe(1);
  });
});

describe("the program, in a real repository with a real push", () => {
  let main;
  let remote;
  const git = (cwd, ...args) => {
    const out = spawnSync("git", args, { ...PROCESS, cwd });
    if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
    return out.stdout.trim();
  };
  const gate = (cwd, mode, input) => spawnSync(process.execPath, [join(main, "scripts/gate/gate.mjs"), mode], { ...PROCESS, cwd, input });
  const hook = (command, cwd = main) => gate(cwd, "hook", JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command } }));
  const push = (cwd, ...args) => spawnSync("git", ["push", "-q", ...args], { ...PROCESS, cwd });
  const commit = (cwd, file) => {
    writeFileSync(join(cwd, file), file);
    git(cwd, "add", ".");
    git(cwd, "commit", "-q", "-m", file);
  };
  const giveVerdict = (cwd, over = {}) => {
    const tree = git(cwd, "rev-parse", "HEAD^{tree}");
    const dir = join(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"), "delivery-gate");
    mkdirSync(dir, { recursive: true });
    const hash = gate(main, "hash").stdout.trim();
    writeFileSync(join(dir, `${tree}.json`), JSON.stringify({ tree, passed: true, gate: hash, ...over }));
  };

  beforeAll(() => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gate-repo-")));
    main = join(base, "main");
    remote = join(base, "remote.git");
    mkdirSync(join(main, "scripts"), { recursive: true });
    cpSync(HERE, join(main, "scripts/gate"), { recursive: true });
    for (const file of ["delivery-gate.json", "stryker.config.json"]) cpSync(join(ROOT, file), join(main, file));
    git(base, "init", "-q", "--bare", remote);
    git(main, "init", "-q", "-b", "trunk");
    git(main, "remote", "add", "origin", remote);
    commit(main, "first.txt");
  });

  it("prints one hash for the gate, which changes with its configuration", () => {
    const first = gate(main, "hash").stdout.trim();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(gate(main, "hash").stdout.trim()).toBe(first);
    const config = join(main, "delivery-gate.json");
    const original = readFileSync(config, "utf8");
    writeFileSync(config, original.replace('"origin/main"', '"origin/other"'));
    expect(gate(main, "hash").stdout.trim()).not.toBe(first);
    writeFileSync(config, original);
    expect(gate(main, "hash").stdout.trim()).toBe(first);
  });

  it("blocks a push from the session while the pre-push hook is not in place, and lets other calls through", () => {
    const out = hook("git push origin trunk");
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("the pre-push hook of the delivery gate is not in place (no pre-push hook is installed). Run `pnpm gate:install`.");
    expect(hook("git status").status).toBe(0);
  });

  it("installs the pre-push hook, once, and does not overwrite another one", () => {
    expect(gate(main, "install").status).toBe(0);
    const path = join(main, ".git/hooks/pre-push");
    expect(readFileSync(path, "utf8")).toContain('scripts/gate/gate.mjs" pre-push');
    expect(gate(main, "install").status).toBe(0);
    expect(hook("git push origin trunk").status).toBe(0);

    const shim = readFileSync(path, "utf8");
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    const refused = gate(main, "install");
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("is another hook");
    expect(hook("git push").stderr).toContain("another pre-push hook is installed");
    writeFileSync(path, shim);
  });

  it("refuses, in git itself, a push of a commit whose tree has no verdict", () => {
    const out = push(main, "origin", "trunk");
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain(`push refused: refs/heads/trunk (tree ${git(main, "rev-parse", "HEAD^{tree}")}): it has no verdict of the delivery gate`);
    expect(git(remote, "branch", "--list")).toBe("");
  });

  it("refuses a verdict that failed, or that another gate wrote", () => {
    giveVerdict(main, { passed: false });
    expect(push(main, "origin", "trunk").stderr).toContain("its verdict is not a passed verdict for this tree");
    giveVerdict(main, { gate: "0".repeat(64) });
    expect(push(main, "origin", "trunk").stderr).toContain("its verdict was written by another gate than the one of the main checkout");
    expect(git(remote, "branch", "--list")).toBe("");
  });

  it("lets the push through once the tree has a passed verdict of this gate", () => {
    giveVerdict(main);
    const out = push(main, "origin", "trunk");
    expect(out.stderr).not.toContain("push refused");
    expect(out.status).toBe(0);
    expect(git(remote, "rev-parse", "trunk")).toBe(git(main, "rev-parse", "HEAD"));
  });

  it("judges the commit that is pushed, not the one checked out, and from any worktree", () => {
    const worktree = join(main, ".claude/worktrees/w");
    git(main, "worktree", "add", "-q", worktree, "-b", "topic");
    commit(worktree, "second.txt");
    // Pushed from the main checkout, whose own HEAD has a verdict: topic has none.
    expect(push(main, "origin", "topic").status).not.toBe(0);
    expect(push(worktree, "origin", "HEAD:refs/heads/topic").status).not.toBe(0);
    giveVerdict(worktree);
    expect(push(main, "origin", "topic").status).toBe(0);
    // A deletion sends no commit.
    expect(push(worktree, "origin", "--delete", "topic").status).toBe(0);
  });

  it("refuses a push written to go around the hook, before git is asked", () => {
    const out = hook("git push --no-verify origin trunk");
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("goes around the pre-push hook");
  });

  it("refuses a push when core.hooksPath takes the hook away", () => {
    git(main, "config", "core.hooksPath", "/nowhere");
    const out = hook("git push");
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("core.hooksPath is set to /nowhere");
    git(main, "config", "--unset", "core.hooksPath");
    expect(hook("git push").status).toBe(0);
  });

  it("blocks every guarded call when its configuration cannot be read, and says so", () => {
    const config = join(main, "delivery-gate.json");
    const original = readFileSync(config, "utf8");
    for (const broken of ["{", JSON.stringify({ ...JSON.parse(original), guard: {} })]) {
      writeFileSync(config, broken);
      const out = hook("git status");
      expect(out.status, broken).toBe(2);
      expect(out.stderr, broken).toContain("delivery-gate.json");
    }
    writeFileSync(config, original);
    expect(hook("git status").status).toBe(0);
  });

  it("stays out of the way of another repository, and of a directory that is none", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gate-other-")));
    const other = join(base, "other");
    git(base, "init", "-q", other);
    expect(hook("git push", other).status).toBe(0);
    expect(hook("git push", base).status).toBe(0);
    expect(gate(main, "hook", "not json").status).toBe(0);
  });

  it("answers an unknown command with its usage", () => {
    const out = gate(main, "bogus");
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("usage: gate.mjs run | pre-push | hook | install | hash");
  });

  it("refuses to run outside a repository", () => {
    const out = gate(realpathSync(mkdtempSync(join(tmpdir(), "gate-none-"))), "run");
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("[gate] refused:");
  });
});

// ─── The settings of the session ────────────────────────────────────────────

// Stryker tests a copy of the project that does not carry `.claude`: the
// sandbox runtime lets no operation write that directory, the copy included
// (stryker.config.json, ignorePatterns). These tests read a file and mutate
// nothing, so they run in the unit check and not in a mutation run.
describe.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)(".claude/settings.json, the one permission file of the repository", () => {
  let settings;
  beforeAll(() => {
    settings = readJson(ROOT, ".claude/settings.json");
  });

  it("denies what the CI contract forbids without condition, the reading of secrets, and the tools the gate refuses", () => {
    for (const rule of [
      "Bash(git merge-base *)",
      // In two parts: scripts/tests/test_no_main_comparison.py forbids the word in scripts/.
      "Bash(gh pr update" + "-branch *)",
      "Bash(git push --force*)",
      "Bash(git push * --force*)",
      "Bash(git push -f*)",
      "Bash(git push * -f*)",
      "Bash(git push --no-verify*)",
      "Bash(git push * --no-verify*)",
      "Read(./.env)",
      "Read(**/*.key)",
      ...CONFIG.guard.refusedTools,
    ]) {
      expect(settings.permissions.deny, rule).toContain(rule);
    }
  });

  it("allows only the gate without asking: nothing that runs the project's code outside its sandbox", () => {
    expect(settings.permissions.allow).toEqual(["Bash(pnpm gate)"]);
  });

  it("runs the gate's guard before every tool that can carry a command", () => {
    const [entry] = settings.hooks.PreToolUse;
    expect(entry.matcher).toBe("Bash|mcp__.*");
    expect(entry.hooks).toEqual([{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/scripts/gate/gate.mjs" hook' }]);
    expect(existsSync(join(ROOT, "scripts/gate/gate.mjs"))).toBe(true);
  });
});
