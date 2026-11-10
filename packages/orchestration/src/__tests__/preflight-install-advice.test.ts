/**
 * The install commands the preflight prints when a companion probe fails are
 * the ones the README documents, and every README companion install names its
 * marketplace.
 *
 * Proves:
 *   1. Each `/plugin marketplace add` and `/plugin install` line of the
 *      Cortex and ai-architect-mcp-codebase failure messages appears in the
 *      README's Companion ecosystem block as a `claude plugin …` command.
 *   2. Every `claude plugin install` line of that block is qualified as
 *      `<plugin>@<marketplace>`: zetetic-team-subagents is listed in both
 *      `zetetic-marketplace` and Cortex's `cortex-plugins`, so an unqualified
 *      install does not say which one it takes.
 *
 * source: #123 (README and preflight disagreed on the Cortex install
 * commands); marketplace names read from each companion's
 * .claude-plugin/marketplace.json on 2026-11-10.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handlePreflight } from "../handlers/preflight.js";
import { newPipelineState } from "../index.js";

const README = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../README.md"),
  "utf8",
);

function companionBlock(): string {
  const section = README.split("### Companion ecosystem")[1];
  expect(section, "README has a Companion ecosystem section").toBeDefined();
  const block = /```bash\n([\s\S]*?)```/.exec(section ?? "");
  expect(block, "Companion ecosystem has a bash block").not.toBeNull();
  return block?.[1] ?? "";
}

function failureAdvice(codebasePath: string | null, correlation: string): string {
  const state = newPipelineState({
    run_id: "preflight_advice_001",
    feature_description: "build OAuth login",
    codebase_path: codebasePath,
  });
  const out = handlePreflight({
    state,
    result: {
      kind: "tool_result",
      correlation_id: correlation,
      success: false,
      data: null,
      error: "not reachable",
    },
  } as Parameters<typeof handlePreflight>[0]);
  expect(out.action.kind).toBe("failed");
  return out.action.kind === "failed" ? out.action.reason : "";
}

function pluginCommands(advice: string): string[] {
  return advice
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\/plugin (marketplace add|install) /.test(line))
    .map((line) => `claude ${line.slice(1)}`);
}

describe("preflight install advice matches the README", () => {
  it.each([
    ["Cortex", null, "preflight_cortex_probe"],
    ["ai-architect-mcp-codebase", "/tmp/repo", "preflight_ai_architect_probe"],
  ])("%s failure commands are documented", (_name, codebase, correlation) => {
    const commands = pluginCommands(failureAdvice(codebase, correlation));
    expect(commands.length).toBe(2);
    const block = companionBlock();
    for (const command of commands) {
      expect(block).toContain(command);
    }
  });

  it("every README companion install names its marketplace", () => {
    const installs = companionBlock()
      .split("\n")
      .filter((line) => line.startsWith("claude plugin install "));
    expect(installs.length).toBe(3);
    for (const line of installs) {
      expect(line).toMatch(/^claude plugin install [\w-]+@[\w-]+$/);
    }
  });
});
