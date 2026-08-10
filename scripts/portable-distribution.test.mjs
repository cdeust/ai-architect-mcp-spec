import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const text = (path) => readFileSync(join(ROOT, path), "utf8");

const EXPECTED_ARGS = ["--profile", "verifier"];
const SKILLS = ["audit-prd", "validate-spec"];

const assertOptionalReleasedChecksum = (checksum) => {
  if (checksum === undefined) return;
  assert.match(checksum, /^[a-f0-9]{64}$/);
  assert.notEqual(checksum, "0".repeat(64));
};

test("Codex and Gemini launch the same verifier profile", () => {
  const pkg = json("package.json");
  const codex = json(".codex-plugin/plugin.json");
  const gemini = json("gemini-extension.json");
  const marketplace = json(".agents/plugins/marketplace.json");
  const codexServer = codex.mcpServers["prd-spec-verifier"];
  const geminiServer = gemini.mcpServers["prd-spec-verifier"];
  const marketplaceEntry = marketplace.plugins.find(
    (entry) => entry.name === "ai-architect-mcp-spec",
  );

  assert.equal(codex.version, pkg.version);
  assert.equal(gemini.version, pkg.version);
  assert.equal(codex.skills, "./skills/");
  assert.equal(codex.name, "ai-architect-mcp-spec");
  assert.equal(gemini.name, "ai-architect-mcp-spec");
  assert.equal(marketplace.name, "ai-architect-mcp-spec-marketplace");
  assert.deepEqual(marketplaceEntry.source, { source: "local", path: "./" });
  assert.equal(codexServer.command, "node");
  assert.equal(geminiServer.command, "node");
  assert.deepEqual(codexServer.args.slice(-2), EXPECTED_ARGS);
  assert.deepEqual(geminiServer.args.slice(-2), EXPECTED_ARGS);
  // Measured with the installed Codex CLI 0.146.0: `codex mcp list` reports
  // this plugin's cwd as the absolute immutable cache root ending in
  // `ai-architect-mcp-spec/0.7.0/.`, with these unchanged relative args.
  // Upstream implements that observation in normalize_plugin_mcp_server_value
  // by replacing a relative cwd with root.join(cwd):
  // https://github.com/openai/codex/blob/1bbfb5cfada8e56280adcd397b23d0c301423894/codex-rs/codex-mcp/src/plugin_config.rs#L283-L290
  assert.equal(codexServer.cwd, ".");
  assert.equal(codexServer.args[0], "mcp-server/index.js");
  assert.equal(geminiServer.args[0], "${extensionPath}/mcp-server/index.js");
});

test("portable skill manifests contain only supported frontmatter", () => {
  for (const name of SKILLS) {
    const skill = text(`skills/${name}/SKILL.md`);
    const match = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    assert.ok(match, `${name}: missing YAML frontmatter`);
    const keys = match[1]
      .split("\n")
      .filter((line) => /^[a-z]/.test(line))
      .map((line) => line.slice(0, line.indexOf(":")))
      .sort();
    assert.deepEqual(keys, ["description", "name"], `${name}: unsupported frontmatter`);
    assert.match(skill, /does not (establish|prove)/i);
  }
});

test("Claude remains on its existing full-profile launch path", () => {
  const pkg = json("package.json");
  const claude = json(".mcp.json");
  const claudePlugin = json(".claude-plugin/plugin.json");
  const manifest = json("manifest.json");
  const server = claude.mcpServers["prd-gen"];
  const launcher = text("bin/ensure-deps.sh");
  assert.equal(claudePlugin.name, "ai-architect-mcp-spec");
  assert.equal(claudePlugin.version, pkg.version);
  assert.equal(manifest.name, "ai-architect-mcp-spec");
  assert.equal(manifest.version, pkg.version);
  assert.equal(server.args.includes("--profile"), false);
  assert.match(server.args[0], /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.match(launcher, /exec node .*"\$@"/);
  assert.doesNotMatch(launcher, /PROFILE|--profile|omit=optional/);
});

test("canonical distribution identity is shared by every host plugin", () => {
  const pkg = json("package.json");
  const server = json("server.json");
  const fullSkill = text("packages/skill/SKILL.md");
  const fullSkillPackage = json("packages/skill/package.json");
  assert.equal(server.name, "io.github.cdeust/ai-architect-mcp-spec");
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].version, pkg.version);
  assert.match(server.packages[0].identifier, /\/ai-architect-mcp-spec\.mcpb$/);
  assertOptionalReleasedChecksum(server.packages[0].fileSha256);
  assert.match(
    fullSkill,
    new RegExp(`^---\\nname: ai-architect-mcp-spec\\nversion: ${pkg.version.replaceAll(".", "\\.")}\\n`),
  );
  assert.doesNotMatch(fullSkill, /name: prd-spec-generator/);
  assert.equal(fullSkillPackage.name, "@ai-architect-mcp-spec/skill");
  for (const path of [
    ".codex-plugin/plugin.json",
    ".agents/plugins/marketplace.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    "manifest.json",
    "gemini-extension.json",
  ]) {
    assert.doesNotMatch(text(path), /prd-spec-generator/);
  }
});

test("portable identity accepts pre-release and real post-release checksums", () => {
  assert.doesNotThrow(() => assertOptionalReleasedChecksum(undefined));
  assert.doesNotThrow(() => assertOptionalReleasedChecksum("a".repeat(64)));
  assert.throws(() => assertOptionalReleasedChecksum("0".repeat(64)));
});
