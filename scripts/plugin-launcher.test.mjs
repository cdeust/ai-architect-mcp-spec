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
  readdirSync,
  realpathSync,
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
  lockfileDigest,
  needsProvisioning,
  processExists,
} from "../bin/provision-runtime.mjs";
import { NPM_CI_ARGS, launchPlan, npmCiInvocation } from "../bin/ensure-deps.mjs";
import { isEntry } from "../bin/is-entry.mjs";
import {
  holdsNativeBash,
  launchEnvironment,
  pathWithoutBash,
  serverCommand,
  verdict,
} from "./check-health-stdio.mjs";

// source: TEST_TIMEOUT_MS - 5 s of vitest.shared.mts. Not imported: this file runs under
// `node --test` (pnpm test:portable), and node 22.12 cannot load a .mts. The guard in
// scripts/release/test-timeouts.test.mjs checks the two are equal.
const CHILD_TIMEOUT_MS = 25_000;

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
      'if (process.env.FAKE_NPM_RELEASE) {',
      '  console.error("install barrier ready");',
      '  while (!fs.existsSync(process.env.FAKE_NPM_RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
      '}',
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
    timeout: CHILD_TIMEOUT_MS,
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

test("a first launch runs `npm ci` in private staging, keeps npm's output off stdout, then starts the server", () => {
  const { root, serverDir } = fakePlugin({ provisioned: false });
  const npm = fakeNpm();
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const run = launch(root, [], { [pathKey]: `${npm.dir}${delimiter}${process.env[pathKey]}` });
  assert.equal(run.status, 0, run.stderr);
  const calls = readFileSync(npm.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [...NPM_CI_ARGS]);
  assert.equal(realpathSync(dirname(calls[0].cwd)), realpathSync(join(root, ".prd-gen-runtime")));
  assert.notEqual(calls[0].cwd, serverDir);
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
  const run = spawnSync(process.execPath, [LAUNCHER], { encoding: "utf8", input: "", timeout: CHILD_TIMEOUT_MS });
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
  const cache = join(root, ".prd-gen-runtime");
  const [published] = readdirSync(cache);
  assert.match(published, /^[a-f0-9]{64}$/);
  const marker = readFileSync(join(cache, published, "node_modules", MARKER_NAME), "utf8");
  assert.equal(marker, `${lockfileDigest(serverDir)}\n`);
  assert.match(marker, /^[0-9a-f]{64}\n$/);
  assert.equal(needsProvisioning(serverDir), false);
  assert.equal(existsSync(join(serverDir, LOCK_NAME)), false, "the lock is released");
});

