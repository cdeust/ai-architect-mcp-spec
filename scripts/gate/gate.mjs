#!/usr/bin/env node
/**
 * The delivery gate: nothing leaves the machine before its tests and the
 * mutation testing of the lines it changed have passed.
 *
 *   node scripts/gate/gate.mjs run    run the checks of delivery-gate.json,
 *                                     then Stryker on the production lines
 *                                     the diff with `base` changed, each in
 *                                     a sandbox of its own (profiles/); record
 *                                     the verdict for the committed tree.
 *   node scripts/gate/gate.mjs hook   PreToolUse hook (.claude/settings.json):
 *                                     refuse a delivery whose tree has no
 *                                     passed verdict. Exit 2 blocks the call.
 *
 * A verdict is kept under the git directory, by the hash of the tree it was
 * computed on, so it holds for exactly the files that were tested: a later
 * edit gives another tree, which has no verdict. It is recorded only when
 * nothing is uncommitted, since the tree is then what the checks ran on.
 *
 * Two layers. The hook is the check against a bypass: no delivery without
 * a verdict. The sandbox is the defence against what runs: an operation has
 * the access its profile gives it and no other, and it cannot write the
 * settings, the gate or the verdicts. The verdict is written by this
 * process, outside the sandbox.
 *
 * Exit codes of `run`: 0 passed, 1 a check or a mutant failed, 2 refused
 * (configuration, repository state, or a sandbox that does not hold).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { changedLines, productionChanges, judgeMutants, isDelivery, resolveProfile } from "./gate-lib.mjs";

function git(args, cwd) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr.trim()}`);
  return out.stdout;
}

function verdictPath(cwd) {
  const tree = git(["rev-parse", "HEAD^{tree}"], cwd).trim();
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).trim();
  return { tree, path: join(common, "delivery-gate", `${tree}.json`) };
}

function loadConfig(root) {
  return JSON.parse(readFileSync(join(root, "delivery-gate.json"), "utf8"));
}

/**
 * One sandbox per operation: a temporary directory of its own, the profile
 * resolved for it, the sandbox runtime around the command. The operation
 * gets the environment of the profile and nothing else of the host.
 * Returns the exit status of the command (null when it could not start).
 */
function sandboxed(command, profileName, root, { quiet = false } = {}) {
  const srt = join(root, "node_modules", ".bin", "srt");
  if (!existsSync(srt)) throw new Error("the sandbox runtime is not installed (pnpm install)");
  const profile = JSON.parse(readFileSync(join(root, "scripts", "gate", "profiles", `${profileName}.json`), "utf8"));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gate-sb-")));
  try {
    const tmp = join(dir, "tmp");
    mkdirSync(join(tmp, "home"), { recursive: true });
    const { srt: settings, env } = resolveProfile(profile, { home: homedir(), worktree: root, tmp }, process.env);
    const settingsPath = join(dir, "srt.json");
    writeFileSync(settingsPath, JSON.stringify(settings));
    if (!quiet) console.error(`\n[gate] ${command}  (sandbox: ${profileName})`);
    const out = spawnSync(srt, ["--settings", settingsPath, "-c", command], {
      cwd: root,
      env,
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
    });
    return { status: out.status, stdout: out.stdout ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The proof that the sandbox holds, before anything is run in it: under the
 * profile, the canary tries to write outside its directories and inside the
 * protected ones, to read a file of the user's home that the profile denies,
 * and, unless the profile grants the loopback, to reach a port of the host. One success and the gate refuses to run:
 * there is no unsandboxed fallback.
 */
async function proveIsolation(profileName, root) {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "gate-canary-")));
  const inside = join(root, ".claude", "gate-canary");
  const secretDir = join(homedir(), ".ssh");
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const args = ["--write", join(outside, "x"), "--write", inside];
    // A profile that grants the loopback grants this port with it: only a
    // profile without it promises that the host's ports are out of reach.
    const profile = JSON.parse(readFileSync(join(root, "scripts", "gate", "profiles", `${profileName}.json`), "utf8"));
    if (profile.srt.network.allowLocalBinding !== true) args.push("--connect", String(server.address().port));
    // A file the profile denies, when the user has one: reading a directory
    // entry proves nothing about the files in it.
    const secret = existsSync(secretDir) ? readdirSync(secretDir).map((n) => join(secretDir, n)).find((p) => statSync(p).isFile()) : undefined;
    if (secret) args.push("--read", secret);
    const out = sandboxed(`node scripts/gate/canary.mjs ${args.map((a) => `'${a}'`).join(" ")}`, profileName, root, { quiet: true });
    if (out.status !== 0) {
      throw new Error(`the sandbox does not hold under profile ${profileName}: ${out.stdout.trim() || "the canary could not run"}`);
    }
  } finally {
    server.close();
    rmSync(outside, { recursive: true, force: true });
    rmSync(inside, { force: true });
  }
}

