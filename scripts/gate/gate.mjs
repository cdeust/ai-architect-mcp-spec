#!/usr/bin/env node
/**
 * The delivery gate, as a program: the adapters of gate-lib.mjs (git, the
 * sandbox runtime, files) and the commands that use them. The decisions are
 * in gate-lib.mjs; nothing is decided here.
 *
 *   gate.mjs run        judge the commit checked out in the current directory
 *   gate.mjs pre-push   the pre-push hook of git: refuse a push of a commit
 *                       whose tree has no passed verdict of this gate
 *   gate.mjs hook       the PreToolUse hook of Claude Code: refuse what goes
 *                       around the pre-push hook (exit 2 blocks the call)
 *   gate.mjs install    put the pre-push hook in the git directory
 *   gate.mjs hash       print the hash of this gate (code, configuration,
 *                       profiles)
 *
 * The gate that judges is this file's own checkout (the launcher), not the
 * tree it judges: its configuration, its profiles, its canary and its
 * sandbox runtime are read from beside this file. The pre-push hook runs the
 * gate of the main checkout and accepts the verdicts of that gate only, so
 * a change that rewrites the gate is judged by the gate it replaces.
 *
 * Exit codes: 0 passed or let through; 1 failed or refused by git's hook;
 * 2 refused (configuration, repository state, a sandbox that does not hold,
 * or a call the PreToolUse hook blocks).
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Refusal, canaryPlan, guardDecision, guardHook, prePush, resolveProfile, runGate, safePath, validateConfig } from "./gate-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this gate belongs to: its files judge, they are not judged. */
const LAUNCHER = realpathSync(resolve(HERE, "..", ".."));
const GATE_FILES = ["delivery-gate.json", "stryker.config.json", "scripts/gate/gate.mjs", "scripts/gate/gate-lib.mjs", "scripts/gate/canary.mjs"];
const PROFILES = join(HERE, "profiles");

const inside = (path, root) => path === root || path.startsWith(root + sep);

/**
 * A program, by its absolute path, found on PATH outside the given trees: a
 * tree that is judged, or one a sandboxed operation wrote, must never supply
 * what runs outside the sandbox.
 */
function findOnPath(program, outside) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "" || outside.some((root) => inside(resolve(dir), root))) continue;
    for (const name of process.platform === "win32" ? [`${program}.exe`] : [program]) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  throw new Refusal(`${program} is not on PATH outside the tree that is judged`);
}

function makeGit(gitPath, cwd) {
  return (args, env = {}) => {
    const out = spawnSync(gitPath, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env } });
    if (out.status !== 0) throw new Refusal(`git ${args.join(" ")}: ${(out.stderr ?? "").trim() || out.error?.message}`);
    return out.stdout;
  };
}

/**
 * The repository the directory is in. git is found outside that directory
 * first, then outside the root of its worktree once git has named it, and
 * every later call runs from that root: a directory below it cannot answer
 * for the repository.
 */
function repository(cwd) {
  const start = realpathSync(cwd);
  const probe = makeGit(findOnPath("git", [start, LAUNCHER]), start);
  const root = realpathSync(probe(["rev-parse", "--show-toplevel"]).trim());
  const git = makeGit(findOnPath("git", [root, LAUNCHER]), root);
  const common = realpathSync(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
  return { git, root, common };
}

function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(LAUNCHER, "delivery-gate.json"), "utf8"));
  } catch (error) {
    throw new Refusal(`delivery-gate.json cannot be read (${error.message})`);
  }
  return validateConfig(raw);
}

/** One hash for everything that judges: a verdict names the gate that wrote it. */
function gateHash() {
  const hash = createHash("sha256");
  const profiles = readdirSync(PROFILES).filter((name) => name.endsWith(".json")).sort();
  for (const file of [...GATE_FILES, ...profiles.map((name) => `scripts/gate/profiles/${name}`)]) {
    hash.update(file).update("\0").update(readFileSync(join(LAUNCHER, file))).update("\0");
  }
  return hash.digest("hex");
}

const verdictPath = (common, tree) => join(common, "delivery-gate", `${tree}.json`);

function readVerdict(common, tree) {
  try {
    return JSON.parse(readFileSync(verdictPath(common, tree), "utf8"));
  } catch {
    return null;
  }
}

// ─── The run: a disposable copy, and a sandbox per operation ────────────────

