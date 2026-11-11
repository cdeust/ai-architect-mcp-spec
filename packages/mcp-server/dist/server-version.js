/**
 * The release version advertised to MCP hosts in `initialize`
 * (`serverInfo.version`).
 *
 * This used to be a literal in index.ts. It said `0.4.0` while package.json,
 * .claude-plugin/plugin.json, manifest.json and server.json all said `0.6.1`,
 * so every host that connected — and the MCP registry entry built from the
 * same handshake — read a version three releases stale. Nothing caught it:
 * the .mcpb smoke test printed `serverInfo.version` in its OK line without
 * asserting it, and no test pinned the literal.
 *
 * The number is therefore no longer written down twice. It is read at startup
 * from the nearest package.json that ships with the running artifact, so it
 * cannot be edited out of sync with the thing it describes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * Advertised when no candidate manifest can be read. Deliberately not a
 * plausible-looking number: `initialize` must still succeed (a host that
 * cannot handshake gets no server at all), but a version that is silently
 * wrong is worse than one that is visibly unresolved — the first is a false
 * claim a reader acts on, the second is a bug report.
 */
export const UNRESOLVED_VERSION = "0.0.0-unresolved";
/**
 * Reads `version` from a JSON file. Returns null — rather than throwing — for
 * the one named failure mode this has: the candidate does not exist in this
 * distribution shape (the .mcpb carries no root package.json; a workspace run
 * has nothing beside dist/index.js). A malformed or version-less file is the
 * same answer, and the caller falls through to the next candidate.
 */
function readVersion(manifestPath) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    }
    catch {
        return null;
    }
    const version = parsed.version;
    return typeof version === "string" && version.length > 0 ? version : null;
}
/**
 * Resolves the version to advertise, in the order the shipped layouts put it.
 *
 * @param runtimeDir directory holding the running entry point (`__dirname`).
 *   In both shipped shapes — the plugin install and the staged .mcpb — that
 *   is `mcp-server/`, whose package.json is stamped with the release version
 *   by `pnpm bundle` and is what `bin/ensure-deps.mjs` installs from.
 * @param pluginRoot the plugin/repo root. Covers the workspace run, where the
 *   entry point is `packages/mcp-server/dist/index.js` with no package.json
 *   beside it and the root package.json is the source of truth.
 * @returns the first version found, or {@link UNRESOLVED_VERSION}.
 */
export function resolveServerVersion(runtimeDir, pluginRoot) {
    const candidates = [join(runtimeDir, "package.json"), join(pluginRoot, "package.json")];
    for (const candidate of candidates) {
        const version = readVersion(candidate);
        if (version !== null) {
            return version;
        }
    }
    return UNRESOLVED_VERSION;
}
//# sourceMappingURL=server-version.js.map