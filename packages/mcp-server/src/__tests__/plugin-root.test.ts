/**
 * #240 — the server finds its root from where its entry point is.
 *
 * The bundle lives in `mcp-server/`, the workspace build in
 * `packages/mcp-server/dist/`. A fixed "three levels up" is the root from
 * the second and two directories above it from the first.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePluginRoot } from "../plugin-root.js";

// packages/mcp-server/src/__tests__ → the repository root.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "plugin-root-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolvePluginRoot (#240)", () => {
  it("is the repository root from the directory of the bundle", () => {
    expect(resolvePluginRoot(join(REPO, "mcp-server"), {})).toBe(REPO);
  });

  it("is the repository root from the directory of the workspace build", () => {
    expect(resolvePluginRoot(join(REPO, "packages", "mcp-server", "dist"), {})).toBe(REPO);
  });

  it("is the archive root in the layout stage-mcpb.sh builds", () => {
    const archive = scratch();
    mkdirSync(join(archive, "mcp-server"));
    mkdirSync(join(archive, "packages", "skill"), { recursive: true });
    writeFileSync(join(archive, "packages", "skill", "skill-config.json"), "{}");
    expect(resolvePluginRoot(join(archive, "mcp-server"), {})).toBe(archive);
  });

  it("is CLAUDE_PLUGIN_ROOT when the host sets it, whatever the layout", () => {
    expect(resolvePluginRoot(join(REPO, "mcp-server"), { CLAUDE_PLUGIN_ROOT: "/somewhere/else" })).toBe(
      "/somewhere/else",
    );
  });

  it("is three levels up, as before, when no directory on the way holds packages/skill", () => {
    const base = scratch();
    const entry = join(base, "a", "b", "c");
    mkdirSync(entry, { recursive: true });
    expect(resolvePluginRoot(entry, {})).toBe(base);
  });

  it("does not take a packages/skill more than three levels above the entry point", () => {
    const base = scratch();
    mkdirSync(join(base, "packages", "skill"), { recursive: true });
    const entry = join(base, "a", "b", "c", "d");
    mkdirSync(entry, { recursive: true });
    // Four levels up holds packages/skill; the answer is three levels up.
    expect(resolvePluginRoot(entry, {})).toBe(join(base, "a"));
  });
});