/** The sandbox runtime of the launcher, as the file node runs. */
function sandboxRuntime() {
  const pkgDir = join(LAUNCHER, "node_modules", "@anthropic-ai", "sandbox-runtime");
  let bin;
  try {
    bin = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).bin.srt;
  } catch {
    throw new Refusal("the sandbox runtime is not installed in the gate's checkout (pnpm install)");
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Refusal(`the sandbox runtime needs Node 22.12 or later (this is ${process.versions.node})`);
  }
  return realpathSync(join(pkgDir, bin));
}

const kindOf = (path) => {
  try {
    return statSync(path).isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
};

/**
 * The directory of one run of the gate, beside the verdicts in the git
 * directory: on the volume of the repository, outside every worktree. It
 * holds the copy of the committed tree (tree/), and the temporary directory
 * and home of the operations. It is the only place an operation writes.
 */
function makeRun({ git, root, common }, config, commit) {
  const runtime = sandboxRuntime();
  const sh = findOnPath("sh", [root, LAUNCHER]);
  const runs = join(common, "delivery-gate");
  mkdirSync(runs, { recursive: true });
  // A run that was killed leaves its directory: one whose process is gone is removed here.
  for (const name of readdirSync(runs).filter((entry) => entry.startsWith("run-"))) {
    let alive = true;
    try {
      process.kill(Number(readFileSync(join(runs, name, "pid"), "utf8")), 0);
    } catch {
      alive = false;
    }
    if (!alive) rmSync(join(runs, name), { recursive: true, force: true });
  }
  const run = realpathSync(mkdtempSync(join(runs, "run-")));
  writeFileSync(join(run, "pid"), String(process.pid));
  const tree = join(run, "tree");
  const settingsDir = realpathSync(mkdtempSync(join(tmpdir(), "gate-settings-")));
  const home = realpathSync(homedir());
  // PATH for the runtime and the operation: nothing a check can write, and
  // nothing relative, which the runtime would read from the copy.
  const written = [root, LAUNCHER, run];
  const path = safePath(process.env.PATH ?? "", delimiter, {
    isAbsolute,
    inside: (dir) => written.some((place) => inside(resolve(dir), place)),
  });
  const hostEnv = { ...process.env, PATH: path };
  // What an operation may read of the user's home: the tools PATH names there.
  const toolchain = path
    .split(delimiter)
    .filter((dir) => dir !== "" && existsSync(dir))
    .map((dir) => realpathSync(dir))
    .filter((dir) => inside(dir, home));
  const vars = { home, run, launcher: LAUNCHER, toolchain };

  /** The tree of the commit, as git checks it out, then the installed dependencies of the worktree. */
  const prepare = () => {
    for (const dir of ["tmp", "home", "tree"]) mkdirSync(join(run, dir));
    const index = { GIT_INDEX_FILE: join(run, "index") };
    git(["read-tree", commit], index);
    git(["checkout-index", "--all", `--prefix=${tree}/`], index);
    // Ignored directories the configuration names (node_modules): what is
    // installed is not in the commit, and the checks need it.
    const ignored = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).split("\0");
    for (const entry of ignored) {
      const path = entry.replace(/\/$/, "");
      if (path === "" || !config.carry.includes(basename(path))) continue;
      cpSync(join(root, path), join(tree, path), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    }
  };

  const dispose = () => {
    rmSync(run, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
  };

  const loadProfile = (name) => {
    try {
      return JSON.parse(readFileSync(join(PROFILES, `${name}.json`), "utf8"));
    } catch (error) {
      throw new Refusal(`profile ${name} cannot be read (${error.message})`);
    }
  };

  /** Start `argv` in the copy, under the profile; the settings file is outside what the operation writes. */
  const start = (profileName, argv, stdio) => {
    const resolved = resolveProfile(loadProfile(profileName), vars, hostEnv);
    const settings = join(settingsDir, `${profileName}.json`);
    writeFileSync(settings, JSON.stringify(resolved.srt));
    const out = spawnSync(process.execPath, [runtime, "--settings", settings, "--", ...argv], {
      cwd: tree,
      env: resolved.env,
      stdio,
      encoding: "utf8",
    });
    return { out, srt: resolved.srt };
  };

  /**
   * true when the command ran to its end with status 0. The sandbox runtime
   * exits 0 when its command is ended by SIGINT or SIGTERM, so its status
   * alone does not say that: the command leaves a mark when it succeeds, at
   * a path only this process and the wrapper know. The path is the wrapper's
   * `$0`, not text of its script: no character of it is read by the shell.
   */
  const sandboxed = (argv, profileName) => {
    const mark = join(run, "tmp", `done-${randomBytes(16).toString("hex")}`);
    const { out } = start(profileName, [sh, "-c", '"$@" && : > "$0"', mark, ...argv], "inherit");
    const done = existsSync(mark);
    rmSync(mark, { force: true });
    return out.status === 0 && done;
  };

  /**
   * The proof that the sandbox holds, before anything is run in it: under
   * the profile, the canary tries each thing that must be refused. One
   * success and the gate refuses to run: there is no unsandboxed fallback.
   */
  const proveIsolation = async (profileName) => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "gate-canary-")));
    const server = createServer((socket) => socket.destroy());
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    let created = [];
    try {
      const srt = resolveProfile(loadProfile(profileName), vars, hostEnv).srt;
      const plan = canaryPlan(srt, {
        kindOf,
        keep: [root, common, LAUNCHER, home, outside],
        hostPort: server.address().port,
        mark: `gate-canary-${randomBytes(8).toString("hex")}`,
      });
      created = plan.created;
      const { out } = start(profileName, [process.execPath, join(HERE, "canary.mjs"), ...plan.args], ["ignore", "pipe", "pipe"]);
      const said = (out.stdout ?? "").trim();
      if (out.status !== 0 || said !== plan.expected) {
        throw new Refusal(
          `the sandbox does not hold under profile ${profileName}: ${said || (out.stderr ?? "").trim() || "the canary could not run"}`,
        );
      }
      const { writes, reads, port } = plan.proves;
      return `${writes} write(s) and ${reads} read(s) that must be refused were refused${port ? ", and the host's port was out of reach" : ""}`;
    } finally {
      server.close();
      for (const file of created) rmSync(file, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  };

  return { prepare, dispose, sandboxed, proveIsolation, tree };
}

