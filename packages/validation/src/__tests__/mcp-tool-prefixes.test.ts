/**
 * Repo-wide gate: every plugin-scoped MCP tool prefix named anywhere in this
 * repository must be one the host can actually resolve.
 *
 * Why this exists. The host derives a plugin-scoped MCP tool name as
 * `mcp__plugin_<plugin-name>_<server-key>__<tool>` — BOTH halves are in the
 * name. Cortex v4.15.0 renamed its plugin `cortex` -> `hypermnesia-mcp` while
 * keeping the server key `cortex`, and the rename commit asserted that "tool
 * names ... are untouched" because the server key had not moved. That premise
 * was false, and it silently broke `call_cortex_tool` in the skill: an
 * unresolvable MCP tool name is DROPPED by the host with no exception, no
 * warning, and no log line. Section-context recall returned nothing and PRD
 * generation carried on as if it had.
 *
 * A prefix that lives only in prose and comments cannot fail a type-check or a
 * unit test, so nothing in this repo could have caught it. This test is that
 * missing gate. It is deliberately a test rather than a new CI workflow so it
 * runs inside `build + test`, which already gates every PR.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../..");

interface ProjectMcpIdentity {
  readonly pluginName: string;
  readonly serverKey: string;
  readonly prefix: string;
}

/** Derive this plugin's host-visible MCP identity from its shipped manifests. */
function projectMcpIdentity(): ProjectMcpIdentity {
  const plugin = JSON.parse(
    readFileSync(resolve(REPO_ROOT, ".claude-plugin/plugin.json"), "utf8"),
  ) as { readonly name?: unknown; readonly mcpServers?: unknown };
  if (typeof plugin.name !== "string" || typeof plugin.mcpServers !== "string") {
    throw new Error(".claude-plugin/plugin.json must declare name and mcpServers path");
  }

  const mcp = JSON.parse(
    readFileSync(resolve(REPO_ROOT, plugin.mcpServers), "utf8"),
  ) as { readonly mcpServers?: unknown };
  if (typeof mcp.mcpServers !== "object" || mcp.mcpServers === null) {
    throw new Error(`${plugin.mcpServers} must declare mcpServers`);
  }
  const serverKeys = Object.keys(mcp.mcpServers);
  if (serverKeys.length !== 1) {
    throw new Error(`${plugin.mcpServers} must declare exactly one MCP server`);
  }

  const serverKey = serverKeys[0]!;
  return {
    pluginName: plugin.name,
    serverKey,
    prefix: `mcp__plugin_${plugin.name}_${serverKey}__`,
  };
}

const PROJECT_MCP_IDENTITY = projectMcpIdentity();

/**
 * Prefixes the host can resolve for this repo's declared dependencies.
 *
 * Adding a row is a deliberate act: it asserts that a plugin by that name,
 * exposing an MCP server by that key, is actually installed when the skill
 * runs. Derive it from the dependency's own `.claude-plugin/plugin.json`
 * (`name` + the key under `mcpServers`) — never from memory.
 */
const KNOWN_MCP_PREFIXES: ReadonlySet<string> = new Set([
  // Cortex memory. plugin.json: name "hypermnesia-mcp", mcpServers key "cortex".
  // Renamed from "cortex" in v4.15.0 over a community-directory collision.
  "mcp__plugin_hypermnesia-mcp_cortex__",
  // Codebase graph intel. plugin.json: name "ai-architect-mcp-codebase",
  // mcpServers key "ai-architect". Renamed from "ai-architect-mcp-codebase" (and
  // briefly "ai-architect-codebase") in v0.9.0; the producer publishes the
  // three dead spellings in mcp-contract.json as revoked_claude_tool_prefixes,
  // and .github/workflows/upstream-identity.yml checks this row against it.
  "mcp__plugin_ai-architect-mcp-codebase_ai-architect__",
  // This package, derived from plugin.json name × the sole .mcp.json server key.
  // Both halves are load-bearing and a publication rename changes the prefix.
  PROJECT_MCP_IDENTITY.prefix,
]);

/**
 * A line carrying this marker may name a prefix outside the allowlist.
 *
 * Reserved for text that must quote a dead spelling on purpose — migration
 * notes contrasting old with new, and this file's own allowlist prose. It is
 * NOT an escape hatch for a stale reference: an unmarked stale prefix is the
 * defect this gate exists to fail on.
 */