async function run() {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const config = loadConfig(root);

  const profiles = new Set([...config.checks.map((c) => c.profile), config.mutation.profile]);
  for (const profile of profiles) await proveIsolation(profile, root);
  console.error(`[gate] sandbox: isolation proved for profile(s) ${[...profiles].join(", ")}`);

  for (const check of config.checks) {
    if (sandboxed(check.command, check.profile, root).status !== 0) {
      console.error(`[gate] FAILED: ${check.name}`);
      return 1;
    }
  }

  // The lines this work changes: the diff with the point where it left
  // `base`, uncommitted changes included.
  const diff = git(["diff", "-U0", "--src-prefix=a/", "--dst-prefix=b/", "--merge-base", config.base], root);
  const changes = productionChanges(changedLines(diff), config.mutation.production);
  let judged = 0;
  if (changes.size === 0) {
    console.error("[gate] mutation: the diff changes no production line");
  } else {
    // Stryker mutates the changed files whole; the verdict is on the mutants
    // that touch a changed line. A line filter given to Stryker would drop
    // the mutants of an expression that starts above the changed line.
    const reportPath = join(root, config.mutation.report);
    rmSync(reportPath, { force: true });
    const mutation = sandboxed(`${config.mutation.command} --mutate ${[...changes.keys()].join(",")}`, config.mutation.profile, root);
    if (mutation.status !== 0 || !existsSync(reportPath)) {
      console.error("[gate] FAILED: mutation testing did not run to its report");
      return 1;
    }
    const verdict = judgeMutants(JSON.parse(readFileSync(reportPath, "utf8")), changes);
    judged = verdict.judged;
    for (const m of verdict.undetected) {
      console.error(`[gate] ${m.status}: ${m.file}:${m.line} ${m.mutator} -> ${m.replacement.split("\n")[0].slice(0, 80)}`);
    }
    if (verdict.undetected.length > 0) {
      console.error(
        `[gate] FAILED: mutation, ${verdict.undetected.length} of ${judged} mutant(s) on the changed lines undetected. ` +
          "Each needs a test that kills it, or, when no test can tell it from the original, " +
          "`// Stryker disable next-line <Mutator>: equivalent: <why>`.",
      );
      return 1;
    }
    console.error(`[gate] mutation: ${judged} mutant(s) on the changed lines, all detected`);
  }

  if (git(["status", "--porcelain"], root).trim() !== "") {
    console.error("[gate] passed, not recorded: commit the work and run the gate again to record the verdict.");
    return 0;
  }
  const { tree, path } = verdictPath(root);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ tree, passed: true, at: new Date().toISOString(), checks: config.checks.map((c) => c.name), mutated_files: [...changes.keys()], mutants_judged: judged }, null, 2),
  );
  console.error(`[gate] passed, recorded for tree ${tree}`);
  return 0;
}

function hook() {
  let call;
  try {
    call = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0; // not a hook payload: nothing to judge
  }
  const cwd = call.cwd ?? process.cwd();
  let config;
  try {
    config = loadConfig(git(["rev-parse", "--show-toplevel"], cwd).trim());
  } catch {
    return 0; // not this repository, or no gate configured there
  }
  if (!isDelivery(call, config.delivers)) return 0;
  try {
    const { tree, path } = verdictPath(cwd);
    if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).passed === true) return 0;
    console.error(
      `Delivery refused: the tree ${tree} has no passed verdict of the delivery gate. ` +
        "Commit the work, run `pnpm gate` (tests, then mutation testing of the changed lines), and deliver again. " +
        "See .claude/skills/deliver/SKILL.md.",
    );
  } catch (error) {
    console.error(`Delivery refused: the delivery gate could not read the repository (${error.message}).`);
  }
  return 2;
}

const mode = process.argv[2];
if (mode === "run") {
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error(`[gate] refused: ${error.message}`);
    process.exitCode = 2;
  }
}
else if (mode === "hook") process.exitCode = hook();
else {
  console.error("usage: gate.mjs run | hook");
  process.exitCode = 2;
}
