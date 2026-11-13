/**
 * #240 — the bundled server finds its files where a packaged host puts them.
 *
 * `mcp-server/index.js`, the bundle every packaged host launches, is rebuilt
 * by the release commit only, so the tree's copy says nothing about the
 * source under test. This bundles the built server the way `pnpm bundle`
 * does, into the layout `scripts/release/stage-mcpb.sh` builds, and starts it
 * as a host that sets neither CLAUDE_PLUGIN_ROOT nor PRD_GEN_SKILL_CONFIG.
 *
 * Needs `pnpm build` first, as every CI command runs it before the tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startStdioServer } from "./stdio-server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = join(HERE, "..", "..", "dist", "index.js");
const REPO = resolve(HERE, "..", "..", "..", "..");

// A cold start of the bundle, after the bundling itself.
const TEST_TIMEOUT_MS = 120_000;

interface Health {
  readonly configAvailable: boolean;
  readonly skillAvailable: boolean;
}

let archive: string;

beforeAll(async () => {
  archive = mkdtempSync(join(tmpdir(), "prd-gen-bundle-"));
  mkdirSync(join(archive, "packages", "skill"), { recursive: true });
  copyFileSync(
    join(REPO, "packages", "skill", "skill-config.json"),
    join(archive, "packages", "skill", "skill-config.json"),
  );
  // The options of the `bundle` script of package.json.
  await build({
    entryPoints: [DIST_ENTRY],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    external: ["better-sqlite3"],
    outfile: join(archive, "mcp-server", "index.js"),
    logLevel: "silent",
  });
}, TEST_TIMEOUT_MS);

afterAll(() => {
  rmSync(archive, { recursive: true, force: true });
});

async function health(): Promise<Health> {
  const server = await startStdioServer(undefined, {
    entry: join(archive, "mcp-server", "index.js"),
    unset: ["CLAUDE_PLUGIN_ROOT", "PRD_GEN_SKILL_CONFIG"],
  });
  try {
    const response = await server.call("check_health", {});
    expect(response.isError, response.text).toBe(false);
    return JSON.parse(response.text) as Health;
  } finally {
    await server.close();
  }
}

describe("the bundle in the layout of the .mcpb, no variable set (#240)", () => {
  it(
    "finds the configuration the archive carries, and no SKILL.md, which it does not carry",
    async () => {
      const report = await health();
      expect(report.configAvailable).toBe(true);
      expect(report.skillAvailable).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "finds SKILL.md once the archive carries it",
    async () => {
      copyFileSync(join(REPO, "packages", "skill", "SKILL.md"), join(archive, "packages", "skill", "SKILL.md"));
      const report = await health();
      expect(report.configAvailable).toBe(true);
      expect(report.skillAvailable).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
