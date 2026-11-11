#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOSTS = [
  {
    name: "codex",
    manifest: ".codex-plugin/plugin.json",
    resolve(server, portableRoot) {
      return {
        command: server.command,
        args: server.args,
        // Mirrors Codex's normalize_plugin_mcp_server_value: a relative cwd
        // is joined to the installed plugin root before the process starts.
        cwd: join(portableRoot, server.cwd),
      };
    },
  },
  {
    name: "gemini-cli",
    manifest: "gemini-extension.json",
    resolve(server, portableRoot) {
      return {
        command: server.command.replaceAll("${extensionPath}", portableRoot),
        args: server.args.map((arg) =>
          arg.replaceAll("${extensionPath}", portableRoot),
        ),
        cwd: portableRoot,
      };
    },
  },
];

const readJson = (relative) =>
  JSON.parse(readFileSync(join(ROOT, relative), "utf8"));

function responseById(stdout, id) {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.id === id) return parsed;
    } catch {
      // Server diagnostics belong on stderr; include non-JSON stdout in the
      // final transcript only if an expected response is missing.
    }
  }
  return null;
}

for (const host of HOSTS) {
  const manifest = readJson(host.manifest);
  const server = manifest.mcpServers["prd-spec-verifier"];
  assert.ok(server, `${host.name}: missing prd-spec-verifier declaration`);

  // This is the command the host consumes. Neither the launcher nor its
  // profile arguments are restated in this smoke test.
  const portableRoot = mkdtempSync(join(tmpdir(), `prd-verifier-install-${host.name}-`));
  mkdirSync(join(portableRoot, "mcp-server"));
  for (const file of ["index.js", "package.json"]) {
    cpSync(join(ROOT, "mcp-server", file), join(portableRoot, "mcp-server", file));
  }
  // Reproduce Codex's immutable installed-plugin cache. The verifier must
  // initialize without creating node_modules or writing anywhere below root.
  chmodSync(join(portableRoot, "mcp-server"), 0o555);
  chmodSync(portableRoot, 0o555);

  const { command, args, cwd } = host.resolve(server, portableRoot);
  const isolatedHome = mkdtempSync(join(tmpdir(), `prd-verifier-${host.name}-`));
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: host.name, version: "ci" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "validate_prd_section",
        arguments: {
          section_type: "overview",
          content: "# Overview\nA portable verifier smoke test.",
        },
      },
    },
  ];

  try {
    const run = spawnSync(command, args, {
      cwd,
      env: {
        ...process.env,
        HOME: isolatedHome,
        // os.homedir() reads USERPROFILE on Windows, not HOME.
        USERPROFILE: isolatedHome,
        PRD_GEN_SMOKE_HOST: host.name,
      },
      input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    assert.equal(run.error, undefined, `${host.name}: ${run.error?.message}`);
    assert.equal(
      run.status,
      0,
      `${host.name}: shipped command exited ${run.status}\n${run.stderr}\n${run.stdout}`,
    );

    const initialize = responseById(run.stdout, 1);
    assert.ok(initialize?.result?.serverInfo, `${host.name}: initialize failed\n${run.stdout}`);
    assert.equal(initialize.result.serverInfo.version, manifest.version);
    assert.match(initialize.result.instructions, /verifier/i);

    const list = responseById(run.stdout, 2);
    assert.deepEqual(
      list?.result?.tools?.map((tool) => tool.name).sort(),
      ["validate_prd_document", "validate_prd_section"],
      `${host.name}: verifier profile exposed the wrong tools`,
    );

    const call = responseById(run.stdout, 3);
    assert.equal(call?.error, undefined, `${host.name}: verifier call failed`);
    assert.equal(call?.result?.isError, undefined, `${host.name}: tool returned isError`);
    const report = JSON.parse(call.result.content[0].text);
    assert.equal(typeof report, "object", `${host.name}: verifier returned no report`);
    console.log(
      `PORTABLE HOST SMOKE OK: ${host.name}, ${initialize.result.serverInfo.version}, ` +
        `${list.result.tools.length} tools, validate_prd_section completed`,
    );
  } finally {
    chmodSync(join(portableRoot, "mcp-server"), 0o755);
    chmodSync(portableRoot, 0o755);
    rmSync(isolatedHome, { recursive: true, force: true });
    rmSync(portableRoot, { recursive: true, force: true });
  }
}
