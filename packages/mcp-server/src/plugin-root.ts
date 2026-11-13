/**
 * The directory the server reads its own files from: the skill
 * configuration, SKILL.md and, in a workspace run, the root package.json.
 *
 * It used to be three levels above the entry point whenever
 * CLAUDE_PLUGIN_ROOT was not set. That is the repository root from
 * `packages/mcp-server/dist/`, and two directories above it from
 * `mcp-server/`, where the bundle every packaged host launches lives: a host
 * that does not set the variable (the .mcpb, a bundle launched from a clone)
 * looked for the three files outside the package (#240).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// The deepest entry point the repository ships is
// packages/mcp-server/dist/index.js: its root is three levels above its
// directory. That is where the search ends, so a `packages/skill` further up
// the file system, which is not this package's, is never taken.
const DEEPEST_ENTRY_LEVELS = 3;

/**
 * precondition:  `runtimeDir` is the directory of the running entry point.
 * postcondition: `env.CLAUDE_PLUGIN_ROOT` when it is set; otherwise the
 *                nearest directory, among `runtimeDir` and the two above it,
 *                that holds `packages/skill`; otherwise the directory three
 *                levels above `runtimeDir`, as before, so that a layout with
 *                no `packages/skill` resolves to what it resolved to.
 */
export function resolvePluginRoot(
  runtimeDir: string,
  env: { readonly CLAUDE_PLUGIN_ROOT?: string },
  exists: (path: string) => boolean = existsSync,
): string {
  if (env.CLAUDE_PLUGIN_ROOT !== undefined) return env.CLAUDE_PLUGIN_ROOT;
  let dir = runtimeDir;
  for (let level = 0; level < DEEPEST_ENTRY_LEVELS; level++) {
    if (exists(join(dir, "packages", "skill"))) return dir;
    dir = dirname(dir);
  }
  return dir;
}
