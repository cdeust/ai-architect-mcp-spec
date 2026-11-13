#!/usr/bin/env bash
#
# smoke-mcpb.sh — stage the .mcpb and START it, exactly as a host would.
#
# The regression this pins: for the whole life of the .mcpb channel, the bundle
# was assembled at release time and never launched. manifest.json declares
#     server.mcp_config = { command: "node", args: ["${__dirname}/mcp-server/index.js"] }
# and running that against the staged tree failed with `Cannot find module
# 'ajv'`, because the tree carried no node_modules and nothing invoked
# bin/ensure-deps.mjs. A green test suite said nothing about it: the suite
# exercises the workspace sources, never the distributable.
#
# So this speaks MCP over stdio to the staged artifact and asserts the two
# things a host does first. Anything less — "the file exists", "the bundle is
# 2.7 MB" — would have passed while the server was unstartable.
#
# The version assertion below pins a second regression of the same shape: this
# script printed `serverInfo.version` in its OK line and asserted only that a
# serverInfo existed, so the server advertised a hardcoded 0.4.0 for three
# releases while the manifest shipped 0.6.1, in CI, in green. A number nobody
# compares is a number nobody maintains.
#
# The health assertion pins a third one (#124): the audit of the v0.8.0 .mcpb
# read `check_health` on it and found two components false under a status
# "ok". The status now follows the components; what this script adds is that
# the archive is in the state its description announces. The .mcpb ships the
# server and its configuration, not SKILL.md (stage-mcpb.sh copies only
# skill-config.json) and not better-sqlite3 (stage-mcpb.sh: --omit=optional,
# a native addon built on the release runner would be wrong for most
# platforms). So `check_health` on it answers `degraded` with exactly
# skillAvailable and evidenceDbHealthy false. One component more or one fewer
# fails here: an archive that lost its configuration, or one that started to
# ship a component its description says it does not carry.
#
# Exit 0 iff: initialize returns a serverInfo whose version is the one
# manifest.json declares, tools/list returns the expected tool count, AND
# check_health names exactly the expected components as degraded.
# Exit 1 with the transcript otherwise.
set -euo pipefail

EXPECTED_TOOLS="${EXPECTED_TOOLS:-17}"
# The components the .mcpb does not carry, space-separated (see above).
EXPECTED_DEGRADED="${EXPECTED_DEGRADED:-skillAvailable evidenceDbHealthy}"
STAGE_ROOT="$(mktemp -d)"
# Git Bash: mktemp answers an MSYS path (/tmp/…) that node, a native program,
# cannot open when it reaches it inside an argument or a variable MSYS does
# not rewrite. cygpath -m gives the same directory as C:/…; it exists only
# there. source: Cortex pipeline.yml, step "Scratch directory and OS name".
if command -v cygpath >/dev/null 2>&1; then STAGE_ROOT="$(cygpath -m "${STAGE_ROOT}")"; fi
STAGE_DIR="${STAGE_ROOT}/ai-architect-mcp-spec-mcpb"
trap 'rm -rf "${STAGE_ROOT}"' EXIT

bash scripts/release/stage-mcpb.sh "${STAGE_DIR}"

# The command under test is read FROM manifest.json rather than hardcoded, so a
# manifest that starts pointing somewhere else fails here instead of shipping.
# Args come through as an ARRAY: they are a JSON list, and flattening them to a
# string would either lose an argument containing a space or word-split one that
# should stay whole.
COMMAND="$(node -e 'console.log(require("./manifest.json").server.mcp_config.command)')"
ARGS=()
while IFS= read -r arg; do
  ARGS+=("${arg//\$\{__dirname\}/${STAGE_DIR}}")
done < <(node -e 'for (const a of require("./manifest.json").server.mcp_config.args) console.log(a)')
# The environment is read from manifest.json too (review of #238): a host
# sets what `server.mcp_config.env` declares, and nothing else. ENV_VARS
# holds NAME=value pairs. With a bundle built before #240, a manifest that
# loses PRD_GEN_SKILL_CONFIG fails here (configAvailable false); since #240
# the server finds the configuration from its own root, and such a manifest
# passes: the variable is an override, no longer the only way.
ENV_VARS=()
while IFS= read -r pair; do
  ENV_VARS+=("${pair//\$\{__dirname\}/${STAGE_DIR}}")
