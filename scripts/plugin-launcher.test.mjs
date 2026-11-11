// The Claude Code plugin launcher and the health check that drives it (#126).
//
// `.mcp.json` named `bash` as the launcher, so the plugin started on Windows
// only where a bash was on PATH. These tests run on every platform: the
// manifest names node and nothing a shell must interpret, the launcher hands
// the server its arguments and a clean stdout, provisions with `npm ci` in
// the server directory, and builds a Windows launch that needs no bash.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NPM_CI_ARGS, launchPlan, needsProvisioning, npmCiInvocation } from "../bin/ensure-deps.mjs";
import {
  holdsNativeBash,
  launchEnvironment,
  pathWithoutBash,
  serverCommand,
  verdict,
} from "./check-health-stdio.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(ROOT, "bin", "ensure-deps.mjs");
const manifest = () => JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8"));

const temporary = [];
test.afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A plugin root whose server prints what it was started with, then exits. */
function fakePlugin({ provisioned }) {
  const root = mkdtempSync(join(tmpdir(), "prd-launcher-"));
  temporary.push(root);
  const serverDir = join(root, "mcp-server");
  mkdirSync(serverDir);
  writeFileSync(join(serverDir, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    join(serverDir, "index.js"),
    'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), ' +
      'ajv: (await import("node:fs")).existsSync(new URL("./node_modules/ajv", import.meta.url)) }) + "\\n");\n',
  );
  if (provisioned) mkdirSync(join(serverDir, "node_modules", "ajv"), { recursive: true });
  return { root, serverDir };
}

/** A directory holding a fake `npm` that records its call and installs ajv. */
function fakeNpm() {
  const dir = mkdtempSync(join(tmpdir(), "prd-fake-npm-"));
  temporary.push(dir);
  const log = join(dir, "calls.jsonl");
  const script = join(dir, "npm-fake.cjs");
  writeFileSync(
    script,
    [
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");`,
      'console.log("npm output that must not reach the MCP channel");',
      'if (process.env.FAKE_NPM_FAIL) process.exit(7);',
      'fs.mkdirSync("node_modules/ajv", { recursive: true });',
      "",
    ].join("\n"),
  );
  // POSIX: a script named npm with a node shebang. Windows: npm.cmd, the form
  // npm itself is installed in.
  writeFileSync(join(dir, "npm"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(join(dir, "npm"), 0o755);
  writeFileSync(join(dir, "npm.cmd"), `@"${process.execPath}" "${script}" %*\r\n`);
  return { dir, log };
}

function launch(root, extraArgs = [], env = {}) {
  return spawnSync(process.execPath, [LAUNCHER, root, ...extraArgs], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, ...env },
  });
}

test(".mcp.json starts the plugin with node, and with nothing a shell must interpret", () => {
  const server = manifest().mcpServers["prd-gen"];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/bin/ensure-deps.mjs", "${CLAUDE_PLUGIN_ROOT}"]);
  const words = [server.command, ...server.args, ...Object.values(server.env ?? {})];
  for (const word of words) {
    assert.doesNotMatch(word, /\b(bash|sh|cmd|powershell|pwsh)\b/i, word);
    assert.doesNotMatch(word, /\.(sh|bat|cmd|ps1)$/i, word);
    // No shell syntax: the only `$` is the host's own ${CLAUDE_PLUGIN_ROOT}.
    assert.doesNotMatch(word.replaceAll("${CLAUDE_PLUGIN_ROOT}", ""), /[$`|&;<>*?~]/, word);
  }
  assert.ok(existsSync(LAUNCHER), "the launcher .mcp.json names exists");
  assert.equal(existsSync(join(ROOT, "bin", "ensure-deps.sh")), false, "no second, bash launcher");
});

test("the launcher hands the server its arguments and a stdout that carries only the server's output", () => {
  const { root, serverDir } = fakePlugin({ provisioned: true });
  const run = launch(root, ["--profile", "verifier"]);
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, run.stdout);
  const seen = JSON.parse(lines[0]);
  assert.deepEqual(seen.argv, [join(serverDir, "index.js"), "--profile", "verifier"]);
  assert.equal(run.stderr, "", "a provisioned launch says nothing");
});

test("a first launch runs `npm ci` in the server directory, keeps npm's output off stdout, then starts the server", () => {
  const { root, serverDir } = fakePlugin({ provisioned: false });
  const npm = fakeNpm();
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const run = launch(root, [], { [pathKey]: `${npm.dir}${delimiter}${process.env[pathKey]}` });
  assert.equal(run.status, 0, run.stderr);
  const calls = readFileSync(npm.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [...NPM_CI_ARGS]);
  assert.equal(
    calls[0].cwd.toLowerCase().replaceAll("\\", "/").endsWith("/mcp-server"),
    true,
    `npm ran in ${calls[0].cwd}, expected ${serverDir}`,
  );
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `stdout must hold the server's line only:\n${run.stdout}`);
  assert.equal(JSON.parse(lines[0]).ajv, true, "the server started after the install");
  assert.match(run.stderr, /first launch/);
  assert.match(run.stderr, /npm output that must not reach the MCP channel/);

  // Second launch: provisioned, npm is not called again.
  const again = launch(root, [], { [pathKey]: `${npm.dir}${delimiter}${process.env[pathKey]}` });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(npm.log, "utf8").trim().split("\n").length, 1);
});

test("a failed install stops the launch with npm's status and does not start the server", () => {
  const { root } = fakePlugin({ provisioned: false });
  const npm = fakeNpm();
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const run = launch(root, [], {
    [pathKey]: `${npm.dir}${delimiter}${process.env[pathKey]}`,
    FAKE_NPM_FAIL: "1",
  });
  assert.equal(run.status, 7);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /could not install the MCP server runtime deps/);
});

test("the launcher refuses to start without a plugin root", () => {
  const run = spawnSync(process.execPath, [LAUNCHER], { encoding: "utf8", input: "" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /usage: ensure-deps\.mjs <plugin-root>/);
});

test("npm ci is spawned through a shell on Windows only, with constant arguments and the directory as cwd", () => {
  const dir = win32.join("C:\\Users\\dev\\.claude\\plugins\\cache\\spec", "mcp-server");
  const windows = npmCiInvocation(dir, "win32");
  assert.equal(windows.options.shell, true, "npm is npm.cmd on Windows: node spawns it only through a shell");
  assert.equal(windows.options.cwd, dir);
  for (const platform of ["linux", "darwin"]) {
    assert.equal(npmCiInvocation("/plugin/mcp-server", platform).options.shell, false);
  }
  for (const invocation of [windows, npmCiInvocation("/plugin/mcp-server", "linux")]) {
    assert.equal(invocation.command, "npm");
    assert.deepEqual(invocation.args, ["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"]);
    // stdin is not npm's (it holds the host's requests); stdout goes to stderr.
    assert.deepEqual(invocation.options.stdio, ["ignore", 2, 2]);
  }
});

test("the launch plan forwards server arguments and keys provisioning on ajv", () => {
  const plan = launchPlan(["node", "ensure-deps.mjs", ROOT, "--profile", "verifier"]);
  assert.equal(plan.entry, join(ROOT, "mcp-server", "index.js"));
  assert.deepEqual(plan.serverArgv, ["node", plan.entry, "--profile", "verifier"]);
  assert.throws(() => launchPlan(["node", "ensure-deps.mjs"]), /usage/);
  const asked = [];
  assert.equal(needsProvisioning("X", (path) => (asked.push(path), false)), true);
  assert.equal(needsProvisioning("X", () => true), false);
  assert.deepEqual(asked, [join("X", "node_modules", "ajv")]);
});

test("the health check starts exactly what .mcp.json declares, with the plugin root substituted", () => {
  const root = win32.join("C:\\Users\\dev", "plugin");
  const { command, args, env } = serverCommand(manifest(), root);
  assert.equal(command, "node");
  assert.deepEqual(args, [`${root}/bin/ensure-deps.mjs`, root]);
  assert.equal(env.PRD_GEN_SKILL_CONFIG, `${root}/packages/skill/skill-config.json`);
  assert.throws(() => serverCommand({ mcpServers: {} }, root), /declares no prd-gen server/);
});

test("on Windows the health check starts the server with no bash on PATH", () => {
  const git = "C:\\Program Files\\Git\\bin";
  const usr = "C:\\Program Files\\Git\\usr\\bin";
  const node = "C:\\Program Files\\nodejs";
  const holdsBash = (dir) => dir === git || dir === usr;
  assert.equal(pathWithoutBash([git, node, "", usr, "C:\\Windows"].join(";"), ";", holdsBash), `${node};C:\\Windows`);

  const env = { Path: [usr, node, git].join(";"), USERPROFILE: "C:\\Users\\dev" };
  assert.deepEqual(launchEnvironment(env, "win32", holdsBash), { Path: node, USERPROFILE: "C:\\Users\\dev" });
  // The Windows directory stays: cmd and the system tools are there, and its
  // bash.exe is the WSL launcher, not a shell for a native program.
  const everywhere = () => true;
  assert.equal(holdsNativeBash("C:\\Windows\\System32", "C:\\Windows", everywhere), false);
  assert.equal(holdsNativeBash("c:/windows/system32/", "C:\\Windows", everywhere), false);
  assert.equal(holdsNativeBash("C:\\WindowsApps", "C:\\Windows", everywhere), true);
  assert.equal(holdsNativeBash(git, "C:\\Windows", everywhere), true);
  assert.equal(holdsNativeBash(node, "C:\\Windows", () => false), false);
  // Elsewhere the environment is passed as it is: sh is part of the system.
  assert.deepEqual(launchEnvironment({ PATH: "/usr/bin:/bin" }, "linux", () => true), { PATH: "/usr/bin:/bin" });
});

test("the health check passes only on an initialize answer and a check_health result", () => {
  const init = { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "prd-gen", version: "0.8.0" } } };
  const ok = { jsonrpc: "2.0", id: 2, result: { content: [] } };
  const out = (...messages) => messages.map((message) => JSON.stringify(message)).join("\r\n");
  assert.deepEqual(verdict(out(init, ok)), { ok: true, line: "check_health OK: prd-gen 0.8.0" });
  assert.match(verdict("").reason, /the server did not start/);
  assert.match(verdict(out(init)).reason, /no response to tools\/call check_health/);
  assert.match(verdict(out(init, { id: 2, error: { code: -1 } })).reason, /returned an error/);
  assert.match(verdict(out(init, { id: 2, result: { isError: true, content: [] } })).reason, /isError/);
  assert.match(verdict(out({ id: 1, error: { code: -1 } })).reason, /initialize returned an error/);
});
