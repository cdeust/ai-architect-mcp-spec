#!/usr/bin/env bash
# check-health-stdio.sh <plugin-root>: the environment test of ci.json.
# Starts the server as the Claude Code plugin does (.mcp.json: `bash
# bin/ensure-deps.sh <root>`, which provisions mcp-server/node_modules on
# first launch), speaks MCP over stdio and calls `check_health`. Passes only
# when initialize answers and the tool returns a result, not an error. Bare
# runner: bash, node and npm only. Mirrors scripts/release/smoke-mcpb.sh.
set -euo pipefail

ROOT="${1:?usage: check-health-stdio.sh <plugin-root>}"
ROOT="$(cd "${ROOT}" && pwd)"

RESPONSES="$(
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check-health-stdio","version":"0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check_health","arguments":{}}}' \
  | PRD_GEN_SKILL_CONFIG="${ROOT}/packages/skill/skill-config.json" \
    PRD_GEN_EVIDENCE_DB="${ROOT}/.prd-gen/evidence.db" \
    bash "${ROOT}/bin/ensure-deps.sh" "${ROOT}" || true
)"

node -e '
const lines = process.argv[1].split("\n").filter(Boolean);
let init = null, health = null;
for (const l of lines) { try { const j = JSON.parse(l);
  if (j.id === 1) init = j; if (j.id === 2) health = j; } catch {} }
const fail = (m) => { console.error("check_health FAIL: " + m); process.exit(1); };
if (!init) fail("no response to initialize: the server did not start");
if (init.error) fail("initialize returned an error: " + JSON.stringify(init.error));
if (!health) fail("no response to tools/call check_health");
if (health.error) fail("check_health returned an error: " + JSON.stringify(health.error));
if (health.result?.isError) fail("check_health reported isError: " + JSON.stringify(health.result.content));
console.log("check_health OK: " + init.result.serverInfo.name + " " + init.result.serverInfo.version);
' "${RESPONSES}"
