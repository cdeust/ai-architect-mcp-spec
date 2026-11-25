import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { holdsNativeBash } from "../check-health-stdio.mjs";

const root = createRequire(new URL("../../package.json", import.meta.url));
const sandbox = root.resolve("@anthropic-ai/sandbox-runtime/package.json");
const sandboxRequire = createRequire(sandbox);
const strykerRequire = createRequire(root.resolve("@stryker-mutator/core"));
const workspace = createRequire(new URL("../../packages/mcp-server/package.json", import.meta.url));
const sdkRequire = createRequire(workspace.resolve("@modelcontextprotocol/sdk/server/stdio.js"));

test("the installed dependency parents resolve the fixed versions", () => {
  expect(sandboxRequire("zod/package.json").version).toBe("4.6.7");
  expect(strykerRequire("minimatch/package.json").version).toBe("11.0.1");
  const { Minimatch } = strykerRequire("minimatch");
  expect(new Minimatch("**/*.ts").match("src/example.ts")).toBe(true);
  const hono = JSON.parse(readFileSync(join(dirname(sdkRequire.resolve("hono")), "../../package.json"), "utf8"));
  const [major, minor, patch] = hono.version.split(".").map(Number);
  expect(major).toBe(4);
  expect(minor > 13 || (minor === 13 && patch >= 16)).toBe(true);
  expect(typeof sdkRequire("hono").Hono).toBe("function");
});

test("Sandbox Runtime keeps its published Zod v3 schemas and decider entrypoint", async () => {
  const dist = join(dirname(sandbox), "dist", "sandbox");
  const schema = await import(pathToFileURL(join(dist, "sandbox-config.js")).href);
  const decider = await import(pathToFileURL(join(dist, "decider-client.js")).href);
  expect(schema.NetworkConfigSchema.safeParse({ allowedDomains: [], deniedDomains: [] }).success).toBe(true);
  expect(schema.NetworkConfigSchema.safeParse({ allowedDomains: [false], deniedDomains: [] }).success).toBe(false);
  expect(typeof decider.createDecider).toBe("function");
});

test("bounded Zod v3 collections reject before visiting elements in both module forms", async () => {
  const zodPackage = sandboxRequire.resolve("zod/package.json");
  const { exports } = sandboxRequire(zodPackage);
  const esm = await import(pathToFileURL(join(dirname(zodPackage), exports["./v3"].import)).href);
  for (const { z } of [sandboxRequire("zod/v3"), esm]) {
    let visits = 0;
    const item = z.string().refine(() => { visits += 1; return true; });
    for (const [schema, input, valid] of [
      [z.array(item).max(1), ["a", "b"], ["a"]],
      [z.array(item).length(1), ["a", "b"], ["a"]],
      [z.set(item).max(1), new Set(["a", "b"]), new Set(["a"])],
    ]) {
      const before = visits;
      const result = await schema.safeParseAsync(input);
      expect(result.success).toBe(false);
      expect(result.error.issues.map(({ code }) => code)).toEqual(["too_big"]);
      expect(visits).toBe(before);
      expect(schema.parse(valid)).toEqual(valid);
      expect(visits).toBe(before + 1);
    }
  }
});

const registryName = "io.github.cdeust/ai-architect-mcp-spec";
const version = "0.9.0";
const row = (name, version, isLatest) => ({
  server: { name, version },
  _meta: { "io.modelcontextprotocol.registry/official": { isLatest } },
});

function registryVerificationCommands(workflow) {
  const lines = workflow.split(/\r?\n/u);
  const step = lines.indexOf("      - name: Verify the registry now serves the published version");
  expect(step).toBeGreaterThanOrEqual(0);
  expect(lines[step + 1]).toBe("        run: |");
  const commands = [];
  for (const line of lines.slice(step + 2)) {
    if (!line.startsWith("          ") && line.trim()) break;
    commands.push(line.slice(10));
  }
  return commands.join("\n");
}

