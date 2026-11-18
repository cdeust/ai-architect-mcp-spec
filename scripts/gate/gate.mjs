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
 * The gate that judges is the one of the base revision, as git has it, not
 * a file of a checkout: `run` takes the gate's files out of that revision
 * and hands the run over to them, and the pre-push hook, which lives in the
 * git directory where no commit reaches, does the same before it reads a
 * verdict, and accepts the verdicts of that gate only. The hook names the
 * revision it was installed with, a branch of a remote, and refuses the push
 * where that revision has no gate: it never reads a gate from a checkout.
 * So, once the hook is installed, a commit that changes the gate, wherever
 * it is made, is judged by the gate it replaces: a verdict its own gate
 * wrote is refused at the push. While the base has no gate, `run` lets the
 * gate of the checkout judge (there is none to judge the first one), and
 * the hook cannot be installed. Each gate reads its configuration, its
 * profiles and its canary from beside its own file (the launcher).
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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
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
      // The file that would run, links followed: a link from a directory
      // outside into the judged tree is the judged tree.
      let real;
      try {
        real = realpathSync(join(dir, name));
      } catch {
        continue;
      }
      if (statSync(real).isFile() && !outside.some((root) => inside(real, root))) return real;
    }
  }
  throw new Refusal(`${program} is not on PATH outside the tree that is judged`);
}

// source: provisional heuristic. What git prints here is a diff, a list of
// names or the blobs of one commit; the largest, the blobs of this
// repository, is under 16 MiB. 256 MiB leaves room, and is a bound, not a
// tuned value: beyond it the gate refuses instead of reading on.
const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;