done < <(node -e 'for (const [name, value] of Object.entries(require("./manifest.json").server.mcp_config.env ?? {})) console.log(`${name}=${value}`)')
echo "launching: ${COMMAND} ${ARGS[*]} (environment: ${ENV_VARS[*]-})" >&2

RESPONSES="$(
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-mcpb","version":"0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"check_health","arguments":{}}}' \
  | env -u CLAUDE_PLUGIN_ROOT -u PRD_GEN_SKILL_CONFIG \
    ${ENV_VARS[@]+"${ENV_VARS[@]}"} \
    "${COMMAND}" "${ARGS[@]}" 2>"${STAGE_ROOT}/stderr.log" || true
)"
# CLAUDE_PLUGIN_ROOT is removed from the server's environment: a .mcpb host
# does not set it, and a shell that has it (a Claude Code session) would make
# the server read the SKILL.md of the plugin it points at. PRD_GEN_SKILL_CONFIG
# is removed for the same reason, then set from the manifest when the manifest
# declares it: a value inherited from the shell must not stand in for it.
# ${ENV_VARS[@]+…}: bash 3.2 (macOS) treats an empty array as unset under -u.

# Read from manifest.json, like COMMAND above: the version a host is told at
# handshake has to be the version the artifact declares, and neither number is
# written here, so this compares two independent mirrors of the release rather
# than a constant against itself.
EXPECTED_VERSION="$(node -e 'console.log(require("./manifest.json").version)')"

# shellcheck disable=SC2016  # the node program is deliberately single-quoted:
# every $ inside it belongs to JavaScript, and the three values it needs arrive
# via the EXPECTED_TOOLS / EXPECTED_VERSION env vars and argv, not via shell
# interpolation.
EXPECTED_TOOLS="${EXPECTED_TOOLS}" EXPECTED_VERSION="${EXPECTED_VERSION}" \
EXPECTED_DEGRADED="${EXPECTED_DEGRADED}" node -e '
const expected = Number(process.env.EXPECTED_TOOLS);
const expectedVersion = process.env.EXPECTED_VERSION;
const expectedDegraded = process.env.EXPECTED_DEGRADED.split(" ").filter(Boolean).sort();
const lines = process.argv[1].split("\n").filter(Boolean);
let init = null, tools = null, health = null;
for (const l of lines) { try { const j = JSON.parse(l);
  if (j.id === 1) init = j; if (j.id === 2) tools = j; if (j.id === 3) health = j; } catch {} }

const fail = (m) => { console.error("SMOKE FAIL: " + m); process.exit(1); };
if (!init) fail("no response to initialize — the server did not start");
if (init.error) fail("initialize returned an error: " + JSON.stringify(init.error));
if (!init.result?.serverInfo?.name) fail("initialize returned no serverInfo");
const advertised = init.result.serverInfo.version;
if (advertised !== expectedVersion)
  fail(`serverInfo.version is ${advertised}, manifest.json declares ${expectedVersion}`);
if (!tools) fail("no response to tools/list");
if (tools.error) fail("tools/list returned an error: " + JSON.stringify(tools.error));
const n = (tools.result?.tools || []).length;
if (n !== expected) fail(`tools/list returned ${n} tools, expected ${expected}`);
if (!health) fail("no response to check_health");
if (health.error || health.result?.isError) fail("check_health returned an error: " + JSON.stringify(health.error ?? health.result));
let report;
try { report = JSON.parse(health.result.content[0].text); } catch { fail("check_health did not answer JSON: " + JSON.stringify(health.result)); }
const degraded = [...(report.degraded ?? [])].sort();
if (JSON.stringify(degraded) !== JSON.stringify(expectedDegraded))
  fail(`check_health names [${degraded.join(", ")}] as degraded, the .mcpb is expected to lack exactly [${expectedDegraded.join(", ")}]`);
const expectedStatus = expectedDegraded.length === 0 ? "ok" : "degraded";
if (report.status !== expectedStatus) fail(`check_health status is ${report.status}, expected ${expectedStatus}`);
console.log(`SMOKE OK: ${init.result.serverInfo.name} ${init.result.serverInfo.version}, ${n} tools, health ${report.status} (${degraded.join(", ")})`);
' "${RESPONSES}" || {
  echo "--- server stderr ---" >&2
  head -20 "${STAGE_ROOT}/stderr.log" >&2
  exit 1
}