// ─── The commands ───────────────────────────────────────────────────────────

const log = (line) => console.error(line);

/**
 * The gate that judges is the one of the main checkout, when it has one: the
 * pre-push hook accepts its verdicts only, and a worktree's own copy may be
 * the change that is judged. A worktree's gate hands the run over to it.
 */
function mainGate(common) {
  const main = resolve(common, "..");
  const path = join(main, "scripts", "gate", "gate.mjs");
  return main !== LAUNCHER && existsSync(path) ? path : null;
}

async function run() {
  const repo = repository(process.cwd());
  const { git, root } = repo;
  const other = mainGate(repo.common);
  if (other !== null) {
    log(`[gate] judged by the gate of the main checkout: ${other}`);
    return spawnSync(process.execPath, [other, "run"], { cwd: root, stdio: "inherit" }).status ?? 2;
  }
  const config = loadConfig();
  // The commit that is judged and the base it is compared with, read once:
  // the copy, the diff and the verdict are of these two, whatever is
  // committed or fetched while the gate runs.
  const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const base = git(["rev-parse", "--verify", `${config.base}^{commit}`]).trim();
  const made = makeRun(repo, config, commit);
  try {
    return await runGate(config, ports(config, repo, made, commit, base));
  } finally {
    made.dispose();
  }
}

function ports(config, { git, common }, { prepare, dispose, sandboxed, proveIsolation, tree }, commit, base) {
  // The change: the commits since the point where the work left the base.
  // `--text` and `--no-textconv`: an attribute of the tree cannot turn a
  // file's diff into "binary files differ". Names come NUL-separated, so git
  // quotes none of them.
  const diff = (...args) => git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--text", "--merge-base", base, commit, ...args]);
  return {
    log,
    headTree: () => git(["rev-parse", `${commit}^{tree}`]).trim(),
    status: () => git(["status", "--porcelain", "--untracked-files=all"]).trimEnd(),
    changedFiles: () => diff("--name-only", "--diff-filter=d", "-z").split("\0").filter((name) => name !== ""),
    fileDiff: (_, file) => diff("-U0", "--", file),
    prepare,
    dispose,
    proveIsolation,
    sandboxed,
    readSource: (file) => readFileSync(join(tree, file), "utf8"),
    removeReport: (path) => rmSync(join(tree, path), { force: true }),
    readReport: (path) => {
      try {
        return JSON.parse(readFileSync(join(tree, path), "utf8"));
      } catch {
        return null;
      }
    },
    recordVerdict: (hash, verdict) => writeFileSync(verdictPath(common, hash), JSON.stringify(verdict, null, 2)),
    gateHash: gateHash(),
    now: () => new Date().toISOString(),
    vars: { launcher: LAUNCHER },
  };
}