const LEGACY_MARKER = "mcp-prefix-allow-legacy";

const PREFIX_RE = /mcp__plugin_[a-zA-Z0-9_.-]+?__/g;

/** Repo files git tracks, so build output and node_modules are excluded by construction. */
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

/** Files whose bytes are not text we can meaningfully scan. */
function isScannable(path: string): boolean {
  return !/\.(png|jpg|jpeg|gif|ico|pdf|zip|gz|woff2?|ttf|mcpb)$/i.test(path);
}

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly prefix: string;
  readonly text: string;
}

function scanRepo(): { offences: Offence[]; seen: Set<string>; scanned: number } {
  const offences: Offence[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  for (const file of trackedFiles().filter(isScannable)) {
    let content: string;
    try {
      content = readFileSync(resolve(REPO_ROOT, file), "utf8");
    } catch {
      continue; // unreadable or deleted-but-tracked; not this gate's concern
    }
    scanned += 1;
    if (!content.includes("mcp__plugin_")) continue;

    content.split("\n").forEach((text, index) => {
      for (const match of text.matchAll(PREFIX_RE)) {
        const prefix = match[0];
        seen.add(prefix);
        if (KNOWN_MCP_PREFIXES.has(prefix)) continue;
        if (text.includes(LEGACY_MARKER)) continue;
        offences.push({ file, line: index + 1, prefix, text: text.trim() });
      }
    });
  }
  return { offences, seen, scanned };
}

describe("plugin-scoped MCP tool prefixes", () => {
  it("derives this package prefix from plugin.json name and .mcp.json server key", () => {
    expect(PROJECT_MCP_IDENTITY).toEqual({
      pluginName: "ai-architect-mcp-spec",
      serverKey: "prd-gen",
      prefix: "mcp__plugin_ai-architect-mcp-spec_prd-gen__",
    });
    expect(KNOWN_MCP_PREFIXES.has(PROJECT_MCP_IDENTITY.prefix)).toBe(true);
  });

  it("names only prefixes the host can resolve", () => {
    const { offences } = scanRepo();
    const report = offences
      .map((o) => `  ${o.file}:${o.line}\n    ${o.prefix}\n    > ${o.text}`)
      .join("\n");
    expect(
      offences,
      offences.length === 0
        ? ""
        : `Unresolvable MCP tool prefix(es). The host drops these SILENTLY — ` +
            `no error will ever tell you.\n${report}\n\n` +
            `Fix the reference, or if the dead spelling is quoted on purpose, ` +
            `add the marker "${LEGACY_MARKER}" to that line.`,
    ).toEqual([]);
  });

  it("actually scanned this repo, so a green result is not vacuous", () => {
    const { seen, scanned } = scanRepo();
    // If the scan silently matched nothing — wrong root, git failure, regex
    // drift — the assertion above passes while checking nothing at all. That is
    // exactly the silent-success failure this gate was built to end, so it must
    // not be reproducible by the gate itself.
    expect(scanned).toBeGreaterThan(50);
    expect(seen.size).toBeGreaterThan(0);
    expect(seen.has("mcp__plugin_hypermnesia-mcp_cortex__")).toBe(true);
  });

  it("would reject the dead pre-rename Cortex prefix", () => {
    // Pins the gate's discriminating power against the exact string that caused
    // the outage. Without this, an allowlist that accidentally contained every
    // prefix would still pass the two tests above.
    expect(KNOWN_MCP_PREFIXES.has("mcp__plugin_cortex_cortex__")).toBe(false); // mcp-prefix-allow-legacy
    // ...and against the malformed ai-architect-mcp-codebase spelling (underscores,
    // no server key) that this gate found in docs/EXAMPLES.md when introduced.
    expect(KNOWN_MCP_PREFIXES.has("mcp__plugin_automatised_pipeline__")).toBe(false); // mcp-prefix-allow-legacy
    // ...and the former publication identity, whose plugin half changed in 0.8.0
    // (0.7.0 moved only the Registry entry and primary bundle; see CHANGELOG).
    expect(KNOWN_MCP_PREFIXES.has("mcp__plugin_prd-spec-generator_prd-gen__")).toBe(false); // mcp-prefix-allow-legacy
  });
});