function makeGit(gitPath, cwd) {
  const start = (args, options) => {
    const out = spawnSync(gitPath, args, { cwd, maxBuffer: GIT_OUTPUT_LIMIT, ...options, env: { ...process.env, ...options.env } });
    if (out.status !== 0) throw new Refusal(`git ${args.join(" ")}: ${String(out.stderr ?? "").trim() || out.error?.message}`);
    return out.stdout;
  };
  const git = (args, env = {}) => start(args, { encoding: "utf8", env });
  /** The same, as bytes: what git stores, with nothing decoded. */
  git.bytes = (args, input) => start(args, { input, env: {} });
  git.path = gitPath;
  return git;
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
  // A gate taken out of a revision has no installed packages: the gate that
  // handed the run over says where the runtime is.
  const pkgDir = process.env.GATE_RUNTIME ?? join(LAUNCHER, "node_modules", "@anthropic-ai", "sandbox-runtime");
  let bin;
  let needs;
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    bin = pkg.bin.srt;
    // The Node the runtime needs is the one its own package declares.
    needs = /^>=(\d+)\.(\d+)/.exec(pkg.engines?.node ?? "");
  } catch {
    throw new Refusal("the sandbox runtime is not installed in the gate's checkout (pnpm install)");
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (needs && (major < Number(needs[1]) || (major === Number(needs[1]) && minor < Number(needs[2])))) {
    throw new Refusal(`the sandbox runtime needs Node ${needs[1]}.${needs[2]} or later (this is ${process.versions.node})`);
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
  const realDir = (dir) => {
    try {
      return realpathSync(dir);
    } catch {
      return resolve(dir);
    }
  };
  const path = safePath(process.env.PATH ?? "", delimiter, {
    isAbsolute,
    // Links followed: a directory outside that leads into one of them is one of them.
    inside: (dir) => written.some((place) => inside(realDir(dir), place)),
  });
  const hostEnv = { ...process.env, PATH: path };
  // What an operation may read of the user's home: the directories PATH
  // names there, the installation of node, and the real directory of each
  // program a check starts (a link in a PATH directory leads elsewhere).
  const programs = [...new Set([...config.checks, config.mutation].map((operation) => operation.command[0]))];
  const toolchain = [
    ...new Set([
      ...path.split(delimiter).filter((dir) => dir !== "" && existsSync(dir)).map(realDir),
      // node itself, and the packages installed beside it (corepack, a global pnpm).
      dirname(realpathSync(process.execPath)),
      resolve(dirname(realpathSync(process.execPath)), "..", "lib", "node_modules"),
      ...programs.flatMap((program) => {
        try {
          return [dirname(findOnPath(program, written))];
        } catch {
          return []; // not found here: the check will say so when it starts
        }
      }),
    ]),
  ].filter((dir) => inside(dir, home));
  const vars = { home, run, launcher: LAUNCHER, toolchain };

  /**
   * The tree of the commit, then the installed dependencies of the worktree.
   * Each file is the blob git stores, written as it is: no checkout, so no
   * filter of the machine (a smudge filter, git-lfs) runs on what the commit
   * names, outside the sandbox, before anything is proved.
   */
  const prepare = () => {
    for (const dir of ["tmp", "home", "tree"]) mkdirSync(join(run, dir));
    const entries = git(["ls-tree", "-r", "-z", "--full-tree", commit])
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry))
      .filter((entry) => entry !== null && entry[2] === "blob"); // a submodule has no blob here
    // One git for all the blobs: "<sha> blob <size>\n<bytes>\n" for each, in order.
    const blobs = git.bytes(["cat-file", "--batch"], entries.map((entry) => entry[3]).join("\n") + "\n");
    let at = 0;
    const links = [];
    for (const [, mode, , sha, path] of entries) {
      const headerEnd = blobs.indexOf(0x0a, at);
      const header = blobs.subarray(at, headerEnd).toString("utf8").split(" ");
      if (header[0] !== sha || header[1] !== "blob") throw new Refusal(`git cat-file: unexpected answer for ${path}`);
      const size = Number(header[2]);
      const content = blobs.subarray(headerEnd + 1, headerEnd + 1 + size);
      at = headerEnd + 1 + size + 1;
      const target = join(tree, path);
      if (mode === "120000") {
        links.push([target, content.toString("utf8")]);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      // `wx`: a path a file already took (two names that differ by case, on a disk that does not tell them apart) is refused.
      writeFileSync(target, content, { mode: mode === "100755" ? 0o755 : 0o644, flag: "wx" });
    }
    // The links last: no file is ever written through a link of the commit.
    // Nor a link, nor a directory, through another link: on a disk that does
    // not tell `A` from `a`, a link `A` and a link `a/b/x` would make `b`,
    // then `x`, where `A` leads. Each directory on the way is looked at
    // before it is used, and made one level at a time: nothing is created
    // under a link.
    for (const [target, to] of links) {
      let at = tree;
      for (const part of dirname(target).slice(tree.length).split(sep).filter((name) => name !== "")) {
        at = join(at, part);
        const found = lstatSync(at, { throwIfNoEntry: false });
        if (found === undefined) mkdirSync(at);
        else if (!found.isDirectory()) {
          throw new Refusal(`${target.slice(tree.length + 1)} would be written through ${at.slice(tree.length + 1)}, which is not a directory of the copy`);
        }
      }
      symlinkSync(to, target);
    }
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

  /**
   * A path of the copy, for this process to read or remove: links followed,
   * it must still be in the copy. A check can leave a link there that leads
   * outside, or put a link in place of the copy itself, and this process is
   * not in the sandbox. The copy is `tree` as it was made, a real path: it
   * is not resolved again, so a link in its place is outside it.
   */
  const inCopy = (path) => {
    const wanted = join(tree, path);
    let real;
    try {
      real = realpathSync(wanted);
    } catch {
      // Not there (yet): its directory decides.
      try {
        real = join(realpathSync(dirname(wanted)), basename(wanted));
      } catch {
        real = wanted;
      }
    }
    if (!inside(real, tree)) throw new Refusal(`${path} leads outside the copy of the tree (${real})`);
    return real;
  };

  return { prepare, dispose, sandboxed, proveIsolation, inCopy };
}

// ─── The commands ───────────────────────────────────────────────────────────

const log = (line) => console.error(line);

const GATE_PATHS = ["scripts/gate", "delivery-gate.json", "stryker.config.json"];

/**
 * The gate of a revision, written out of git into a directory of its own,
 * or null when the revision has none. Nothing of a working tree is read.
 */
function gateAt(git, ref) {
  try {
    git(["cat-file", "-e", `${ref}:scripts/gate/gate.mjs`]);
  } catch {
    return null;
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gate-judge-")));
  const files = git(["ls-tree", "-r", "--name-only", "-z", ref, "--", ...GATE_PATHS]).split("\0").filter((name) => name !== "");
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), git(["show", `${ref}:${file}`]));
  }
  return dir;
}

