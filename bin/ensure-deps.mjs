#!/usr/bin/env node
/**
 * ensure-deps.mjs — provision the MCP server bundle's externalised runtime
 * dependencies on first launch, then start the server in this process.
 *
 * The committed bundle (mcp-server/index.js) is produced by `pnpm bundle`
 * (esbuild). Three runtime dependencies are intentionally *external* to that
 * bundle and must resolve from node_modules at launch:
 *
 *   - ajv, ajv-formats — ajv's runtime-compiled validators `require()` their
 *     helpers (ajv/dist/runtime/*) via specifiers esbuild cannot statically
 *     inline, so ajv must exist on disk. Static require => needed at load.
 *   - better-sqlite3   — native addon; the platform-specific binary cannot be
 *     bundled or committed cross-platform. Loaded via dynamic import() and
 *     guarded by tryCreateEvidenceRepository => OPTIONAL: its absence only
 *     disables the evidence-DB cache, it does not block startup. Declared as
 *     an optionalDependency so a failed native build is non-fatal.
 *
 * `claude plugin install` clones repository files but runs no install step, so
 * this launcher provisions `mcp-server/node_modules` next to the bundle on the
 * first run, then loads the server. Idempotent: it no-ops once the deps are
 * installed, so steady-state launch cost is two small file reads.
 *
 * WHAT "INSTALLED" MEANS
 * A completed `npm ci` is recorded by a marker inside node_modules that holds
 * the SHA-256 of the lockfile it installed. Provisioning runs when the marker
 * is missing or names another lockfile. The first version tested only that
 * `node_modules/ajv` existed, so an `npm ci` interrupted after ajv and before
 * ajv-formats was taken for a finished install and never repaired, and an
 * updated lockfile was never installed. `npm ci` deletes node_modules before
 * it installs, marker included, so an interrupted run leaves no marker.
 *
 * Two launches at once (two sessions opening the same installed plugin) are
 * serialized by an exclusive lock file beside node_modules: the second waits
 * for the first, then finds the marker and installs nothing. A lock whose
 * owner process no longer exists is taken over.
 *
 * WHY NODE AND NOT BASH (#126)
 * The launcher was `bash bin/ensure-deps.sh`. `.mcp.json` declared `bash` as
 * the command, so the plugin started on Windows only where a bash was on
 * `PATH` (Git Bash in CI), while `manifest.json` declares win32. The plugin
 * already requires node (it is what runs the server), so the launcher is a
 * node script: one command on the three platforms, nothing else to install.
 * Cortex's plugin launches the same way, through its own runtime
 * (`python3 scripts/launcher.py`, Cortex .claude-plugin/plugin.json).
 *
 * source: coding-standards.md §2.2 (composition-root provisioning); follow-up
 * to the MCP-startup-deadlock fix (PR #2); cdeust/ai-architect-mcp-spec#126.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { isEntry } from "./is-entry.mjs";

/**
 * `npm ci` against the COMMITTED mcp-server/package-lock.json, not
 * `npm install`. This step runs on the user's machine at first launch, so
 * `npm install` re-resolved the tree there: whatever `^8.17.1` meant on that
 * day is what shipped, with no integrity check. `npm ci` installs the exact
 * locked tree and verifies every `integrity` hash in the lockfile.
 *
 * The lockfile is committed for the same reason the bundle is: `claude plugin
 * install` clones repository files and runs no install step, so anything not
 * in the repo does not exist at launch.
 *
 * source: Scorecard PinnedDependenciesID (issue #36).
 */
export const NPM_CI_ARGS = Object.freeze([
  "ci",
  "--omit=dev",
  "--no-audit",
  "--no-fund",
  "--loglevel=error",
]);

/** Written inside node_modules, so `npm ci` removes it before it installs. */
export const MARKER_NAME = ".prd-gen-deps-installed";
/** Beside node_modules, not inside: `npm ci` deletes node_modules. */
export const LOCK_NAME = ".prd-gen-deps.lock";

/**
 * How often a waiting launcher looks at the lock again. It is the sleep of a
 * poll, not a deadline: the wait ends when the owner releases the lock or
 * stops existing, never because a number of milliseconds has passed.
 */
const LOCK_POLL_MS = 100;

/**
 * precondition:  `serverDir` is `<plugin-root>/mcp-server`.
 * postcondition: the SHA-256, in hex, of its package-lock.json; null when
 *                the file cannot be read (npm ci then reports it).
 */
export function lockfileDigest(serverDir) {
  try {
    return createHash("sha256").update(readFileSync(join(serverDir, "package-lock.json"))).digest("hex");
  } catch {
    return null;
  }
}

/**
 * precondition:  `serverDir` is `<plugin-root>/mcp-server`.
 * postcondition: true iff no completed install of the current lockfile is
 *                recorded: the marker is missing, unreadable, or holds
 *                another digest than `lockfileDigest(serverDir)`.
 */
export function needsProvisioning(serverDir) {
  const digest = lockfileDigest(serverDir);
  if (digest === null) return true;
  try {
    return readFileSync(join(serverDir, "node_modules", MARKER_NAME), "utf8").trim() !== digest;
  } catch {
    return true;
  }
}

/** Records the install `needsProvisioning` then recognises. */
function markProvisioned(serverDir) {
  const digest = lockfileDigest(serverDir);
  if (digest !== null) writeFileSync(join(serverDir, "node_modules", MARKER_NAME), `${digest}\n`);
}

/**
 * precondition:  `pid` is a process id read from a lock file.
 * postcondition: false iff no such process exists. Signal 0 delivers
 *                nothing and only tests for existence; EPERM means the
 *                process exists and belongs to someone else.
 */
