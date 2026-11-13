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

let scratch: string;
let bundle: string;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "prd-gen-bundle-"));
  bundle = join(scratch, "index.js");
  // The options of the `bundle` script of package.json.
  await build({
    entryPoints: [DIST_ENTRY],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    external: ["better-sqlite3"],
    outfile: bundle,
    logLevel: "silent",
  });
}, TEST_TIMEOUT_MS);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * An archive of its own for each test, so that neither depends on the other
 * having run (review of #241): the bundle in `mcp-server/`, and in
 * `packages/skill/` the files named, copied from the repository.
 */
function archiveWith(name: string, skillFiles: readonly string[]): string {
  const archive = join(scratch, name);
  mkdirSync(join(archive, "mcp-server"), { recursive: true });
  mkdirSync(join(archive, "packages", "skill"), { recursive: true });
  copyFileSync(bundle, join(archive, "mcp-server", "index.js"));
  for (const file of skillFiles) {
    copyFileSync(join(REPO, "packages", "skill", file), join(archive, "packages", "skill", file));
  }
  return archive;
}

async function health(archive: string): Promise<Health> {
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
      const report = await health(archiveWith("as-staged", ["skill-config.json"]));
      expect(report.configAvailable).toBe(true);
      expect(report.skillAvailable).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "finds SKILL.md once the archive carries it",
    async () => {
      const report = await health(archiveWith("with-skill", ["skill-config.json", "SKILL.md"]));
      expect(report.configAvailable).toBe(true);
      expect(report.skillAvailable).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
