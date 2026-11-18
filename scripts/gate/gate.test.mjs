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
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Refusal,
  blanketDisables,
  canaryPlan,
  commandsOf,
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
  safePath,
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
      [without("carry"), "carry must be a list of directory names"],
      [withValue("carry", ["node_modules", ""]), "carry must be a list of directory names"],
      [without("guard"), "guard must be an object"],
      [withValue("guard", null), "guard must be an object"],
      [without("guard.start"), "guard.start must be a regular expression"],
      [withValue("guard.start", "("), "guard.start is not a regular expression"],
      [withValue("guard.push", ["${nope}"]), "variable ${nope} is not defined"],
      [without("guard.push"), "guard.push must be a list"],
      [withValue("guard.push", [7]), "guard.push[0] must be a regular expression"],
      [withValue("guard.push", ["ok", "["]), "guard.push[1] is not a regular expression"],
      [without("guard.refuse"), "guard.refuse must be a list"],
      [withValue("guard.refuse", "x"), "guard.refuse must be a list"],
      [withValue("guard.refuse", [null]), "guard.refuse[0].pattern must be a regular expression"],
      [withValue("guard.refuse", [{ pattern: "x", why: "y" }, { pattern: "(", why: "y" }]), "guard.refuse[1].pattern is not a regular expression"],
      [withValue("guard.refuse", [{ pattern: "x" }]), "guard.refuse[0].why must say why"],
      [without("guard.hosted"), "guard.hosted must be a list of environment variable names"],
      [withValue("guard.hosted", "GITHUB_ACTIONS"), "guard.hosted must be a list of environment variable names"],
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
      expect(thrown.message, message).toContain(message);
      if (!message.startsWith("variable ")) expect(thrown.message, message).toContain(`delivery-gate.json: ${message}`);
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