export function processExists(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Removes an abandoned lock, unless it changed since it was read: another
 * waiting launcher may have removed it and taken the lock in the meantime.
 * The check and the removal are two calls, so two launchers can still, in
 * the instant between them, both end up installing; `npm ci` then fails in
 * one of them, that launch stops with npm's message, no marker is written,
 * and the next launch installs again.
 */
function removeIfUnchanged(path, seen) {
  try {
    if (readFileSync(path, "utf8") === seen) rmSync(path, { force: true });
  } catch {
    // already gone
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * precondition:  `serverDir` exists.
 * postcondition: this process owns `<serverDir>/.prd-gen-deps.lock`, which
 *                holds its pid; the returned function releases it. While
 *                another live process owns the lock this call waits; a lock
 *                whose owner no longer exists, or whose content is not a
 *                pid, is removed and taken (a launcher killed during
 *                `npm ci` must not block every later launch).
 */
export function acquireLock(serverDir, { exists = processExists, wait = sleep } = {}) {
  const path = join(serverDir, LOCK_NAME);
  let announced = false;
  for (;;) {
    try {
      // "wx": create, fail if it exists. The creation is the atomic step.
      const fd = openSync(path, "wx");
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let seen;
    try {
      seen = readFileSync(path, "utf8");
    } catch {
      // Released between the two calls, or (Windows) still open in the
      // process that is creating it: look again after a poll.
      wait(LOCK_POLL_MS);
      continue;
    }
    const owner = Number.parseInt(seen, 10);
    if (!exists(owner)) {
      // No such process, or no pid in the file yet. An owner writes its pid
      // right after creating the file, so an empty file gets one more poll
      // before it is judged abandoned.
      if (seen.trim() === "") wait(LOCK_POLL_MS);
      removeIfUnchanged(path, seen);
      continue;
    }
    if (!announced) {
      process.stderr.write(`prd-gen: another launch (pid ${owner}) is installing the runtime deps; waiting…\n`);
      announced = true;
    }
    wait(LOCK_POLL_MS);
  }
}

/**
 * precondition:  `platform` is a `process.platform` value.
 * postcondition: how to run `npm ci` in `serverDir` on that platform.
 *
 * On Windows npm is `npm.cmd`, and node refuses to spawn a `.cmd` file
 * without a shell (EINVAL since the fix for CVE-2024-27980, Node 20.12.2 /
 * 18.20.2, nodejs.org "Windows command injection" 2024-04-10). The shell is
 * safe here: the command and every argument are the constants above, none
 * comes from the caller, and the directory goes through `cwd`, not the
 * command line.
 *
 * npm runs from the package directory instead of `npm --prefix`: npm 11
 * interprets an out-of-tree prefix as a local package reference and rejects
 * the otherwise-valid lock as missing `mcp-server@<version>`.
 *
 * stdout of the child goes to this process's stderr: stdout is the MCP
 * channel, and one line of npm output on it corrupts the JSON-RPC stream.
 * stdin is not given to npm for the same reason: it holds the host's
 * requests.
 */
export function npmCiInvocation(serverDir, platform = process.platform) {
  return {
    command: "npm",
    args: [...NPM_CI_ARGS],
    options: {
      cwd: serverDir,
      stdio: ["ignore", 2, 2],
      shell: platform === "win32",
    },
  };
}

/**
 * precondition:  `argv` is `process.argv` of a launcher process:
 *                [node, this file, <plugin-root>, ...server-args].
 * postcondition: the server directory, the server entry and the
 *                `process.argv` the server must see: [node, entry,
 *                ...server-args], so a host manifest can select a profile
 *                (`--profile verifier`) and a launch with no extra argument
 *                keeps the default `full` surface. Throws when the root is
 *                missing.
 */
export function launchPlan(argv) {
  const root = argv[2];
  if (!root) throw new Error("usage: ensure-deps.mjs <plugin-root> [server-args...]");
  const serverDir = join(resolve(root), "mcp-server");
  const entry = join(serverDir, "index.js");
  return { serverDir, entry, serverArgv: [argv[0], entry, ...argv.slice(3)] };
}

/**
 * precondition:  as `launchPlan`.
 * postcondition: the dependencies are installed (or the process has exited
 *                with npm's status and a message on stderr), and the server
 *                module is loaded in this process: its stdio is the host's,
 *                with no child process and no pipe in between.
 */
export async function main(argv = process.argv, spawn = spawnSync) {
  const { serverDir, entry, serverArgv } = launchPlan(argv);
  if (needsProvisioning(serverDir)) provision(serverDir, spawn);
  process.argv = serverArgv;
  // A file URL, not a path: `import("C:\\…")` is not a valid specifier on
  // Windows (ERR_UNSUPPORTED_ESM_URL_SCHEME).
  await import(pathToFileURL(entry).href);
}

/**
 * precondition:  `needsProvisioning(serverDir)` held when the caller looked.
 * postcondition: under the lock, either another launch has completed the
 *                install in the meantime (nothing is run), or `npm ci` ran
 *                here and the marker records it. On failure the process
 *                exits with npm's status, a message on stderr, the lock
 *                released and no marker.
 */
function provision(serverDir, spawn) {
  const release = acquireLock(serverDir);
  try {
    if (!needsProvisioning(serverDir)) return;
    process.stderr.write("prd-gen: first launch — installing MCP server runtime deps…\n");
    const { command, args, options } = npmCiInvocation(serverDir);
    const run = spawn(command, args, options);
    if (run.error || run.status !== 0) {
      const why = run.error ? run.error.message : `npm ci exited with status ${run.status}`;
      process.stderr.write(
        `prd-gen: could not install the MCP server runtime deps in ${serverDir}: ${why}\n`,
      );
      release();
      process.exit(run.status || 1);
    }
    markProvisioned(serverDir);
  } finally {
    release();
  }
}

if (isEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`prd-gen: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