function runPrePush() {
  const { git, common } = repository(process.cwd());
  return prePush(readFileSync(0, "utf8"), {
    treeOf: (sha) => git(["rev-parse", `${sha}^{tree}`]).trim(),
    readVerdict: (tree) => readVerdict(common, tree),
    gateHash: gateHash(),
    log,
  });
}

const SHIM = [
  "#!/bin/sh",
  "# The delivery gate (scripts/gate): refuses a push of a commit whose tree has",
  "# no passed verdict. It runs the gate of the main checkout, whatever the",
  "# worktree the push is made from. Written by `pnpm gate:install`.",
  'exec node "$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/gate/gate.mjs" pre-push "$@"',
  "",
].join("\n");

/** null when git will run the gate's pre-push hook in this repository, else why not. */
function hookProblem({ git, common }) {
  let hooksPath = "";
  try {
    hooksPath = git(["config", "--get", "core.hooksPath"]).trim();
  } catch {
    // not set: git reads the hooks of the git directory
  }
  if (hooksPath !== "") return `core.hooksPath is set to ${hooksPath}`;
  const path = join(common, "hooks", "pre-push");
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return "no pre-push hook is installed";
  }
  if (content !== SHIM) return "another pre-push hook is installed";
  // git skips a hook it cannot execute, and says so only in a hint.
  if (process.platform !== "win32" && (statSync(path).mode & 0o111) === 0) return "the pre-push hook is not executable";
  return null;
}

function install() {
  const repo = repository(process.cwd());
  // The hook runs the gate of the main checkout: without one there, it
  // would refuse every push of the repository.
  const main = join(repo.common, "..", "scripts", "gate", "gate.mjs");
  if (!existsSync(main)) {
    throw new Refusal(`the main checkout has no gate yet (${resolve(main)}): install the hook once the gate is on its branch`);
  }
  const path = join(repo.common, "hooks", "pre-push");
  if (existsSync(path) && readFileSync(path, "utf8") !== SHIM) {
    throw new Refusal(`${path} is another hook: remove it or chain it by hand, the gate does not overwrite it`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, SHIM);
  chmodSync(path, 0o755);
  const problem = hookProblem(repo);
  if (problem !== null) throw new Refusal(`the pre-push hook is written, but git will not run it: ${problem}`);
  log(`[gate] pre-push hook installed: ${path}`);
  return 0;
}

/**
 * The PreToolUse hook. The session is this project's: a call made from a
 * directory that is in no repository is guarded like one made from the
 * project (a command can name the repository itself, `git -C`). A call made
 * from inside another repository is that repository's business. Once the
 * call is read, any failure blocks it.
 */
function runHook() {
  let call;
  try {
    call = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0; // not a hook payload: nothing to judge
  }
  const guard = loadConfig().guard;
  if (guardDecision(call, guard).kind === "allow") return 0;
  const project = repository(LAUNCHER);
  let here = project;
  try {
    here = repository(call.cwd ?? process.cwd());
  } catch {
    // in no repository: the project's rules apply
  }
  if (here.common !== project.common) return 0;
  return guardHook(call, guard, { hookProblem: () => hookProblem(here), log });
}

const COMMANDS = { run, "pre-push": runPrePush, hook: runHook, install, hash: () => (console.log(gateHash()), 0) };
// What a failure of the command itself exits with: a hook blocks on it.
const ON_ERROR = { run: 2, "pre-push": 1, hook: 2, install: 2, hash: 2 };

const mode = process.argv[2];
if (!Object.hasOwn(COMMANDS, mode)) {
  log("usage: gate.mjs run | pre-push | hook | install | hash");
  process.exitCode = 2;
} else {
  try {
    process.exitCode = await COMMANDS[mode]();
  } catch (error) {
    log(`[gate] refused: ${error.message}`);
    process.exitCode = ON_ERROR[mode];
  }
}
