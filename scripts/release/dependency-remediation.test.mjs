import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

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

test("release reads the target latest version from JSON without executing the response", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  const step = workflow.split("- name: Verify the registry now serves the published version")[1];
  const queryStart = step.indexOf("| jq -er '") + "| jq -er '".length;
  const queryEnd = step.indexOf("')", queryStart);
  expect(queryEnd).toBeGreaterThan(queryStart);
  const query = step.slice(queryStart, queryEnd);
  const row = (name, version, isLatest) => ({
    server: { name, version },
    _meta: { "io.modelcontextprotocol.registry/official": { isLatest } },
  });
  const name = "io.github.cdeust/ai-architect-mcp-spec";
  const servers = [row("other", "9.0.0", true), row(name, "0.8.0", false), row(name, "0.9.0", true)];
  const parse = (rows) => spawnSync("jq", ["-er", query], {
    input: JSON.stringify({ servers: rows }), encoding: "utf8",
  });
  expect(parse(servers)).toMatchObject({ status: 0, stdout: "0.9.0\n" });
  expect(parse(servers.slice(0, -1)).status).not.toBe(0);
});