function fixtureBash() {
  if (process.platform !== "win32") return "bash";
  // Avoid the WSL launcher in System32, as in the Windows health check.
  const path = process.env.Path ?? process.env.PATH ?? "";
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin");
  const native = [gitBash, ...path.split(delimiter)]
    .find((directory) => directory && holdsNativeBash(directory, systemRoot)
      && existsSync(join(directory, "bash.exe")));
  expect(native, "Git Bash must be available on the Windows runner").toBeDefined();
  return join(native, "bash.exe");
}

// Above vitest's 5000ms default: each test runs the registry step in a bash that
// starts curl and sleep stand-ins, and process start on windows-latest varies
// with runner load. "release retries an empty registry" took 880ms in run
// 45319560109 and 7502ms in run 45330752186 (job 138232378666), a timeout, not
// a failure of the step; "release exhausts its bounded retry" took 4024ms in
// the same job. 30s follows frozen-baseline-provenance.test.mjs.
// source: the two job logs above; precedent scripts/release/frozen-baseline-provenance.test.mjs.
const REGISTRY_TIMEOUT_MS = 30_000;

// spawnSync blocks the event loop, so vitest's limit alone cannot stop a hung
// bash. The child gets its own limit, below the test's, so a hang ends as
// ETIMEDOUT in result.error, which the assertion below reports.
// source: margin of 5s left to vitest to report, as in frozen-baseline-provenance.test.mjs.
const REGISTRY_PROCESS_TIMEOUT_MS = REGISTRY_TIMEOUT_MS - 5_000;

function runRegistryVerification(first, next = first) {
  const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  const commands = registryVerificationCommands(workflow);
  const work = mkdtempSync(join(tmpdir(), "registry-verification-"));
  try {
    const write = (file, contents, mode) => writeFileSync(join(work, file), contents, { mode });
    write("server.runtime.json", JSON.stringify({ version }));
    write("first.json", JSON.stringify(first));
    write("next.json", JSON.stringify(next));
    write("curl", '#!/usr/bin/env bash\nprintf "curl\\n" >> probes\nif [ -e started ]; then cat next.json; else touch started; cat first.json; fi\n', 0o755);
    write("sleep", '#!/usr/bin/env bash\nprintf "sleep\\n" >> probes\n', 0o755);
    // Git Bash converts the native cwd to its shell path; Node leaves PATH alone.
    const fixturePath = 'export PATH="$PWD:$PATH"\n'
      + '[[ $(type -P curl) == "$PWD/curl" && $(type -P sleep) == "$PWD/sleep" ]] || exit 97\n';
    const result = spawnSync(fixtureBash(), ["-c", fixturePath + commands], {
      cwd: work, encoding: "utf8", timeout: REGISTRY_PROCESS_TIMEOUT_MS,
    });
    expect(result.error).toBeUndefined();
    return { ...result, probes: readFileSync(join(work, "probes"), "utf8") };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("release retries an empty registry, then selects the target latest version", () => {
  const result = runRegistryVerification(
    { servers: [] },
    { servers: [row("other", "9.0.0", true), row(registryName, "0.8.0", false), row(registryName, version, true)] },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("registry reports latest version <none>");
  expect(result.stdout).toContain("Registry converged to 0.9.0 on attempt 2.");
  expect(result.probes).toBe("curl\nsleep\ncurl\n");
}, REGISTRY_TIMEOUT_MS);

test("release exhausts its bounded retry when a valid registry still has no latest version", () => {
  const result = runRegistryVerification({ servers: [row(registryName, version, false)] });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("after 12 attempts");
  expect(result.probes).toBe("curl\nsleep\n".repeat(11) + "curl\n");
}, REGISTRY_TIMEOUT_MS);

test("release rejects a malformed registry response without polling", () => {
  const result = runRegistryVerification({ servers: null });
  expect(result.status).not.toBe(0);
  expect(result.probes).toBe("curl\n");
}, REGISTRY_TIMEOUT_MS);


test("release shell extraction stops before a later workflow sibling", () => {
  const sample = [
    "      - name: Verify the registry now serves the published version",
    "        run: |",
    "          echo actual step",
    "",
    "      - name: Later workflow step",
    "        run: echo outside the fixture",
  ].join("\n");
  expect(registryVerificationCommands(sample).trim()).toBe("echo actual step");
});
