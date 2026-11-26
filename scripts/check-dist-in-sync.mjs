// Fails when the generated files a user runs differ from what the source builds.
//
// Run it right after `pnpm build && pnpm bundle`. The committed `dist/` of each
// package and the shipped `mcp-server/index.js` are generated files that are
// tracked in git; a pull request that changes a source file and does not commit
// the rebuild leaves them stale, and users execute the stale ones. After a build
// the working tree must equal the commit for those paths: any modified, deleted
// or new file there is the difference. #405 merged with a stale dist because the
// only comparison, in release.yml, runs at publication and ignores the bundle.
//
// Two forms, one verdict ("rebuilding changes nothing"):
//   node scripts/check-dist-in-sync.mjs            after a build, compare the tree with the commit by git (CI);
//   node scripts/check-dist-in-sync.mjs --rebuild  fingerprint the generated files, rebuild, compare (the delivery
//                                                  gate: it judges a copy of the committed tree that has no .git).
// `--rebuild -- <command> [args]` replaces the default `pnpm build` then `pnpm bundle`.
//
// The answer must not depend on who runs it or from where:
//   - it finds the repository from its own location, never from the directory it
//     is started in, and refuses to run unless that is the root of the repository;
//   - git runs with a closed environment (no global or system configuration, no
//     GIT_DIR / GIT_INDEX_FILE) and with every setting that changes what `status`
//     reports fixed on the command line, which also overrides the repository's own
//     configuration: untracked files shown, file modes compared, no line-ending
//     conversion, no quoting of paths, no file-system monitor or untracked cache;
//   - a generated file that git has been told not to look at (assume-unchanged,
//     skip-worktree, which is also what a sparse checkout sets) is itself a failure;
//   - finding no generated file at all is a failure, not a pass.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The bundle, the npm metadata `pnpm bundle` stamps beside it (scripts/stamp-bundle-version.mjs), and each package dist.
const BUNDLE_FILES = ["mcp-server/index.js", "mcp-server/package.json", "mcp-server/package-lock.json"];
export const GENERATED = [...BUNDLE_FILES, ":(glob)packages/*/dist/**"];
// source: heuristic provisional; `git status` on a few paths answers in well under a second.
const GIT_TIMEOUT_MS = 30_000;
// source: heuristic provisional, to be replaced by the duration measured in the PR that introduced `--rebuild`.
const BUILD_TIMEOUT_MS = 600_000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every setting that can change what `git status` reports, fixed here rather than read.
const SETTINGS = [
  "status.showUntrackedFiles=all",
  "core.fileMode=true",
  "core.autocrlf=false",
  "core.safecrlf=false",
  "core.quotePath=false",
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.ignoreStat=false",
].flatMap(setting => ["-c", setting]);