test("a damaged published runtime is repaired once in a new directory", () => {
  const { root } = fakePlugin({ provisioned: false });
  const npm = fakeNpm();
  const env = withNpm(npm);
  assert.equal(launch(root, [], env).status, 0);
  const cache = join(root, ".prd-gen-runtime");
  const [original] = readdirSync(cache);
  const marker = join(cache, original, "node_modules", MARKER_NAME);
  rmSync(marker);

  for (let launchNumber = 0; launchNumber < 2; launchNumber++) {
    const result = launch(root, [], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ajv, true);
  }
  assert.equal(npmCalls(npm), 2);
  assert.equal(existsSync(marker), false);
  assert.equal(readdirSync(cache).length, 2);
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

function observeLaunch(root, environment, notice) {
  const child = spawn(process.execPath, [LAUNCHER, root], {
    env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  const ready = new Promise(resolve => {
    child.stderr.on("data", data => {
      stderr += data;
      if (stderr.includes(notice)) resolve();
    });
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
  return { done, ready: Promise.race([ready, done.then(run => {
    throw Error("launcher exited before " + notice + ": " + run.stderr);
  })]) };
}

test("two launches at once install once, and both start the server on the installed tree", async () => {
  const { root } = fakePlugin({ provisioned: false });
  const npm = fakeNpm();
  const release = join(npm.dir, "release");
  const env = withNpm(npm, { FAKE_NPM_RELEASE: release });
  const first = observeLaunch(root, env, "install barrier ready");
  let second;
  try {
    await first.ready;
    second = observeLaunch(root, env, "another launch");
    await second.ready;
    assert.equal(npmCalls(npm), 1);
  } finally {
    writeFileSync(release, "");
    const runs = await Promise.all(second ? [first.done, second.done] : [first.done]);
    for (const run of runs) {
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout.trim()).ajv, true);
    }
  }
  assert.equal(npmCalls(npm), 1);
});

test("unexpected errors probing an owner never relinquish its reservation", () => {
  const denied = () => { throw Object.assign(new Error(), { code: "EPERM" }); };
  assert.equal(processExists(process.pid), true);
  assert.equal(processExists(1, denied), true);
  assert.throws(() => processExists(1, () => { throw Error("probe unavailable"); }), /probe unavailable/);
});

test("a legacy install can finish without the new launcher replacing its lock", async () => {
  const { root, serverDir } = fakePlugin({ provisioned: false });
  const lock = join(serverDir, LOCK_NAME);
  writeFileSync(lock, String(process.pid));
  const child = spawn(process.execPath, [LAUNCHER, root], { stdio: ["ignore", "pipe", "pipe"] });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  try {
    const [notice] = await Promise.race([
      new Promise(resolve => child.stderr.once("data", message => resolve([message]))),
      done.then(code => { throw Error("launcher exited before waiting: " + code); }),
    ]);
    assert.match(String(notice), /another launch/);
    assert.equal(readFileSync(lock, "utf8"), String(process.pid));
    mkdirSync(join(serverDir, "node_modules", "ajv"), { recursive: true });
    writeFileSync(join(serverDir, "node_modules", MARKER_NAME), lockfileDigest(serverDir));
    rmSync(lock);
    assert.equal(await done, 0);
    assert.equal(existsSync(join(root, ".prd-gen-runtime")), false);
  } finally {
    child.kill();
    await done;
  }
});

test("abandoned legacy installations are isolated, including unpublished owner records", () => {
  const dead = spawnSync(process.execPath, ["-e", ""], { timeout: CHILD_TIMEOUT_MS }).pid;
  for (const record of [String(dead), "", "not a pid"]) {
    const { root, serverDir } = fakePlugin({ provisioned: false });
    const lock = join(serverDir, LOCK_NAME);
    writeFileSync(lock, record);
    const npm = fakeNpm();
    const result = launch(root, [], withNpm(npm));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(lock, "utf8"), record);
    assert.equal(existsSync(join(serverDir, "node_modules")), false);
    assert.equal(needsProvisioning(serverDir), false);
  }
});

test("a terminated provisioning owner leaves an isolated stage and two successors install once", async () => {
  const { root, serverDir } = fakePlugin({ provisioned: false });
  const provider = pathToFileURL(join(ROOT, "bin", "provision-runtime.mjs")).href;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { provisionRuntime } from ${JSON.stringify(provider)};
     provisionRuntime(process.argv[1], dir => { console.log(dir); process.exit(24); });`, serverDir],
    { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
  assert.equal(interrupted.status, 24, interrupted.stderr);
  const abandoned = interrupted.stdout.trim();
  assert.equal(existsSync(join(abandoned, "package-lock.json")), true);
  const npm = fakeNpm();
  const start = () => new Promise((resolve, reject) => {
    const launcher = spawn(process.execPath, [LAUNCHER, root], { env: { ...process.env, ...withNpm(npm) } });
    launcher.on("error", reject);
    launcher.on("close", resolve);
  });
  assert.deepEqual(await Promise.all([start(), start()]), [0, 0]);
  assert.equal(npmCalls(npm), 1);
  // Late writes from the original npm child stay in its own working directory.
  writeFileSync(join(abandoned, "index.js"), "throw Error('old installation');");
  const next = launch(root, [], withNpm(npm));
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).ajv, true);
});

test("a new server bundle uses its own runtime even with the same npm lock", () => {
  const { root, serverDir } = fakePlugin({ provisioned: false });
  const npm = fakeNpm();
  assert.equal(launch(root, [], withNpm(npm)).status, 0);
  writeFileSync(join(serverDir, "index.js"), "console.log('next version');");
  assert.equal(launch(root, [], withNpm(npm)).stdout.trim(), "next version");
  assert.equal(npmCalls(npm), 2);
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
    timeout: CHILD_TIMEOUT_MS,
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