async function run() {
  const repo = repository(process.cwd());
  const { git, root, common } = repo;
  const config = loadConfig();
  // The gate that judges is the one of the base revision. This one, which
  // may be the change that is judged, only finds it and hands the run over.
  if (process.env.GATE_JUDGE !== "1") {
    const judge = gateAt(git, config.base);
    if (judge !== null) {
      // The runtime of the main checkout when it is installed there, else this one's.
      const installed = [join(common, ".."), LAUNCHER]
        .map((checkout) => join(checkout, "node_modules", "@anthropic-ai", "sandbox-runtime"))
        .find((dir) => existsSync(join(dir, "package.json")));
      try {
        log(`[gate] judged by the gate of ${config.base}`);
        const env = { ...process.env, GATE_JUDGE: "1", ...(installed ? { GATE_RUNTIME: installed } : {}) };
        return spawnSync(process.execPath, [join(judge, "scripts", "gate", "gate.mjs"), "run"], { cwd: root, stdio: "inherit", env }).status ?? 2;
      } finally {
        rmSync(judge, { recursive: true, force: true });
      }
    }
    log(`[gate] ${config.base} has no gate yet: this one judges`);
  }
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

function ports(config, { git, common }, { prepare, dispose, sandboxed, proveIsolation, inCopy }, commit, base) {
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
    readSource: (file) => readFileSync(inCopy(file), "utf8"),
    removeReport: (path) => rmSync(inCopy(path), { force: true }),
    readReport: (path) => {
      const real = inCopy(path);
      try {
        return JSON.parse(readFileSync(real, "utf8"));
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

const SHIM_MARK = "# Written by `pnpm gate:install`.";

/**
 * The pre-push hook, as text. It lives in the git directory, where no
 * commit and no sandboxed operation reaches, and it runs the gate of `ref`
 * taken out of git: a commit cannot bring the gate that reads its verdict.
 * node and git are named by their paths, and PATH is set: a push started
 * from a package script has the installed packages first on its PATH.
 */
const shim = (ref, nodePath, gitPath) =>
  [
    "#!/bin/sh",
    "# The delivery gate (scripts/gate): refuses a push whose tip has a tree with",
    "# no passed verdict. The gate that reads the verdict is the one of the",
    "# revision below, as git has it, never a file of a checkout: where that",
    "# revision has no gate, the push is refused.",
    SHIM_MARK,
    `ref='${ref}'`,
    `node='${nodePath}'`,
    `git='${gitPath}'`,
    'PATH="$(dirname "$git"):/usr/bin:/bin"',
    "export PATH",
    'if ! "$git" cat-file -e "$ref:scripts/gate/gate.mjs" 2>/dev/null; then',
    '  echo "[gate] push refused: $ref has no delivery gate in this repository (not fetched, pruned, or another remote). Fetch it, or install the hook again (pnpm gate:install)." >&2',
    "  exit 1",
    "fi",
    // In TMPDIR when it is set: without a template, mktemp of macOS ignores it.
    'dir=$(mktemp -d "${TMPDIR:-/tmp}/gate-hook.XXXXXX") || exit 1',
    "trap 'rm -rf \"$dir\"' EXIT",
    // The same bytes `run` takes: each blob as git stores it, no conversion of line ends.
    `for f in $("$git" ls-tree -r --name-only "$ref" -- ${GATE_PATHS.join(" ")}); do`,
    '  mkdir -p "$dir/$(dirname "$f")" && "$git" show "$ref:$f" > "$dir/$f" || exit 1',
    "done",
    '[ -f "$dir/scripts/gate/gate.mjs" ] || exit 1',
    '"$node" "$dir/scripts/gate/gate.mjs" pre-push "$@"',
    "",
  ].join("\n");

/** A path the hook can hold between single quotes. */
function quotable(path, what) {
  if (path.includes("'")) throw new Refusal(`the path of ${what} (${path}) cannot be written in the pre-push hook`);
  return path;
}

/**
 * The revision the hook takes the gate from: the base of the configuration,
 * by its full name, and only a branch of a remote. A commit does not move a
 * remote-tracking branch, and `HEAD` or a local branch would name the commit
 * that is pushed.
 */
function hookRef(git, config) {
  let full = "";
  try {
    full = git(["rev-parse", "--verify", "--symbolic-full-name", config.base]).trim();
  } catch {
    // does not resolve here
  }
  if (!/^refs\/remotes\/[\w./-]+$/.test(full)) {
    throw new Refusal(`delivery-gate.json: base (${config.base}) is not a branch of a remote in this repository: the pre-push hook takes the gate from one`);
  }
  return full;
}

/**
 * null when git will run the gate's pre-push hook in this repository, else
 * why not. The hook is the gate's when it is the text `shim` writes for this
 * revision, with a node and a git that are still there.
 */
function hookProblem({ git, common }, ref) {
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
  const [before, between, after] = shim(ref, "\0", "\0").split("\0");
  const named =
    content.startsWith(before) && content.endsWith(after) ? content.slice(before.length, content.length - after.length).split(between) : [];
  if (named.length !== 2) return content.includes(SHIM_MARK) ? "the pre-push hook is out of date" : "another pre-push hook is installed";
  if (!named.every((program) => kindOf(program) === "file")) return "the pre-push hook names a node or a git that is gone";
  // git skips a hook it cannot execute, and says so only in a hint.
  if (process.platform !== "win32" && (statSync(path).mode & 0o111) === 0) return "the pre-push hook is not executable";
  return null;
}

function install() {
  const repo = repository(process.cwd());
  const ref = hookRef(repo.git, loadConfig());
  // The hook runs the gate of `ref` and nothing else: where `ref` has none,
  // it would refuse every push of the repository.
  try {
    repo.git(["cat-file", "-e", `${ref}:scripts/gate/gate.mjs`]);
  } catch {
    throw new Refusal(`${ref} has no gate yet: install the hook once the gate is on it`);
  }
  const path = join(repo.common, "hooks", "pre-push");
  const text = shim(ref, quotable(realpathSync(process.execPath), "node"), quotable(repo.git.path, "git"));
  mkdirSync(dirname(path), { recursive: true });
  try {
    // Created only if no file is there: no moment between a look and the write.
    writeFileSync(path, text, { flag: "wx", mode: 0o755 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // One the gate wrote is written again (another revision, a node that moved); any other is left.
    if (!readFileSync(path, "utf8").includes(SHIM_MARK)) {
      throw new Refusal(`${path} is another hook: remove it or chain it by hand, the gate does not overwrite it`);
    }
    writeFileSync(path, text, { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  const problem = hookProblem(repo, ref);
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
  const config = loadConfig();
  const guard = config.guard;
  if (guardDecision(call, guard).kind === "allow") return 0;
  const project = repository(LAUNCHER);
  let here = project;
  try {
    here = repository(call.cwd ?? process.cwd());
  } catch {
    // in no repository: the project's rules apply
  }
  if (here.common !== project.common) return 0;
  return guardHook(call, guard, { hookProblem: () => hookProblem(here, hookRef(here.git, config)), env: process.env, log });
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