function closedEnvironment() {
  const keep = ["PATH", "SystemRoot", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP"];
  const env = Object.fromEntries(keep.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", LC_ALL: "C" };
}

function git(...args) {
  const run = spawnSync("git", [...SETTINGS, "-C", ROOT, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: closedEnvironment() });
  if (run.error || run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.error?.code ?? run.stderr.trim()}`);
  return run.stdout;
}

/** Whether two spellings reach one directory: links resolved, Windows short names (RUNNER~1) expanded, case ignored there. */
function sameDirectory(first, second) {
  const real = path => realpathSync.native(path);
  return process.platform === "win32" ? real(first).toLowerCase() === real(second).toLowerCase() : real(first) === real(second);
}

const entries = output => output.split("\0").filter(Boolean);

/** How many generated files were compared, and the problems found (none when they match the commit). */
function problems() {
  const top = git("rev-parse", "--show-toplevel").trim();
  if (!sameDirectory(top, ROOT)) return { compared: 0, found: [`${ROOT} is not the root of its git repository (${top})`] };

  // `ls-files -v` tags a file `H` when git looks at it; `h` is assume-unchanged, `S` and `s` skip-worktree.
  const tracked = entries(git("ls-files", "-v", "-z", "--", ...GENERATED));
  if (tracked.length === 0) return { compared: 0, found: ["no generated file to compare: the pathspecs matched nothing in this repository"] };
  const hidden = tracked.filter(line => line[0] !== "H").map(line => line.slice(2));
  if (hidden.length) return { compared: tracked.length, found: hidden.map(path => `${path} is hidden from git status (assume-unchanged, skip-worktree or sparse checkout)`) };

  return { compared: tracked.length, found: entries(git("status", "--porcelain", "-z", "--no-renames", "--untracked-files=all", "--", ...GENERATED)) };
}

// ─── The form for a tree without git ────────────────────────────────────────

function statIfPresent(path) {
  try {
    return lstatSync(join(ROOT, path));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

/** Enumerate generated paths independently of which packages had committed output. */
function generatedPaths() {
  const found = [];
  for (const path of BUNDLE_FILES) {
    if (statIfPresent(path)) found.push(path);
  }
  const walk = directory => {
    for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else found.push(path);
    }
  };
  if (statIfPresent("packages")?.isDirectory()) {
    for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
      const dist = `packages/${entry.name}/dist`;
      if (entry.isDirectory() && statIfPresent(dist)?.isDirectory()) walk(dist);
    }
  }
  return found;
}

/** Compare the bytes and the Git-relevant file kind and executable bit, not timestamps or other permissions. */
function fingerprint(path) {
  const absolute = join(ROOT, path);
  const stat = lstatSync(absolute);
  if (!stat.isSymbolicLink() && !stat.isFile()) {
    throw new Error(`Generated artifact is not a regular file or link: ${path}`);
  }
  const regularKind = (stat.mode & 0o100) === 0 ? "file" : "executable";
  const kind = stat.isSymbolicLink() ? "link" : regularKind;
  const bytes = kind === "link" ? readlinkSync(absolute, { encoding: "buffer" }) : readFileSync(absolute);
  return `${kind}:${createHash("sha256").update(bytes).digest("hex")}`;
}

const fingerprints = paths => new Map(paths.map(path => [path, fingerprint(path)]));

/**
 * Which of `paths` the `.gitignore` files of the tree at ROOT ignore. A build also writes files git
 * ignores into a committed `dist` (its `__tests__`, say); they are not part of the commit. A tree with
 * no `.git` is asked through a throwaway empty repository whose work tree is ROOT.
 */
function ignored(paths) {
  if (paths.length === 0) return new Set();
  const gitDir = mkdtempSync(join(tmpdir(), "dist-in-sync-git-"));
  try {
    const env = closedEnvironment();
    const init = spawnSync("git", ["init", "--bare", "-q", gitDir], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env });
    if (init.error || init.status !== 0) throw new Error(`git init failed: ${init.error?.code ?? init.stderr.trim()}`);
    const ask = spawnSync("git", ["--git-dir", gitDir, "--work-tree", ROOT, "check-ignore", "--no-index", "-z", "--stdin"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env, input: paths.join("\0") });
    if (ask.error || ask.status > 1) throw new Error(`git check-ignore failed: ${ask.error?.code ?? ask.stderr.trim()}`);
    return new Set(entries(ask.stdout));
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
}

/** Run the build, then say how many generated files were compared and which differ: `M`odified, `A`dded or `D`eleted. */
function rebuildProblems(commands) {
  const before = fingerprints(generatedPaths());
  if (before.size === 0) return { compared: 0, found: ["no generated file to compare: the tree has no bundle and no dist"] };
  for (const [program, ...args] of commands) {
    const run = spawnSync(program, args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], timeout: BUILD_TIMEOUT_MS });
    if (run.error || run.status !== 0) return { compared: before.size, found: [`${[program, ...args].join(" ")} failed (${run.error?.code ?? `status ${run.status}`}): the generated files cannot be compared`] };
  }
  const paths = generatedPaths();
  const hidden = ignored(paths.filter(path => !before.has(path)));
  const after = fingerprints(paths.filter(path => !hidden.has(path)));
  const lines = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (!after.has(path)) lines.push(`D ${path}`);
    else if (!before.has(path)) lines.push(`A ${path}`);
    else if (before.get(path) !== after.get(path)) lines.push(`M ${path}`);
  }
  return { compared: before.size, found: lines };
}

// There is no "was I run directly?" test on purpose. The one that was here compared two spellings of the path
// of this file (macOS reaches its temporary directory through a link, Windows through short names), decided
// it had been imported and ended with exit 0 without checking anything. The script runs whenever it is loaded,
// and every run says how many generated files it compared: a run that compared none cannot succeed.
const args = process.argv.slice(2);
const rebuild = args[0] === "--rebuild";
const custom = args.indexOf("--");
const commands = rebuild && custom >= 0 ? [args.slice(custom + 1)] : [["pnpm", "build"], ["pnpm", "bundle"]];
const { compared, found } = rebuild ? rebuildProblems(commands) : problems();
if (found.length || compared === 0) {
  console.error(`The committed build output is out of date with the source (${found.length} problem(s), ${compared} generated file(s) compared):`);
  for (const line of found) console.error(`  ${line}`);
  console.error("Run 'pnpm build && pnpm bundle' and commit the result.");
  process.exit(1);
}
console.log(`Compared ${compared} generated file(s): the committed dist and bundle match the build of the source.`);
