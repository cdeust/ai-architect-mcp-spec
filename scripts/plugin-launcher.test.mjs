// The Claude Code plugin launcher and the health check that drives it (#126).
//
// `.mcp.json` named `bash` as the launcher, so the plugin started on Windows
// only where a bash was on PATH. These tests run on every platform: the
// manifest names node and nothing a shell must interpret, the launcher hands
// the server its arguments and a clean stdout, provisions with `npm ci` in
// the server directory, and builds a Windows launch that needs no bash.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LOCK_NAME,
  MARKER_NAME,
  NPM_CI_ARGS,
  acquireLock,
  launchPlan,
  lockfileDigest,
  needsProvisioning,
  npmCiInvocation,
  processExists,
} from "../bin/ensure-deps.mjs";
import { isEntry } from "../bin/is-entry.mjs";
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
  writeFileSync(join(serverDir, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  writeFileSync(
    join(serverDir, "index.js"),
    'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), ' +
      'ajv: (await import("node:fs")).existsSync(new URL("./node_modules/ajv", import.meta.url)) }) + "\\n");\n',
  );
  if (provisioned) {
    mkdirSync(join(serverDir, "node_modules", "ajv"), { recursive: true });
    writeFileSync(join(serverDir, "node_modules", MARKER_NAME), `${lockfileDigest(serverDir)}\n`);
  }
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
      // As `npm ci` does: the previous tree goes first, then the install.
      'fs.rmSync("node_modules", { recursive: true, force: true });',
      'if (process.env.FAKE_NPM_FAIL) process.exit(7);',
      'const ms = Number(process.env.FAKE_NPM_MS || 0);',
      'if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
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

test("the launch plan forwards server arguments", () => {
  const plan = launchPlan(["node", "ensure-deps.mjs", ROOT, "--profile", "verifier"]);
  assert.equal(plan.entry, join(ROOT, "mcp-server", "index.js"));
  assert.deepEqual(plan.serverArgv, ["node", plan.entry, "--profile", "verifier"]);
  assert.throws(() => launchPlan(["node", "ensure-deps.mjs"]), /usage/);
});

const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
const withNpm = (npm, extra = {}) => ({
  [pathKey]: `${npm.dir}${delimiter}${process.env[pathKey]}`,
  ...extra,
});
const npmCalls = (npm) =>
  existsSync(npm.log) ? readFileSync(npm.log, "utf8").trim().split("\n").filter(Boolean).length : 0;

test("a completed install is recorded by a marker that names the lockfile it installed", () => {
  const { root, serverDir } = fakePlugin({ provisioned: false });
  const npm = fakeNpm();
  assert.equal(needsProvisioning(serverDir), true);
  assert.equal(launch(root, [], withNpm(npm)).status, 0);
  const marker = readFileSync(join(serverDir, "node_modules", MARKER_NAME), "utf8");
  assert.equal(marker, `${lockfileDigest(serverDir)}\n`);
  assert.match(marker, /^[0-9a-f]{64}\n$/);
  assert.equal(needsProvisioning(serverDir), false);
  assert.equal(existsSync(join(serverDir, LOCK_NAME)), false, "the lock is released");
});

test("an install interrupted after ajv was written is repaired by the next launch", () => {
  // The state the first launcher took for a finished install: the sentinel
  // package is there, the rest of the tree is not, and no install completed.
  const { root, serverDir } = fakePlugin({ provisioned: false });
  mkdirSync(join(serverDir, "node_modules", "ajv"), { recursive: true });
  const npm = fakeNpm();
  assert.equal(needsProvisioning(serverDir), true);
  const run = launch(root, [], withNpm(npm));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(npmCalls(npm), 1);
  assert.equal(needsProvisioning(serverDir), false);
});

test("a changed lockfile is installed again", () => {
  const { root, serverDir } = fakePlugin({ provisioned: true });
  const npm = fakeNpm();
  assert.equal(launch(root, [], withNpm(npm)).status, 0);
  assert.equal(npmCalls(npm), 0);
  writeFileSync(join(serverDir, "package-lock.json"), '{"lockfileVersion":3,"packages":{"x":{}}}\n');
  assert.equal(needsProvisioning(serverDir), true);
  assert.equal(launch(root, [], withNpm(npm)).status, 0);
  assert.equal(npmCalls(npm), 1);
  assert.equal(needsProvisioning(serverDir), false);
});

test("a failed install leaves no marker and no lock, so the next launch installs", () => {
  const { root, serverDir } = fakePlugin({ provisioned: false });
  const npm = fakeNpm();
  assert.equal(launch(root, [], withNpm(npm, { FAKE_NPM_FAIL: "1" })).status, 7);
  assert.equal(existsSync(join(serverDir, "node_modules", MARKER_NAME)), false);
  assert.equal(existsSync(join(serverDir, LOCK_NAME)), false);
  assert.equal(launch(root, [], withNpm(npm)).status, 0);
  assert.equal(npmCalls(npm), 2);
});

test("two launches at once install once, and both start the server on the installed tree", async () => {
  const { root, serverDir } = fakePlugin({ provisioned: false });
  const npm = fakeNpm();
  const start = () =>
    new Promise((done) => {
      const child = spawn(process.execPath, [LAUNCHER, root], {
        // The install outlasts the start of the second launcher by far.
        env: { ...process.env, ...withNpm(npm, { FAKE_NPM_MS: "1500" }) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
  const runs = await Promise.all([start(), start()]);
  for (const run of runs) {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout.trim()).ajv, true, "the server saw the installed tree");
  }
  assert.equal(npmCalls(npm), 1, "npm ci ran once for the two launches");
  // At most one waited: under load the second may start after the first is
  // done, and then finds the marker without ever seeing the lock.
  assert.ok(runs.filter((run) => /another launch \(pid \d+\) is installing/.test(run.stderr)).length <= 1);
  assert.equal(existsSync(join(serverDir, LOCK_NAME)), false);
});

test("a lock left by a launcher that no longer exists is taken over", () => {
  const { serverDir } = fakePlugin({ provisioned: false });
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.equal(processExists(dead), false);
  assert.equal(processExists(process.pid), true);
  assert.equal(processExists(Number.NaN), false);
  // EPERM: the process exists and is someone else's.
  assert.equal(processExists(1, () => { throw Object.assign(new Error("x"), { code: "EPERM" }); }), true);
  for (const content of [`${dead}\n`, "", "not a pid\n"]) {
    writeFileSync(join(serverDir, LOCK_NAME), content);
    const release = acquireLock(serverDir, { wait: () => {} });
    assert.equal(readFileSync(join(serverDir, LOCK_NAME), "utf8"), `${process.pid}\n`);
    release();
    assert.equal(existsSync(join(serverDir, LOCK_NAME)), false);
  }
});

test("a lock held by a live process is waited for, not broken", () => {
  const { serverDir } = fakePlugin({ provisioned: false });
  const lock = join(serverDir, LOCK_NAME);
  writeFileSync(lock, "4242\n");
  let polls = 0;
  const release = acquireLock(serverDir, {
    exists: (pid) => pid === 4242,
    // The owner releases after three polls; until then the lock is its own.
    wait: () => {
      polls += 1;
      assert.equal(readFileSync(lock, "utf8"), "4242\n");
      if (polls === 3) rmSync(lock);
    },
  });
  assert.equal(polls, 3);
  assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`);
  release();
});

test("one entry-point check serves every script, and holds through a linked directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "prd-entry-"));
  temporary.push(dir);
  const real = join(dir, "real dir");
  const link = join(dir, "link");
  mkdirSync(real);
  // A junction on Windows needs no privilege; macOS tmpdir() is itself a link.
  symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  const script = join(real, "tool.mjs");
  writeFileSync(script, "");
  const url = pathToFileURL(script).href;
  assert.equal(isEntry(url, script), true);
  assert.equal(isEntry(url, join(link, "tool.mjs")), true, "argv[1] through the link");
  assert.equal(isEntry(url, join(real, "other.mjs")), false, "a missing file is not the entry");
  assert.equal(isEntry(url, undefined), false);
  assert.equal(isEntry(url, LAUNCHER), false);

  // The four programs use it and none carries a copy of the comparison.
  for (const path of [
    "bin/ensure-deps.mjs",
    "scripts/check-health-stdio.mjs",
    "scripts/release/verify-mcpb-checksum.mjs",
    "scripts/external-judge/calibrate.mjs",
  ]) {
    const source = readFileSync(join(ROOT, path), "utf8");
    assert.match(source, /import \{ isEntry \} from "(\.\.?\/)+(bin\/)?is-entry\.mjs";/, path);
    assert.match(source, /if \(isEntry\(import\.meta\.url\)\)/, path);
    assert.doesNotMatch(source, /realpathSync|file:\/\/\$\{/, path);
  }
  // Run through the link, the launcher still starts (it resolves is-entry.mjs beside itself).
  const plugin = fakePlugin({ provisioned: true });
  const binLink = join(dir, "bin-link");
  symlinkSync(join(ROOT, "bin"), binLink, process.platform === "win32" ? "junction" : "dir");
  const run = spawnSync(process.execPath, [join(binLink, "ensure-deps.mjs"), plugin.root], {
    encoding: "utf8",
    input: "",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout.trim()).ajv, true);
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
