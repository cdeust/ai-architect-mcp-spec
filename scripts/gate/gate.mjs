#!/usr/bin/env node
/**
 * The delivery gate, as a program: the adapters of gate-lib.mjs (git, the
 * sandbox runtime, files) and the commands that use them. The decisions are
 * in gate-lib.mjs; nothing is decided here.
 *
 *   gate.mjs run        judge the work in the current directory (pnpm gate)
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
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Refusal, canaryPlan, guardHook, prePush, resolveProfile, runGate, validateConfig } from "./gate-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this gate belongs to: its files judge, they are not judged. */
const LAUNCHER = resolve(HERE, "..", "..");
const GATE_FILES = ["delivery-gate.json", "stryker.config.json", "scripts/gate/gate.mjs", "scripts/gate/gate-lib.mjs", "scripts/gate/canary.mjs"];
const PROFILES = join(HERE, "profiles");

const inside = (path, root) => path === root || path.startsWith(root + sep);

/**
 * git, by its absolute path, found on PATH outside the tree that is judged:
 * a check may write `node_modules/.bin`, which package managers put first on
 * PATH, and what it leaves there must never be run outside the sandbox.
 */
function findGit(judgedRoots) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "" || judgedRoots.some((root) => inside(resolve(dir), root))) continue;
    for (const name of process.platform === "win32" ? ["git.exe"] : ["git"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  throw new Refusal("git is not on PATH outside the tree that is judged");
}

function makeGit(gitPath, cwd) {
  return (...args) => {
    const out = spawnSync(gitPath, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (out.status !== 0) throw new Refusal(`git ${args.join(" ")}: ${(out.stderr ?? "").trim() || out.error?.message}`);
    return out.stdout;
  };
}

/** The repository the current directory is in, read without trusting its tree. */
function repository(cwd) {
  // The roots are not known before git answers: the first call excludes the
  // current directory and the launcher, which is enough to find them.
  const git = makeGit(findGit([resolve(cwd), LAUNCHER]), cwd);
  const root = realpathSync(git("rev-parse", "--show-toplevel").trim());
  const common = realpathSync(git("rev-parse", "--path-format=absolute", "--git-common-dir").trim());
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

// ─── The sandbox ────────────────────────────────────────────────────────────

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
 * One sandbox per operation: a temporary directory of its own, the profile
 * resolved for it, the sandbox runtime around the command. The operation
 * gets the environment of the profile and nothing else of the host.
 */
function makeSandbox({ root, common }) {
  const runtime = sandboxRuntime();
  const loadProfile = (name) => {
    try {
      return JSON.parse(readFileSync(join(PROFILES, `${name}.json`), "utf8"));
    } catch (error) {
      throw new Refusal(`profile ${name} cannot be read (${error.message})`);
    }
  };
  // What an operation may read of the user's home: the tools PATH names there.
  const home = realpathSync(homedir());
  const toolchain = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "" && existsSync(dir))
    .map((dir) => realpathSync(dir))
    .filter((dir) => inside(dir, home) && !inside(dir, root));

  const within = (profileName, use) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gate-sb-")));
    try {
      const tmp = join(dir, "tmp");
      mkdirSync(join(tmp, "home"), { recursive: true });
      const vars = { home, worktree: root, repository: common, launcher: LAUNCHER, tmp, toolchain };
      const resolved = resolveProfile(loadProfile(profileName), vars, process.env);
      const settings = join(dir, "srt.json");
      writeFileSync(settings, JSON.stringify(resolved.srt));
      const start = (argv, stdio) =>
        spawnSync(process.execPath, [runtime, "--settings", settings, "--", ...argv], {
          cwd: root,
          env: resolved.env,
          stdio,
          encoding: "utf8",
        });
      return use(resolved, start);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const sandboxed = (argv, profileName) => within(profileName, (_, start) => start(argv, "inherit").status);

  /**
   * The proof that the sandbox holds, before anything is run in it: under
   * the profile, the canary tries each thing the profile denies. One success
   * and the gate refuses to run: there is no unsandboxed fallback.
   */
  const proveIsolation = async (profileName) => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "gate-canary-")));
    const server = createServer((socket) => socket.destroy());
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    let plan = { created: [] };
    try {
      return within(profileName, (resolved, start) => {
        plan = canaryPlan(resolved.srt, { kindOf, outside, hostPort: server.address().port });
        const out = start([process.execPath, join(HERE, "canary.mjs"), ...plan.args], ["ignore", "pipe", "pipe"]);
        if (out.status !== 0) {
          throw new Refusal(
            `the sandbox does not hold under profile ${profileName}: ${(out.stdout ?? "").trim() || (out.stderr ?? "").trim() || "the canary could not run"}`,
          );
        }
        const { writes, reads, port } = plan.proves;
        return `${writes} write(s) and ${reads} read(s) the profile denies were refused${port ? ", and the host's port was out of reach" : ""}`;
      });
    } finally {
      server.close();
      for (const file of plan.created) rmSync(file, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  };

  return { sandboxed, proveIsolation };
}

// ─── The commands ───────────────────────────────────────────────────────────

const log = (line) => console.error(line);

async function run() {
  const config = loadConfig();
  const repo = repository(process.cwd());
  const { git, root, common } = repo;
  const { sandboxed, proveIsolation } = makeSandbox(repo);
  // The change: against the point where the work left `base`, uncommitted
  // changes included. Names come NUL-separated, so git quotes none of them.
  const diff = (...args) => git("diff", "--no-color", "--no-ext-diff", "--merge-base", config.base, ...args);
  return runGate(config, {
    log,
    headTree: () => git("rev-parse", "HEAD^{tree}").trim(),
    status: () => git("status", "--porcelain").trim(),
    changedFiles: () => diff("--name-only", "--diff-filter=d", "-z").split("\0").filter((name) => name !== ""),
    fileDiff: (_, file) => diff("-U0", "--", file),
    proveIsolation,
    sandboxed,
    removeReport: (path) => rmSync(join(root, path), { force: true }),
    readReport: (path) => {
      try {
        return JSON.parse(readFileSync(join(root, path), "utf8"));
      } catch {
        return null;
      }
    },
    recordVerdict: (tree, verdict) => {
      mkdirSync(join(common, "delivery-gate"), { recursive: true });
      writeFileSync(verdictPath(common, tree), JSON.stringify(verdict, null, 2));
    },
    gateHash: gateHash(),
    now: () => new Date().toISOString(),
    vars: { launcher: LAUNCHER },
  });
}

function runPrePush() {
  const { git, common } = repository(process.cwd());
  return prePush(readFileSync(0, "utf8"), {
    treeOf: (sha) => git("rev-parse", `${sha}^{tree}`).trim(),
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
    hooksPath = git("config", "--get", "core.hooksPath").trim();
  } catch {
    // not set: git reads the hooks of the git directory
  }
  if (hooksPath !== "") return `core.hooksPath is set to ${hooksPath}`;
  try {
    return readFileSync(join(common, "hooks", "pre-push"), "utf8") === SHIM ? null : "another pre-push hook is installed";
  } catch {
    return "no pre-push hook is installed";
  }
}

function install() {
  const repo = repository(process.cwd());
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

/** The PreToolUse hook. Once the call is read, any failure blocks it. */
function runHook() {
  let call;
  try {
    call = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0; // not a hook payload: nothing to judge
  }
  let repo;
  try {
    repo = repository(call.cwd ?? process.cwd());
  } catch {
    return 0; // not in a git repository: nothing of this project can leave from here
  }
  // Another repository than the one of this gate: not this gate's to guard.
  if (repo.common !== repository(LAUNCHER).common) return 0;
  return guardHook(call, loadConfig().guard, { hookProblem: () => hookProblem(repo), log });
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