describe("blanketDisables", () => {
  it("finds the lines that turn mutation off for more than the next line", () => {
    const source = [
      "// Stryker disable all: equivalent: x",
      "const a = 1;",
      "// Stryker disable next-line StringLiteral: equivalent: one element",
      "const b = [a].join(' ');",
      "/* Stryker disable StringLiteral,BooleanLiteral */",
      "//   Stryker   disable   all",
      "// Stryker restore all",
      "const c = 'Strykers disable nothing';",
      "// Stryker disable next-linear",
      "//  Stryker  disable   next-line all: equivalent: spaces do not make it a blanket",
    ].join("\n");
    expect(blanketDisables(source)).toEqual([1, 5, 6, 9]);
    expect(blanketDisables("")).toEqual([]);
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

describe("safePath", () => {
  const options = {
    isAbsolute: (dir) => dir.startsWith("/"),
    inside: (dir) => dir.startsWith("/w/") || dir === "/w",
  };

  it("keeps the absolute entries outside the judged and written trees, in order", () => {
    const path = "/w/node_modules/.bin:/usr/bin::./node_modules/.bin:/w:bin:/opt/tools/bin:/bin";
    expect(safePath(path, ":", options)).toBe("/usr/bin:/opt/tools/bin:/bin");
    expect(safePath("", ":", options)).toBe("");
    expect(safePath("/a;/w/x;/b", ";", options)).toBe("/a;/b");
  });
});

describe("the profiles of the gate", () => {
  const names = readdirSync(join(HERE, "profiles")).map((file) => file.replace(/\.json$/, ""));
  const profile = (name) => readJson(HERE, "profiles", `${name}.json`);
  const vars = { home: "/h", run: "/r", launcher: "/l", toolchain: ["/h/bin"] };

  it("exist for every operation of the configuration, and resolve with the variables the gate gives", () => {
    const used = new Set([...CONFIG.checks.map((check) => check.profile), CONFIG.mutation.profile]);
    for (const name of used) expect(names, name).toContain(name);
    for (const name of names) {
      const { srt, env } = resolveProfile(profile(name), vars, { PATH: "/bin" });
      expect(JSON.stringify(srt), name).not.toContain("${");
      expect(env, name).toEqual({ PATH: "/bin", HOME: "/r/home", TMPDIR: "/r/tmp", CLAUDE_CODE_TMPDIR: "/r/tmp", CI: "1" });
    }
  });

  it("let an operation write the directory of its run and nothing else, read nothing of the user's home, and reach nothing outside the machine", () => {
    for (const name of names) {
      const { srt } = resolveProfile(profile(name), vars, {});
      expect(srt.network.allowedDomains, name).toEqual([]);
      expect(srt.filesystem.allowWrite, name).toEqual(["/r"]);
      expect(srt.filesystem.denyRead, name).toEqual(["/h"]);
      expect(srt.filesystem.allowRead, name).toEqual(["/r", "/l", "/h/bin"]);
      // The directory the sandbox runtime shares between its sandboxes.
      expect(srt.filesystem.denyWrite, name).toEqual(["/tmp/claude", "/private/tmp/claude"]);
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
      denyWrite: ["/shared", "/w/file", "/w/absent"],
      denyRead: ["/h", "/h/.netrc", "/h/absent"],
    },
  });
  const kindOf = (path) => ({ "/w": "dir", "/git": "dir", "/shared": "dir", "/w/file": "file", "/h": "dir", "/h/.netrc": "file" })[path] ?? null;
  const plan = (network, over = {}) => canaryPlan(srt(network), { kindOf, keep: ["/w", "/git", "/gone"], hostPort: 4242, mark: "mark-1", ...over });

  it("tries a write in each directory that must be kept and each path the profile denies, each read it denies, and the host's port", () => {
    const { args, created, proves } = plan();
    expect(args).toEqual([
      "--write", "/w/mark-1",
      "--write", "/git/mark-1",
      "--write", "/shared/mark-1",
      "--append", "/w/file",
      "--list", "/h",
      "--read", "/h/.netrc",
      "--connect", "4242",
    ]);
    // What a sandbox that does not hold would leave: the gate removes it.
    expect(created).toEqual(["/w/mark-1", "/git/mark-1", "/shared/mark-1"]);
    expect(proves).toEqual({ writes: 4, reads: 2, port: true });
    // The line the canary prints when all seven were refused.
    expect(plan().expected).toBe("canary: 7 attempt(s), all refused");
    expect(plan({ allowLocalBinding: true }).expected).toBe("canary: 6 attempt(s), all refused");
  });

  it("does not try the host's port under a profile that grants the loopback", () => {
    const granted = plan({ allowLocalBinding: true });
    expect(granted.args).not.toContain("--connect");
    expect(granted.proves.port).toBe(false);
    // Only `true` grants it.
    expect(plan({ allowLocalBinding: "yes" }).proves.port).toBe(true);
  });

  it("tries nothing on a path that is not there", () => {
    const empty = plan({}, { kindOf: () => null });
    expect(empty.args).toEqual(["--connect", "4242"]);
    expect(empty.created).toEqual([]);
    expect(empty.proves).toEqual({ writes: 0, reads: 0, port: true });
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
      expect(verdictRefusal(verdict, "T", "G")).toBe("its verdict was written by another gate than the one of the base revision");
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
      "[gate] push refused: refs/heads/c (tree tree-of-c): its verdict was written by another gate than the one of the base revision. Commit the work and run the gate (pnpm gate).",
    ]);
  });

  it("lets a deletion and an empty push through", () => {
    expect(prePush(`(delete) ${ZERO} refs/heads/gone ${SHA("b")}`, ports({}))).toBe(0);
    expect(prePush("", ports({}))).toBe(0);
  });
});

// ─── The guard of the session ───────────────────────────────────────────────

describe("commandsOf", () => {
  it("splits a text where the shell starts a new command, and squeezes the spaces", () => {
    expect(commandsOf("git  status ; git\tlog && git push | cat & echo done\nls")).toEqual([
      "git status",
      "git log",
      "git push",
      "cat",
      "echo done",
      "ls",
    ]);
    expect(commandsOf("(cd x; git push)")).toEqual(["cd x", "git push"]);
    expect(commandsOf("echo $(git push -f) `git status`")).toEqual(["echo $", "git push -f", "git status"]);
    expect(commandsOf("")).toEqual([]);
    expect(commandsOf(" ;; \n ")).toEqual([]);
  });

  it("puts two quotes in place of a quoted string, whatever it holds", () => {
    expect(commandsOf(`gh pr comment 3 --body "no gh pr merge by hand; git push --force\nVerdict: approve"`)).toEqual(['gh pr comment 3 --body ""']);
    expect(commandsOf("git commit -m 'a; b | c && git push' && git push")).toEqual(['git commit -m ""', "git push"]);
    // An escaped quote does not close a double-quoted string; nothing is escaped between single quotes.
    expect(commandsOf('echo "a \\" ; git push" ; ls')).toEqual(['echo ""', "ls"]);
    expect(commandsOf("echo 'a\\' ; ls")).toEqual(['echo ""', "ls"]);
    // A string that is not closed runs to the end.
    expect(commandsOf('echo "open ; git push')).toEqual(['echo ""']);
    expect(commandsOf("echo 'open ; git push")).toEqual(['echo ""']);
    expect(commandsOf('a"b"c d')).toEqual(['a""c d']);
  });

  it("reads an escaped character as a character of a word, and an escaped line end as none", () => {
    expect(commandsOf("echo a\\;b ; ls")).toEqual(["echo a_b", "ls"]);
    expect(commandsOf('echo \\"x ; ls')).toEqual(["echo _x", "ls"]);
    expect(commandsOf("git \\\npush origin x")).toEqual(["git push origin x"]);
    expect(commandsOf("echo a\\")).toEqual(["echo a_"]);
  });

  it("leaves out the body of a here-document, and reads what follows it", () => {
    expect(commandsOf("cat <<EOF > f\ngit push --force\ngh pr merge 3\nEOF\ngit status")).toEqual(["cat > f", "git status"]);
    expect(commandsOf("cat <<-'END' | grep x\n  git push --force\n\tEND\nls")).toEqual(["cat", "grep x", "ls"]);
    expect(commandsOf('cat << "E.O-F"\nbody\nE.O-F\nls')).toEqual(["cat", "ls"]);
    // Two on one line, in order.
    expect(commandsOf("cat <<A <<B\na body\nA\nb body\nB\nls")).toEqual(["cat", "ls"]);
    // One that is not closed runs to the end; `<` alone and `<<<` are not one.
    expect(commandsOf("cat <<EOF\ngit push --force")).toEqual(["cat"]);
    expect(commandsOf("cat < file ; ls")).toEqual(["cat < file", "ls"]);
    expect(commandsOf("a << 1x\nbody\n1x\nls")).toEqual(["a", "ls"]);
  });
});

describe("guardDecision", () => {
  const guard = CONFIG.guard;
  const bash = (command, tool_name = "Bash") => ({ tool_name, tool_input: { command } });
  const decide = (command) => guardDecision(bash(command), guard);
  const why = (index) => guard.refuse[index].why;

  it("sees a push where a command starts, from any tool that carries a command", () => {
    for (const command of [
      "git push",
      "git push -u origin fix/x",
      "git push -u origin fix/119-commit-size",
      "git -c commit.gpgsign=false push",
      "git -C /repo push",
      "git --no-pager push",
      "git --git-dir=/r/.git push origin main",
      "git -c alias.p=push p",
      "cd x && git push",
      "git commit -m wip && git push",
      'git commit -m "a message" && git push',
      "git stash push -m wip",
      "command git push",
      "env X=1 git push",
      "GIT_TRACE=1 git push",
      "time git push",
      "(cd x; git push)",
      "echo ready\ngit push",
      "GIT PUSH",
      "git\tpush",
      "git subtree push --prefix=x origin y",
    ]) {
      expect(decide(command), command).toEqual({ kind: "push" });
    }
    expect(guardDecision(bash("git push", "mcp__some__start_process"), guard)).toEqual({ kind: "push" });
  });

  it("refuses what turns the pre-push hook off or goes around it, with the reason of its rule", () => {
    const cases = [
      ["git push --no-verify", 0],
      ["git push origin x --no-verify", 0],
      ["git push --no-veri", 0],
      ["cd x && git push --no-verify", 0],
      ["git -c core.hooksPath=/dev/null push", 1],
      ["git -c core.hookspath=/dev/null push", 1],
      ["git config core.hooksPath /tmp/h", 1],
      ["git config --global core.hooksPath /tmp/h", 1],
      ["git config set core.hooksPath /tmp/h", 1],
      ["git send-pack origin HEAD", 2],
      ["git http-push https://example.invalid/r.git", 2],
      ["git push --force origin x", 3],
      ["git -C . push --force-with-lease", 3],
      ["git push -f", 3],
      ["git push -uf origin x", 3],
      ["git push origin +HEAD:main", 3],
      ["git push origin +main", 3],
      ["git push --mirror", 3],
      ["gh pr merge 3 --squash", 4],
      ["GH_TOKEN=x gh pr merge 3", 4],
      ["gh api -X PATCH repos/o/r/git/refs/heads/x -f sha=abc", 5],
      ["gh api -XPUT repos/o/r/contents/README.md -fcontent=x", 5],
      ["gh api -X PUT repos/o/r/pulls/3/merge", 5],
      ["gh api --method POST repos/o/r/git/trees --input tree.json", 5],
      ["gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=abc", 6],
      ["gh api repos/o/r/pulls -f title=x -f head=y -f base=main", 6],
      ["gh api repos/o/r/merges --field base=main --field head=x", 6],
      ['curl -H "Authorization: Bearer $(gh auth token)" https://api.github.com/repos/o/r/git/refs', 7],
    ];
    for (const [command, rule] of cases) {
      expect(decide(command), command).toEqual({ kind: "refuse", reason: why(rule) });
    }
    expect(guard.refuse).toHaveLength(8);
    expect(why(0)).toContain("--no-verify");
    expect(why(3)).toContain("forced push");
    expect(why(4)).toContain("merges by hand");
  });

  it("does not read the text a command carries: a comment, a message or a script that names a refused command", () => {
    const nothing = [
      // What a review writes in its verdict comment.
      'gh pr comment 3 --body "No gh pr merge by hand, no git push --force, no curl https://api.github.com/x.\nVerdict: approve"',
      "gh pr comment 3 --body-file - <<EOF\ngh pr merge 3\ngit push --no-verify\nEOF",
      'gh pr create --title "fix: pre-push hook" -F body.md',
      'git commit -m "pre-push hook: chmod +x"',
      'git commit -m "document git push --force"',
      'git commit -m "git push is refused without a verdict"',
      'git commit -m "the push of the gate"',
      "git commit --no-verify -m wip",
      "echo use git push to deliver",
      "grep -rn 'gh pr merge' docs",
      "rg \"git push --no-verify\" scripts",
    ];
    for (const command of nothing) expect(decide(command), command).toEqual({ kind: "allow" });
  });

  it("does not refuse ordinary work that only looks like a refused command", () => {
    // Each of these is a push, or nothing: never a refusal.
    const pushes = [
      "git push -u origin feature/force-retry",
      "git push origin fix/-f",
      "tar -xf a.tar && git push",
      "ls -f; git push",
      "git push --follow-tags",
      "git push origin v1.2.3",
    ];
    for (const command of pushes) expect(decide(command), command).toEqual({ kind: "push" });
    const nothing = [
      "git config --get core.hooksPath",
      "git config --unset core.hooksPath",
      "git config unset core.hooksPath",
      "git config --get core.hooksPath && echo set",
      "rm -f x",
      "grep -f patterns file",
      "gh pr view 3",
      "gh pr list --search merge",
      // Reading through the API, and writing what is not a delivery (a comment).
      "gh api repos/o/r/pulls/3",
      "gh api repos/o/r/pulls",
      "gh api -X GET repos/o/r/pulls -f state=all",
      "gh api --method GET repos/o/r/pulls -f state=all",
      "gh api repos/o/r/contents/README.md",
      "gh api repos/o/r/issues/3/comments -f body=done",
      "gh api repos/o/r/pulls/3/comments -f body=done",
      "curl https://example.com/api.github.com.html",
      "curl -s https://registry.npmjs.org/x",
      "git status",
      "git log --oneline",
      "git fetch origin",
      "pnpm test",
      "git pushd",
    ];
    for (const command of nothing) expect(decide(command), command).toEqual({ kind: "allow" });
  });

  it("sees a push when any one of several expressions matches, whatever the case", () => {
    const two = { start: "^", push: ["${start}make deliver\\b", "\\bship\\b"], refuse: [], refusedTools: [] };
    expect(guardDecision(bash("make SHIP"), two)).toEqual({ kind: "push" });
    expect(guardDecision(bash("cd x && make deliver"), two)).toEqual({ kind: "push" });
    expect(guardDecision(bash("echo make deliver"), two)).toEqual({ kind: "allow" });
    expect(guardDecision(bash("make build"), two)).toEqual({ kind: "allow" });
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

  it("lets a call that carries no command through", () => {
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
  const run = (command, problem = null, env = {}) => {
    const lines = [];
    let asked = 0;
    const code = guardHook({ tool_name: "Bash", tool_input: { command } }, guard, {
      hookProblem: () => ((asked += 1), problem),
      env,
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
    expect(out.lines).toEqual([`Refused: ${guard.refuse[0].why}`]);
  });

  it("lets a push through on the hosted pipeline, where no hook is, and still refuses what is refused everywhere", () => {
    // A runner of GitHub Actions, and a cloud session of Claude Code (its documented variable).
    expect(guard.hosted).toEqual(["GITHUB_ACTIONS", "CLAUDE_CODE_REMOTE"]);
    const hosted = { GITHUB_ACTIONS: "true" };
    expect(run("git push origin fix/x", "no pre-push hook is installed", hosted)).toEqual({ code: 0, lines: [], asked: 0 });
    expect(run("git push", "no pre-push hook is installed", { CLAUDE_CODE_REMOTE: "true" }).code).toBe(0);
    expect(run("git push --force", "no pre-push hook is installed", hosted).code).toBe(2);
    expect(run("gh pr merge 3", null, hosted).code).toBe(2);
    // Only the value "true" says so, and only a variable the configuration names.
    for (const env of [{ GITHUB_ACTIONS: "false" }, { GITHUB_ACTIONS: "" }, { CI: "true" }, {}]) {
      expect(run("git push", "no pre-push hook is installed", env).code, JSON.stringify(env)).toBe(2);
    }
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
      sources: {},
      report: { files: { "src/a.ts": { mutants: [killed] } } },
      failing: [],
      isolation: {},
      ...over,
    };
    w.ports = {
      log: (line) => w.lines.push(line),
      headTree: () => w.tree,
      status: () => w.dirty,
      changedFiles: (base) => (w.calls.push(`changed ${base}`), w.files),
      fileDiff: (base, file) => (w.calls.push(`diff ${base} ${file}`), w.diffs[file] ?? ""),
      prepare: () => w.calls.push("prepare"),
      dispose: () => w.calls.push("dispose"),
      proveIsolation: async (profile) => {
        w.calls.push(`prove ${profile}`);
        if (w.isolation[profile]) throw new Refusal(w.isolation[profile]);
        return `proof of ${profile}`;
      },
      sandboxed: (argv, profile) => {
        w.calls.push(`run[${profile}] ${argv.join(" ")}`);
        const failing = w.failing.find(([name]) => name === argv[1]);
        return failing ? failing[1] : true;
      },
      readSource: (file) => (w.calls.push(`source ${file}`), w.sources[file] ?? "const x = 1;"),
      removeReport: (path) => w.calls.push(`remove ${path}`),
      readReport: (path) => (w.calls.push(`read ${path}`), w.report),
      recordVerdict: (tree, verdict) => w.verdicts.push([tree, verdict]),
      gateHash: "G",
      now: () => "2026-11-18T00:00:00.000Z",
      vars: { launcher: "/l" },
    };
    return w;
  }

  it("copies the committed tree, proves each sandbox once, runs the checks then the mutation, records the verdict, and removes the copy", async () => {
    const w = world();
    expect(await runGate(config, w.ports)).toBe(0);
    expect(w.calls).toEqual([
      "changed origin/main",
      "prepare",
      "prove offline",
      "prove loopback",
      "run[offline] pnpm build",
      "run[loopback] pnpm test /l/x",
      "source src/a.ts",
      "remove r.json",
      "run[loopback] stryker run /l/s.json --mutate src/a.ts",
      "read r.json",
      "diff origin/main src/a.ts",
      "dispose",
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

  it("refuses work that is not committed, before it copies or runs anything", async () => {
    const w = world({ dirty: " M src/a.ts\n?? new.txt" });
    await expect(runGate(config, w.ports)).rejects.toThrow(
      new Refusal("the gate judges the committed tree, and this work is not committed:\n M src/a.ts\n?? new.txt"),
    );
    expect(w.calls).toEqual([]);
    expect(w.verdicts).toEqual([]);
  });

  it("refuses a production file whose name the mutation tool would misread, before it copies anything", async () => {
    const w = world({ files: ["src/[id].ts", "src/a.ts", "src/b c.ts"] });
    await expect(runGate(config, w.ports)).rejects.toThrow(new Refusal("the mutation tool cannot be given these file names: src/[id].ts, src/b c.ts"));
    expect(w.calls).toEqual(["changed origin/main"]);
  });

  it("refuses to run anything when a sandbox does not hold, and removes the copy", async () => {
    const w = world({ isolation: { loopback: "the sandbox does not hold" } });
    await expect(runGate(config, w.ports)).rejects.toThrow(new Refusal("the sandbox does not hold"));
    expect(w.calls).toEqual(["changed origin/main", "prepare", "prove offline", "prove loopback", "dispose"]);
    expect(w.verdicts).toEqual([]);
  });

  it("stops at the first check that did not run to success, records nothing, and removes the copy", async () => {
    // false: failed or was ended; a value that is not `true` is not a success either.
    for (const result of [false, 0, undefined]) {
      const w = world({ failing: [["build", result]] });
      expect(await runGate(config, w.ports)).toBe(1);
      expect(w.calls.filter((call) => call.startsWith("run"))).toEqual(["run[offline] pnpm build"]);
      expect(w.lines.at(-1)).toBe("[gate] FAILED: build");
      expect(w.calls.at(-1)).toBe("dispose");
      expect(w.verdicts).toEqual([]);
    }
  });

  it("passes without mutation when the change touches no production line", async () => {
    const w = world({ files: ["README.md", "src/a.test.js"] });
    expect(await runGate(config, w.ports)).toBe(0);
    expect(w.calls.some((call) => call.includes("stryker") || call.startsWith("source"))).toBe(false);
    expect(w.lines).toContain("[gate] mutation: the change touches no production line");
    expect(w.verdicts[0][1]).toMatchObject({ mutated_files: [], mutants_judged: 0 });
  });

  it("fails when a changed file turns mutation off for more than one line, before it mutates", async () => {
    const w = world({
      files: ["src/a.ts", "src/b.ts"],
      sources: { "src/a.ts": "// Stryker disable all: equivalent: x\nconst a = 1;", "src/b.ts": "const b = 1;\n\n/* Stryker disable BooleanLiteral */" },
    });
    expect(await runGate(config, w.ports)).toBe(1);
    expect(w.lines.at(-1)).toBe(
      "[gate] FAILED: mutation is turned off for more than one line at src/a.ts:1, src/b.ts:3. Only `// Stryker disable next-line <Mutator>: equivalent: <why>` is accepted.",
    );
    expect(w.calls.some((call) => call.includes("stryker"))).toBe(false);
    expect(w.verdicts).toEqual([]);
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

  it("says which changed files the report does not name", async () => {
    const w = world({ files: ["src/a.ts", "src/types.ts", "src/index.ts"] });
    expect(await runGate(config, w.ports)).toBe(0);
    expect(w.lines.at(-2)).toBe("[gate] mutation: no mutant in src/types.ts, src/index.ts");
    // Nothing is said when the report names them all.
    expect(world().lines.some((line) => line.includes("no mutant in"))).toBe(false);
    const all = world();
    await runGate(config, all.ports);
    expect(all.lines.some((line) => line.includes("no mutant in"))).toBe(false);
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

  it("fails when the mutation tool did not run to success, or leaves no report", async () => {
    for (const over of [{ failing: [["run", false]] }, { failing: [["run", undefined]] }, { report: null }]) {
      const w = world(over);
      expect(await runGate(config, w.ports)).toBe(1);
      expect(w.lines.at(-1)).toBe("[gate] FAILED: mutation testing did not run to its report");
      expect(w.verdicts).toEqual([]);
    }
  });
});

// ─── The program, as git and Claude Code run it ─────────────────────────────

/** git with no configuration of the machine: no signing, no global hooks. */
const EMPTY_GIT_CONFIG = join(mkdtempSync(join(tmpdir(), "gate-gitconfig-")), "config");
writeFileSync(EMPTY_GIT_CONFIG, "");
// The variables of `guard.hosted` are taken out: where one is "true" the guard lets a push through, and these tests are about the hook.
const { GITHUB_ACTIONS: _runner, CLAUDE_CODE_REMOTE: _cloud, ...HOST_ENV } = process.env;
const GIT_ENV = { ...HOST_ENV, GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const PROCESS = { encoding: "utf8", env: GIT_ENV, timeout: 30_000 };

describe("the canary, run as a process", () => {
  const canary = (...args) => spawnSync(process.execPath, [join(HERE, "canary.mjs"), ...args], PROCESS);

  it("says what it could do when nothing stops it, and exits 1: a sandbox that does not hold is seen", () => {
    const dir = mkdtempSync(join(tmpdir(), "canary-"));
    const file = join(dir, "file");
    writeFileSync(file, "content");
    const out = canary("--write", join(dir, "new"), "--append", file, "--read", file, "--list", dir);
    expect(out.status).toBe(1);
    // No line says that all were refused.
    expect(out.stdout.trim().split("\n")).toEqual([`wrote ${join(dir, "new")}`, `opened ${file} for writing`, `read ${file}`, `listed ${dir}`]);
    // An append adds nothing: a file the canary could open is left as it was.
    expect(readFileSync(file, "utf8")).toBe("content");
  });

  it("does not overwrite a file that is there", () => {
    const file = join(mkdtempSync(join(tmpdir(), "canary-")), "file");
    writeFileSync(file, "content");
    const out = canary("--write", file);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe("canary: 1 attempt(s), all refused");
    expect(readFileSync(file, "utf8")).toBe("content");
  });

  it("exits 0 when every attempt is refused", { timeout: 15_000 }, () => {
    const missing = join(mkdtempSync(join(tmpdir(), "canary-")), "no-such-dir", "x");
    // Port 1 of the loopback has no listener: the connection is refused.
    const out = canary("--write", missing, "--append", missing, "--read", missing, "--list", missing, "--connect", "1");
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe("canary: 5 attempt(s), all refused");
  });

  it("fails on an argument it does not know or that has no target, instead of proving nothing", () => {
    expect(canary("--wirte", "/x").stdout.trim()).toBe("unknown argument --wirte");
    expect(canary("--wirte", "/x").status).toBe(1);
    expect(canary("--read").status).toBe(1);
  });
});

describe("the program, in a real repository with a real push", { timeout: 60_000 }, () => {
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
    // The base of the configuration, `origin/main`, with the gate on it: the hook takes its gate from there.
    git(main, "push", "-q", "origin", "trunk:main");
    git(main, "fetch", "-q", "origin");
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

  it("installs the pre-push hook, with node and git by their paths, and does not overwrite another one", () => {
    expect(gate(main, "install").status).toBe(0);
    const path = join(main, ".git/hooks/pre-push");
    const written = readFileSync(path, "utf8");
    expect(written).toContain("ref='refs/remotes/origin/main'");
    expect(written).toContain(`node='${realpathSync(process.execPath)}'`);
    expect(written).toMatch(/\ngit='\/[^'\n]+'\n/);
    // No program is taken from the PATH of whoever pushes.
    expect(written).toContain('PATH="$(dirname "$git"):/usr/bin:/bin"');
    expect(written).toContain('"$node" "$dir/scripts/gate/gate.mjs" pre-push "$@"');
    // It runs no file of a checkout.
    expect(written).not.toContain("git-common-dir");
    expect(gate(main, "install").status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(written);
    expect(hook("git push origin trunk").status).toBe(0);

    // A hook the gate did not write is left, and is not taken for the gate's.
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    const refused = gate(main, "install");
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("is another hook");
    expect(hook("git push").stderr).toContain("another pre-push hook is installed");

    // One the gate wrote for another revision is out of date, and is written again.
    writeFileSync(path, written.replace("refs/remotes/origin/main", "refs/remotes/origin/old"));
    expect(hook("git push").stderr).toContain("the pre-push hook is out of date");
    expect(gate(main, "install").status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(written);

    // One that names a node that is gone is not in place.
    writeFileSync(path, written.replace(`node='${realpathSync(process.execPath)}'`, "node='/nowhere/node'"));
    const gone = hook("git push");
    expect(gone.status).toBe(2);
    expect(gone.stderr).toContain("the pre-push hook names a node or a git that is gone");
    expect(gate(main, "install").status).toBe(0);
    expect(hook("git push").status).toBe(0);
  });

  it("installs the hook only on a branch of a remote that has the gate: it would otherwise refuse every push, or trust the commit", () => {
    const config = join(main, "delivery-gate.json");
    const original = readFileSync(config, "utf8");
    const withBase = (base) => writeFileSync(config, JSON.stringify({ ...JSON.parse(original), base }));
    const path = join(main, ".git/hooks/pre-push");
    const installed = readFileSync(path, "utf8");
    // The commit that is pushed, a local branch, a revision that is not there: none is a branch of a remote.
    for (const base of ["HEAD", "trunk", "origin/nowhere"]) {
      withBase(base);
      const out = gate(main, "install");
      expect(out.status, base).toBe(2);
      expect(out.stderr, base).toContain(`delivery-gate.json: base (${base}) is not a branch of a remote in this repository`);
      // The guard does not take the installed hook for the one of that configuration either.
      expect(hook("git push").status, base).toBe(2);
    }
    writeFileSync(config, original);
    expect(readFileSync(path, "utf8")).toBe(installed);

    // A remote branch that has no gate.
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gate-nogate-")));
    const other = join(base, "other");
    git(base, "init", "-q", "-b", "trunk", other);
    writeFileSync(join(other, "file.txt"), "x");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "no gate here");
    git(other, "update-ref", "refs/remotes/origin/main", "HEAD");
    const out = gate(other, "install");
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("refs/remotes/origin/main has no gate yet: install the hook once the gate is on it");
    expect(existsSync(join(other, ".git/hooks/pre-push"))).toBe(false);
  });

  it("refuses, in git itself, a push of a commit whose tree has no verdict", () => {
    const out = push(main, "origin", "trunk");
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain(`push refused: refs/heads/trunk (tree ${git(main, "rev-parse", "HEAD^{tree}")}): it has no verdict of the delivery gate`);
    expect(git(remote, "branch", "--list", "trunk")).toBe("");
  });

  it("refuses a verdict that failed, or that another gate wrote", () => {
    giveVerdict(main, { passed: false });
    expect(push(main, "origin", "trunk").stderr).toContain("its verdict is not a passed verdict for this tree");
    giveVerdict(main, { gate: "0".repeat(64) });
    expect(push(main, "origin", "trunk").stderr).toContain("its verdict was written by another gate than the one of the base revision");
    expect(git(remote, "branch", "--list", "trunk")).toBe("");
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
    expect(out.stderr).toContain(`Refused: ${CONFIG.guard.refuse[0].why}`);
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

  it("stays out of the way of another repository, and guards a directory that is in none like the project", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gate-other-")));
    const other = join(base, "other");
    git(base, "init", "-q", other);
    // Another repository: its pushes are its own business, written any way.
    expect(hook("git push --no-verify", other).status).toBe(0);
    // No repository: a command can name the project itself (`git -C`).
    expect(hook(`git -C ${main} push --no-verify`, base).status).toBe(2);
    expect(hook(`git -C ${main} push`, base).status).toBe(0);
    expect(gate(main, "hook", "not json").status).toBe(0);
  });

  it("does not take a pre-push hook that git cannot execute for one that is in place", () => {
    if (process.platform === "win32") return;
    const path = join(main, ".git/hooks/pre-push");
    chmodSync(path, 0o644);
    const out = hook("git push");
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("the pre-push hook is not executable");
    chmodSync(path, 0o755);
    expect(hook("git push").status).toBe(0);
  });

  // The gate itself runs on macOS and Linux only: its sandbox runtime does. The stand-in declares no
  // Node version of its own, so these tests run on every Node the repository supports.
  const gateRuns = process.platform !== "win32";
  describe.skipIf(!gateRuns)("run, with a stand-in for the sandbox runtime", { timeout: 120_000 }, () => {
    // The stand-in runs the command it is given with no isolation at all,
    // except that it answers the canary as told: the adapters of `run` are
    // what is tested here (the copy, the mark of success, the verdict), not
    // the sandbox, which the gate proves each time it really runs.
    //
    // `repo` is the main checkout. Each test commits there the gate's
    // configuration it needs and moves the remote branch `origin/base` onto
    // it: the gate of that revision, taken out of git, is the one that
    // judges. `work` is a worktree reset to it: the commits a test makes
    // there are what is judged.
    let repo;
    let work;
    const stub = (canary) => `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(process.argv.indexOf("--") + 1);
const canaryAt = argv.findIndex((arg) => arg.endsWith("canary.mjs"));
if (canaryAt !== -1) {
  ${canary === "holds" ? 'console.log(`canary: ${(argv.length - canaryAt - 1) / 2} attempt(s), all refused`); process.exit(0);' : ""}
  ${canary === "silent" ? "process.exit(0);" : ""}
}
if (argv.includes("--die")) process.exit(0); // as the runtime does when its command is ended by a signal
const out = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
process.exit(out.status ?? 1);
`;
    const setRuntime = (canary) => writeFileSync(join(repo, "node_modules/@anthropic-ai/sandbox-runtime/cli.mjs"), stub(canary));
    const FIXTURE = readJson(ROOT, "delivery-gate.json");
    const gateConfig = (over) => JSON.stringify({ ...FIXTURE, base: "origin/base", carry: ["carried"], checks: [], ...over });
    const setGate = (over) => {
      writeFileSync(join(repo, "delivery-gate.json"), gateConfig(over));
      git(repo, "add", "delivery-gate.json");
      git(repo, "commit", "-q", "--allow-empty", "-m", "the gate of the base");
      // The branch of the remote, as a fetch would leave it.
      git(repo, "update-ref", "refs/remotes/origin/base", "HEAD");
      git(work, "reset", "-q", "--hard", "origin/base");
    };
    const setChecks = (checks) => setGate({ checks });
    const node = (script, ...rest) => [process.execPath, "-e", script, ...rest];
    // Started from the main checkout's gate; the run is handed over to the gate of `base`.
    const own = (mode, cwd = work) => spawnSync(process.execPath, [join(repo, "scripts/gate/gate.mjs"), mode], { ...PROCESS, cwd });
    const runGateIn = () => own("run");
    const verdictOf = (cwd = work) => {
      const tree = git(cwd, "rev-parse", "HEAD^{tree}");
      const path = join(repo, ".git/delivery-gate", `${tree}.json`);
      return existsSync(path) ? readJson(path) : null;
    };
    const commitInWork = (file, content = file) => {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      writeFileSync(join(work, file), content);
      git(work, "add", ".");
      git(work, "commit", "-q", "-m", file);
    };

    beforeAll(() => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "gate-run-")));
      repo = join(base, "main");
      mkdirSync(join(repo, "scripts"), { recursive: true });
      cpSync(HERE, join(repo, "scripts/gate"), { recursive: true });
      for (const file of ["delivery-gate.json", "stryker.config.json"]) cpSync(join(ROOT, file), join(repo, file));
      const runtime = join(repo, "node_modules/@anthropic-ai/sandbox-runtime");
      mkdirSync(runtime, { recursive: true });
      writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "@anthropic-ai/sandbox-runtime", bin: { srt: "cli.mjs" } }));
      writeFileSync(join(repo, ".gitignore"), "node_modules\ncarried\nleft-behind.txt\n.claude/worktrees/\n");
      writeFileSync(join(repo, "tracked.txt"), "committed");
      git(repo, "init", "-q", "-b", "trunk");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "start");
      git(repo, "update-ref", "refs/remotes/origin/base", "HEAD");
      git(base, "init", "-q", "--bare", join(base, "remote.git"));
      git(repo, "remote", "add", "origin", join(base, "remote.git"));
      work = join(repo, ".claude/worktrees/work");
      git(repo, "worktree", "add", "-q", work, "-b", "topic");
      mkdirSync(join(work, "carried"));
      writeFileSync(join(work, "carried/installed.txt"), "installed");
      setRuntime("holds");
    });

    it("runs each check in a copy of the committed tree, with the carried directories, and records the verdict", () => {
      setChecks([
        {
          name: "reads",
          profile: "offline",
          // The copy has the committed files and the carried directory, and is not the worktree.
          command: node(
            `const fs=require("fs");if(fs.readFileSync("tracked.txt","utf8")!=="committed"||fs.readFileSync("change.txt","utf8")!=="change.txt"||fs.readFileSync("carried/installed.txt","utf8")!=="installed"||process.cwd()===process.argv[1])process.exit(1);fs.writeFileSync("left-behind.txt","x")`,
            work,
          ),
        },
      ]);
      commitInWork("change.txt");
      const out = runGateIn();
      expect(out.stderr).toContain("[gate] judged by the gate of origin/base");
      expect(out.stderr).toContain("[gate] passed, recorded for tree");
      expect(out.status).toBe(0);
      expect(verdictOf()).toMatchObject({ passed: true, checks: ["reads"], mutated_files: [], mutants_judged: 0, gate: own("hash").stdout.trim() });
      // What the check wrote is gone with the copy: the worktree is as it was.
      expect(existsSync(join(work, "left-behind.txt"))).toBe(false);
      expect(readdirSync(join(repo, ".git/delivery-gate")).filter((name) => name.startsWith("run-"))).toEqual([]);
      expect(git(work, "status", "--porcelain")).toBe("");
    });

    it("fails on a check that fails, and on one that is ended before it succeeds, though the runtime exits 0", () => {
      setChecks([{ name: "fails", profile: "offline", command: node("process.exit(3)") }]);
      commitInWork("second.txt");
      let out = runGateIn();
      expect(out.status).toBe(1);
      expect(out.stderr).toContain("[gate] FAILED: fails");
      expect(verdictOf()).toBeNull();

      setChecks([{ name: "ended", profile: "offline", command: node("0", "--die") }]);
      commitInWork("second.txt");
      out = runGateIn();
      expect(out.status).toBe(1);
      expect(out.stderr).toContain("[gate] FAILED: ended");
      expect(verdictOf()).toBeNull();
    });

    it("refuses work that is not committed, an untracked file included", () => {
      setChecks([{ name: "ok", profile: "offline", command: node("0") }]);
      writeFileSync(join(work, "untracked.txt"), "x");
      const out = runGateIn();
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("the gate judges the committed tree, and this work is not committed:\n?? untracked.txt");
      expect(verdictOf()).toBeNull();
      git(work, "add", ".");
      git(work, "commit", "-q", "-m", "now committed");
      expect(runGateIn().status).toBe(0);
    });

    it("refuses to run when the canary could do what the profile denies, and leaves nothing behind", () => {
      setChecks([{ name: "never", profile: "offline", command: node(`require("fs").writeFileSync(process.argv[1],"ran")`, join(repo, "..", "ran.txt")) }]);
      commitInWork("third.txt");
      setRuntime("breached");
      const out = runGateIn();
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("[gate] refused: the sandbox does not hold under profile offline: wrote ");
      expect(existsSync(join(repo, "..", "ran.txt"))).toBe(false);
      expect(verdictOf()).toBeNull();
      // The files the canary could create are removed, and so is the copy.
      expect(git(work, "status", "--porcelain", "--untracked-files=all")).toBe("");
      expect(readdirSync(join(repo, ".git")).filter((name) => name.startsWith("gate-canary-"))).toEqual([]);
      expect(readdirSync(join(repo, ".git/delivery-gate")).filter((name) => name.startsWith("run-"))).toEqual([]);
      setRuntime("holds");
    });

    it("refuses when the canary ends with status 0 without saying that all was refused", () => {
      setRuntime("silent");
      const out = runGateIn();
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("the sandbox does not hold under profile offline: the canary could not run");
      setRuntime("holds");
    });

    it("gives the operation a PATH with no entry of the judged tree, none that is relative, and none that links into it", () => {
      setChecks([{ name: "path", profile: "offline", command: node(`require("fs").writeFileSync(process.argv[1], process.env.PATH)`, join(repo, "..", "path.txt")) }]);
      const linked = join(repo, "..", "linked-bin");
      mkdirSync(join(work, "bin"), { recursive: true });
      symlinkSync(join(work, "bin"), linked);
      const out = spawnSync(process.execPath, [join(repo, "scripts/gate/gate.mjs"), "run"], {
        ...PROCESS,
        cwd: work,
        env: { ...GIT_ENV, PATH: [join(work, "node_modules/.bin"), "./node_modules/.bin", linked, process.env.PATH].join(delimiter) },
      });
      expect(out.status, out.stderr).toBe(0);
      const seen = readFileSync(join(repo, "..", "path.txt"), "utf8").split(delimiter);
      expect(seen).not.toContain(join(work, "node_modules/.bin"));
      expect(seen).not.toContain("./node_modules/.bin");
      expect(seen).not.toContain(linked);
      expect(seen.length).toBeGreaterThan(0);
    });

    it("does not run a git that a link on PATH takes from the judged tree", () => {
      setChecks([{ name: "ok", profile: "offline", command: node("0") }]);
      // A directory outside the tree, on PATH first, whose `git` is a link to a file of the tree.
      const outsideBin = join(repo, "..", "outside-bin");
      mkdirSync(outsideBin, { recursive: true });
      writeFileSync(join(work, "bin/git"), `#!/bin/sh\necho planted > "${join(repo, "..", "planted.txt")}"\nexit 1\n`);
      chmodSync(join(work, "bin/git"), 0o755);
      symlinkSync(join(work, "bin/git"), join(outsideBin, "git"));
      git(work, "add", ".");
      git(work, "commit", "-q", "-m", "a git of its own");
      const out = spawnSync(process.execPath, [join(repo, "scripts/gate/gate.mjs"), "run"], {
        ...PROCESS,
        cwd: work,
        env: { ...GIT_ENV, PATH: [outsideBin, process.env.PATH].join(delimiter) },
      });
      expect(out.status, out.stderr).toBe(0);
      expect(existsSync(join(repo, "..", "planted.txt"))).toBe(false);
    });

    it("copies each file as git stores it: no filter of the machine runs, modes and links are kept", () => {
      // A smudge filter the repository's configuration names, and a commit that asks for it.
      const ran = join(repo, "..", "filter-ran.txt");
      git(repo, "config", "filter.planted.smudge", `sh -c 'echo ran > "${ran}"; cat'`);
      setChecks([
        {
          name: "reads",
          profile: "offline",
          command: node(
            `const fs=require("fs");const ok=fs.readFileSync("filtered.txt","utf8")==="as stored\\n"&&(fs.statSync("run.sh").mode&0o111)!==0&&(fs.statSync("plain.txt").mode&0o111)===0&&fs.lstatSync("link").isSymbolicLink()&&fs.readlinkSync("link")==="plain.txt"&&fs.readFileSync("dir/deep/file.bin").equals(Buffer.from([0,255,10,13,10]));process.exit(ok?0:1)`,
          ),
        },
      ]);
      writeFileSync(join(work, ".gitattributes"), "filtered.txt filter=planted\n");
      writeFileSync(join(work, "filtered.txt"), "as stored\n");
      writeFileSync(join(work, "plain.txt"), "plain");
      writeFileSync(join(work, "run.sh"), "#!/bin/sh\n");
      chmodSync(join(work, "run.sh"), 0o755);
      symlinkSync("plain.txt", join(work, "link"));
      mkdirSync(join(work, "dir/deep"), { recursive: true });
      writeFileSync(join(work, "dir/deep/file.bin"), Buffer.from([0, 255, 10, 13, 10]));
      git(work, "add", ".");
      git(work, "commit", "-q", "-m", "files of every kind");
      const out = runGateIn();
      expect(out.status, out.stderr).toBe(0);
      expect(existsSync(ran)).toBe(false);
      git(repo, "config", "--unset", "filter.planted.smudge");
    });

    it("mutates the changed production files, and says which ones the report does not name", () => {
      setGate({
        mutation: {
          production: "^src/.*\\.js$",
          // "--": what the gate appends (--mutate …) is for the script, not for node.
          command: node(`const fs=require("fs");fs.mkdirSync("reports/mutation",{recursive:true});fs.writeFileSync("reports/mutation/mutation.json",JSON.stringify({files:{}}))`, "--"),
          report: "reports/mutation/mutation.json",
          profile: "loopback",
        },
      });
      commitInWork("src/a.js", "export const a = 1;\n");
      const out = runGateIn();
      expect(out.stderr).toContain("--mutate src/a.js  (sandbox: loopback)");
      expect(out.stderr).toContain("[gate] mutation: no mutant in src/a.js");
      expect(out.status, out.stderr).toBe(0);
      expect(verdictOf()).toMatchObject({ mutated_files: ["src/a.js"], mutants_judged: 0 });
    });

    it("does not follow a link a check leaves in the copy to a file outside it", () => {
      const outside = join(repo, "..", "outside-reports");
      mkdirSync(join(outside, "mutation"), { recursive: true });
      writeFileSync(join(outside, "mutation/mutation.json"), "kept");
      setGate({
        // The check plants `reports` as a link to a directory outside the copy.
        checks: [{ name: "plants", profile: "offline", command: node(`require("fs").symlinkSync(process.argv[1], "reports")`, outside) }],
        mutation: { production: "^src/.*\\.js$", command: node("0", "--"), report: "reports/mutation/mutation.json", profile: "loopback" },
      });
      commitInWork("src/b.js", "export const b = 1;\n");
      const out = runGateIn();
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("reports/mutation/mutation.json leads outside the copy of the tree");
      expect(readFileSync(join(outside, "mutation/mutation.json"), "utf8")).toBe("kept");
      expect(verdictOf()).toBeNull();
    });

    it("does not read through a link a check puts in place of the copy itself", () => {
      const elsewhere = join(repo, "..", "elsewhere");
      mkdirSync(join(elsewhere, "src"), { recursive: true });
      mkdirSync(join(elsewhere, "reports/mutation"), { recursive: true });
      writeFileSync(join(elsewhere, "src/c.js"), "// Stryker disable all\n");
      writeFileSync(join(elsewhere, "reports/mutation/mutation.json"), "kept");
      setGate({
        // The check moves the copy aside and leaves a link to another directory under its name.
        checks: [
          {
            name: "swaps",
            profile: "offline",
            command: node(`const fs=require("fs");const here=process.cwd();fs.renameSync(here,here+"-aside");fs.symlinkSync(process.argv[1],here)`, elsewhere),
          },
        ],
        mutation: { production: "^src/.*\\.js$", command: node("0", "--"), report: "reports/mutation/mutation.json", profile: "loopback" },
      });
      commitInWork("src/c.js", "export const c = 1;\n");
      const out = runGateIn();
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("src/c.js leads outside the copy of the tree");
      expect(readFileSync(join(elsewhere, "reports/mutation/mutation.json"), "utf8")).toBe("kept");
      expect(verdictOf()).toBeNull();
    });

    it("judges a commit that brings a weaker gate with the gate of the base, even when started from the commit's own gate", () => {
      // The gate of the base refuses a tree that holds bad.txt.
      setChecks([{ name: "no-bad-file", profile: "offline", command: node(`process.exit(require("fs").existsSync("bad.txt") ? 1 : 0)`) }]);
      // The commit adds the file, and a gate of its own that checks nothing.
      writeFileSync(join(work, "delivery-gate.json"), gateConfig({ checks: [] }));
      commitInWork("bad.txt");
      const out = spawnSync(process.execPath, [join(work, "scripts/gate/gate.mjs"), "run"], { ...PROCESS, cwd: work });
      expect(out.stderr).toContain("[gate] judged by the gate of origin/base");
      expect(out.stderr).toContain("[gate] FAILED: no-bad-file");
      expect(out.status).toBe(1);
      expect(verdictOf()).toBeNull();
    });

    it("refuses at the push the verdict of a gate the commit brought with it", () => {
      setChecks([{ name: "no-bad-file", profile: "offline", command: node(`process.exit(require("fs").existsSync("bad.txt") ? 1 : 0)`) }]);
      expect(own("install", repo).status).toBe(0);
      // The commit names itself as the base and checks nothing: its own gate judges it, and passes it.
      writeFileSync(join(work, "delivery-gate.json"), gateConfig({ base: "HEAD", checks: [] }));
      commitInWork("bad.txt");
      const selfJudged = spawnSync(process.execPath, [join(work, "scripts/gate/gate.mjs"), "run"], { ...PROCESS, cwd: work });
      expect(selfJudged.stderr).toContain("[gate] judged by the gate of HEAD");
      expect(selfJudged.status, selfJudged.stderr).toBe(0);
      expect(verdictOf()).toMatchObject({ passed: true });
      // git's hook runs the gate of `base`, out of git: that verdict is not one of its own.
      const pushed = spawnSync("git", ["push", "-q", "origin", "HEAD:refs/heads/topic"], { ...PROCESS, cwd: work });
      expect(pushed.status).not.toBe(0);
      expect(pushed.stderr).toContain("its verdict was written by another gate");
      expect(git(join(repo, "..", "remote.git"), "branch", "--list")).toBe("");
      // Where the revision of the hook is gone, the push is refused: no gate is read from a checkout.
      const kept = git(repo, "rev-parse", "refs/remotes/origin/base");
      git(repo, "update-ref", "-d", "refs/remotes/origin/base");
      const orphan = spawnSync("git", ["push", "-q", "origin", "HEAD:refs/heads/topic"], { ...PROCESS, cwd: work });
      expect(orphan.status).not.toBe(0);
      expect(orphan.stderr).toContain("[gate] push refused: refs/remotes/origin/base has no delivery gate in this repository");
      git(repo, "update-ref", "refs/remotes/origin/base", kept);
      // A commit the gate of the base passed is pushed.
      git(work, "reset", "-q", "--hard", "origin/base");
      commitInWork("good.txt");
      expect(runGateIn().status).toBe(0);
      expect(spawnSync("git", ["push", "-q", "origin", "HEAD:refs/heads/topic"], { ...PROCESS, cwd: work }).status).toBe(0);
    });

    it("removes the directory a killed run left, and leaves the one of a run that is alive", () => {
      setChecks([{ name: "ok", profile: "offline", command: node("0") }]);
      const runs = join(repo, ".git/delivery-gate");
      const dead = join(runs, "run-dead");
      const alive = join(runs, "run-alive");
      for (const [dir, pid] of [[dead, "999999999"], [alive, String(process.pid)]]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "pid"), pid);
      }
      mkdirSync(join(runs, "run-nopid"));
      expect(runGateIn().status).toBe(0);
      expect(readdirSync(runs).filter((name) => name.startsWith("run-"))).toEqual(["run-alive"]);
    });

    it("refuses on a Node older than the one the sandbox runtime declares", () => {
      setChecks([{ name: "ok", profile: "offline", command: node("0") }]);
      commitInWork("node.txt");
      const pkg = join(repo, "node_modules/@anthropic-ai/sandbox-runtime/package.json");
      const original = readFileSync(pkg, "utf8");
      writeFileSync(pkg, JSON.stringify({ ...JSON.parse(original), engines: { node: ">=999.1.0" } }));
      const out = runGateIn();
      expect(out.status).toBe(2);
      expect(out.stderr).toContain(`the sandbox runtime needs Node 999.1 or later (this is ${process.versions.node})`);
      // The same major, a later minor.
      const [major, minor] = process.versions.node.split(".").map(Number);
      writeFileSync(pkg, JSON.stringify({ ...JSON.parse(original), engines: { node: `>=${major}.${minor + 1}.0` } }));
      expect(runGateIn().status).toBe(2);
      // The one it runs on, and none declared.
      writeFileSync(pkg, JSON.stringify({ ...JSON.parse(original), engines: { node: `>=${major}.${minor}.0` } }));
      expect(runGateIn().status).toBe(0);
      writeFileSync(pkg, original);
      commitInWork("node2.txt");
      expect(runGateIn().status).toBe(0);
    });

    it("refuses when the sandbox runtime is not installed", () => {
      const pkg = join(repo, "node_modules/@anthropic-ai/sandbox-runtime/package.json");
      const original = readFileSync(pkg, "utf8");
      writeFileSync(pkg, "{}");
      const out = runGateIn();
      expect(out.status).toBe(2);
      expect(out.stderr).toContain("the sandbox runtime is not installed in the gate's checkout");
      writeFileSync(pkg, original);
    });
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
      "Bash(gh pr merge *)",
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

  it("allows only the gate without asking", () => {
    expect(settings.permissions.allow).toEqual(["Bash(pnpm gate)"]);
  });

  it("runs the gate's guard before every tool that can carry a command", () => {
    const [entry] = settings.hooks.PreToolUse;
    expect(entry.matcher).toBe("Bash|mcp__.*");
    // Any way the guard ends other than "let it through" blocks the call (a crash, a missing node);
    // a checkout that has no gate at all is not guarded.
    // "No gate" is read from the commit, not from the working tree: a gate file moved aside blocks.
    expect(entry.hooks).toEqual([
      {
        type: "command",
        command: 'cd "$CLAUDE_PROJECT_DIR" || exit 2; git cat-file -e HEAD:scripts/gate/gate.mjs 2>/dev/null || exit 0; node scripts/gate/gate.mjs hook || exit 2',
      },
    ]);
    expect(existsSync(join(ROOT, "scripts/gate/gate.mjs"))).toBe(true);
  });
});
