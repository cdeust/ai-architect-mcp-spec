#!/usr/bin/env bash
#
# stage-mcpb.sh — assemble the exact directory tree that becomes the .mcpb.
#
# This exists as a script, rather than inline YAML in release.yml, so that CI
# can stage and LAUNCH the artifact on every push. That was the gap: the .mcpb
# was assembled only during a tag release and never started, so
# `node mcp-server/index.js` — the command manifest.json actually declares —
# died on `Cannot find module 'ajv'` and nothing caught it. Staging logic
# duplicated between a release workflow and a test drifts; one script cannot.
#
# Precondition: run from the repo root, after `pnpm bundle`, with
# mcp-server/package-lock.json committed and in sync with mcp-server/package.json.
# Postcondition: "${1}" holds a tree that runs as-is under the command in
# manifest.json (server.mcp_config), with runtime deps already present.
#
# Why the deps are provisioned HERE and not on the user's machine:
#   - manifest.json launches `node ${__dirname}/mcp-server/index.js` directly.
#     A .mcpb host runs that command; it does not run an install step, and it
#     has no reason to know about bin/ensure-deps.mjs.
#   - Resolving and integrity-checking dependencies in CI is strictly better
#     than doing it on each user's machine at first launch (Scorecard
#     PinnedDependenciesID, issue #36): it happens once, under a lockfile,
#     where a failure is visible to us instead of to them.
#   - `--omit=optional` deliberately excludes better-sqlite3. It is a native
#     addon, so a copy built on the release runner would be wrong for most
#     users' platforms. Its absence is an already-declared degradation: the
#     evidence-DB cache is disabled and consensus falls back to the Beta(7,3)
#     prior, which the server announces on stderr at startup.
#
# bin/ensure-deps.mjs is NOT staged. It provisions the PLUGIN install path
# (.mcp.json, a git clone with no node_modules) and has no caller inside the
# .mcpb now that the deps ship with it; copying it in would be dead weight (§9).
set -euo pipefail

STAGE_DIR="${1:?usage: stage-mcpb.sh <stage-dir>}"

mkdir -p "${STAGE_DIR}/mcp-server"
mkdir -p "${STAGE_DIR}/packages/skill"

# Core runtime files
cp manifest.json "${STAGE_DIR}/"
cp icon.png "${STAGE_DIR}/" 2>/dev/null || true
cp README.md "${STAGE_DIR}/"
cp LICENSE "${STAGE_DIR}/"
cp PRIVACY.md "${STAGE_DIR}/"

# Bundled server + the manifest npm needs to provision against
cp mcp-server/index.js "${STAGE_DIR}/mcp-server/"
cp mcp-server/package.json "${STAGE_DIR}/mcp-server/"
cp mcp-server/package-lock.json "${STAGE_DIR}/mcp-server/"

# Skill config (required at runtime — PRD_GEN_SKILL_CONFIG)
cp packages/skill/skill-config.json "${STAGE_DIR}/packages/skill/"

# Runtime deps, resolved from the committed lockfile with integrity verified.
# Run inside the staged package instead of using npm's --prefix flag. npm 11.12
# misidentifies the root package when --prefix points inside macOS's TMPDIR,
# even though the same package.json/package-lock.json pair passes from its cwd.
(
  cd "${STAGE_DIR}/mcp-server"
  npm ci --omit=dev --omit=optional --no-audit --no-fund --loglevel=error
) >&2

echo "Staged contents:" >&2
find "${STAGE_DIR}" -type f -not -path '*/node_modules/*' | sort >&2
echo "node_modules: $(find "${STAGE_DIR}/mcp-server/node_modules" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ') packages" >&2
