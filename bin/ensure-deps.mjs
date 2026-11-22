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
 * The launcher reuses completed legacy installs. On a new install it snapshots
 * the committed bundle and npm manifests, installs in a private directory,
 * then publishes the complete runtime by rename. Concurrent launches share
 * that runtime only when its inputs and native ABI match. See provision-runtime.mjs.
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
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { isEntry } from "./is-entry.mjs";
import { provisionRuntime } from "./provision-runtime.mjs";

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
  const { serverDir, serverArgv } = launchPlan(argv);
  const runtime = provisionRuntime(serverDir, (stage) => {
    process.stderr.write("prd-gen: first launch — installing MCP server runtime deps…\n");
    const { command, args, options } = npmCiInvocation(stage);
    const run = spawn(command, args, options);
    if (run.error || run.status !== 0) {
      const why = run.error?.message ?? `npm ci exited with status ${run.status}`;
      throw Object.assign(new Error(`could not install the MCP server runtime deps in ${stage}: ${why}`),
        { exitCode: run.status || 1 });
    }
  });
  process.argv = serverArgv;
  await import(pathToFileURL(join(runtime, "index.js")).href);
}

if (isEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`prd-gen: ${error?.stack ?? error}\n`);
    process.exitCode = error?.exitCode ?? 1;
  });
}
