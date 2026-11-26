// Fails when the generated files a user runs differ from what the source builds.
//
// Run it right after `pnpm build && pnpm bundle`. The committed `dist/` of each
// package and the shipped `mcp-server/index.js` are generated files that are
// tracked in git; a pull request that changes a source file and does not commit
// the rebuild leaves them stale, and users execute the stale ones. After a build
// the working tree must equal the commit for those paths: any modified, deleted
// or new file there is the difference. #405 merged with a stale dist because the
// only comparison, in release.yml, runs at publication and ignores the bundle.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// The bundle, the npm metadata `pnpm bundle` stamps beside it (scripts/stamp-bundle-version.mjs), and each package dist.
export const GENERATED = ["mcp-server/index.js", "mcp-server/package.json", "mcp-server/package-lock.json", ":(glob)packages/*/dist/**"];
// source: heuristic provisional; `git status` on two paths answers in well under a second.
const GIT_TIMEOUT_MS = 30_000;

export function staleFiles(cwd) {
  const status = spawnSync("git", ["status", "--porcelain", "--", ...GENERATED], { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (status.error || status.status !== 0) throw new Error(`git status failed: ${status.error?.code ?? status.stderr}`);
  return status.stdout.split("\n").filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stale = staleFiles(process.cwd());
  if (stale.length) {
    console.error(`The committed build output is out of date with the source (${stale.length} path(s)):`);
    for (const line of stale) console.error(`  ${line}`);
    console.error("Run 'pnpm build && pnpm bundle' and commit the result.");
    process.exit(1);
  }
  console.log("The committed dist and bundle match the build of the source.");
}
