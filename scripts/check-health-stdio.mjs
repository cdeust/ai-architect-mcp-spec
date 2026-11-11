#!/usr/bin/env node
/**
 * check-health-stdio.mjs <plugin-root>: the environment test of ci.json, and
 * the last step of its install test.
 *
 * Starts the server with the command `<plugin-root>/.mcp.json` declares, as
 * Claude Code does for the plugin (the launcher provisions
 * mcp-server/node_modules on first launch), speaks MCP over stdio and calls
 * `check_health`. Passes only when initialize answers and the tool returns a
 * result, not an error. Bare runner: node and npm only.
 *
 * The command is read from the manifest, not restated here, so a manifest
 * that names a program the host does not have fails this check.
 *
 * On Windows the server is started with every directory that holds a bash
 * removed from PATH: `.mcp.json` named `bash` as the launcher until #126, and
 * the CI's own shell is Git Bash, so a launcher that needed a bash would pass
 * there unnoticed. Cortex makes the same check on its Windows leg
 * (scripts/ci_windows_bash.ps1, Cortex issue #689).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** First launch runs `npm ci`; a cold runner needs the network for it. */
const LAUNCH_TIMEOUT_MS = 600_000;

const REQUESTS = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "check-health-stdio", version: "0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_health", arguments: {} } },
];

/**
 * precondition:  `manifest` is a parsed `.mcp.json`; `root` is the plugin
 *                root Claude Code substitutes for `${CLAUDE_PLUGIN_ROOT}`.
 * postcondition: the command, arguments and environment of its `prd-gen`
 *                server with every `${CLAUDE_PLUGIN_ROOT}` replaced by
 *                `root`. Throws when the server is not declared.
 */
export function serverCommand(manifest, root) {
  const server = manifest?.mcpServers?.["prd-gen"];
  if (!server) throw new Error(".mcp.json declares no prd-gen server");
  const expand = (value) => String(value).replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
  return {
    command: expand(server.command),
    args: (server.args ?? []).map(expand),
    env: Object.fromEntries(Object.entries(server.env ?? {}).map(([k, v]) => [k, expand(v)])),
  };
}

/**
 * precondition:  `pathValue` is a PATH string split by `separator`;
 *                `holdsBash(dir)` says whether a directory holds a bash.
 * postcondition: `pathValue` without its empty entries and without every
 *                directory that holds a bash, order kept.
 */
export function pathWithoutBash(pathValue, separator, holdsBash) {
  return pathValue
    .split(separator)
    .filter((dir) => dir && !holdsBash(dir))
    .join(separator);
}

/**
 * precondition:  `dir` is a PATH entry on Windows; `systemRoot` is
 *                %SystemRoot% (C:\\Windows), or undefined.
 * postcondition: true iff `dir` holds a bash that is a real shell. The
 *                Windows directory is kept on PATH: cmd and the system tools
 *                npm needs live there, and the `bash.exe` it may hold is the
 *                WSL launcher, which is not a shell for a native program
 *                (Cortex ADR-1101 refuses it for the same reason).
 */
export function holdsNativeBash(dir, systemRoot, exists = existsSync) {
  const normal = (path) => path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  if (systemRoot && (normal(dir) + "\\").startsWith(normal(systemRoot) + "\\")) return false;
  return ["bash.exe", "sh.exe"].some((name) => exists(join(dir, name)));
}

const holdsBashExe = (dir) => holdsNativeBash(dir, process.env.SystemRoot ?? process.env.SYSTEMROOT);

/**
 * precondition:  `env` is the environment of this process.
 * postcondition: the environment the server is started with: on Windows,
 *                `env` with a PATH that holds no bash (the variable is
 *                `Path` there, matched in any case); elsewhere `env`.
 */
export function launchEnvironment(env, platform = process.platform, holdsBash = holdsBashExe) {
  if (platform !== "win32") return { ...env };
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = key.toUpperCase() === "PATH" ? pathWithoutBash(value, ";", holdsBash) : value;
  }
  return out;
}

/**
 * precondition:  `stdout` is what the server wrote on stdout.
 * postcondition: `{ ok: true, line }` when initialize answered and
 *                check_health returned a result that is not an error;
 *                `{ ok: false, reason }` otherwise.
 */
export function verdict(stdout) {
  let init = null;
  let health = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (message.id === 1) init = message;
      if (message.id === 2) health = message;
    } catch {
      // Not a JSON-RPC line; the reason below reports a missing response.
    }
  }
  const fail = (reason) => ({ ok: false, reason });
  if (!init) return fail("no response to initialize: the server did not start");
  if (init.error) return fail(`initialize returned an error: ${JSON.stringify(init.error)}`);
  if (!health) return fail("no response to tools/call check_health");
  if (health.error) return fail(`check_health returned an error: ${JSON.stringify(health.error)}`);
  if (health.result?.isError) {
    return fail(`check_health reported isError: ${JSON.stringify(health.result.content)}`);
  }
  const { name, version } = init.result?.serverInfo ?? {};
  return { ok: true, line: `check_health OK: ${name} ${version}` };
}

function main(argv) {
  if (!argv[2]) {
    console.error("usage: check-health-stdio.mjs <plugin-root>");
    return 2;
  }
  const root = resolve(argv[2]);
  const manifest = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  const { command, args, env } = serverCommand(manifest, root);
  const launchEnv = { ...launchEnvironment(process.env), ...env };
  if (process.platform === "win32") {
    const pathKey = Object.keys(launchEnv).find((key) => key.toUpperCase() === "PATH");
    const left = (launchEnv[pathKey] ?? "").split(delimiter).filter(holdsBashExe);
    if (left.length > 0) {
      console.error(`check_health FAIL: the no-bash PATH still holds a bash: ${left.join(delimiter)}`);
      return 1;
    }
    console.error("check-health-stdio: starting the server with no bash on PATH");
  }
  console.error(`check-health-stdio: ${command} ${args.join(" ")}`);
  const run = spawnSync(command, args, {
    env: launchEnv,
    input: `${REQUESTS.map((request) => JSON.stringify(request)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: LAUNCH_TIMEOUT_MS,
  });
  if (run.error) {
    console.error(`check_health FAIL: could not run ${command}: ${run.error.message}`);
    return 1;
  }
  const result = verdict(run.stdout ?? "");
  if (!result.ok) {
    console.error(`check_health FAIL: ${result.reason}`);
    console.error(`--- server exit status: ${run.status}`);
    console.error(`--- server stderr ---\n${(run.stderr ?? "").slice(0, 4_000)}`);
    return 1;
  }
  console.log(result.line);
  return 0;
}

function isEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) process.exit(main(process.argv));
