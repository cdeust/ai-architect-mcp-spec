import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { claudeArgs, parseClaudeResult } from "../real-run/claude-cli-invoker.js";

const fixture = readFileSync(new URL("./fixtures/claude-cli-result.json", import.meta.url), "utf8");

it("reads the recorded Haiku accounting fields", () => {
  expect(parseClaudeResult(fixture)).toEqual({ text: "ok", error: undefined, usage: {
    input_tokens: 2, output_tokens: 4, cache_read_tokens: 649, cache_creation_tokens: 3122,
    cost_usd: 0.0006330900000000001, duration_ms: 1557, model_reported: "claude-haiku-5-5",
  } });
});

it("distinguishes missing cost, reported failures and invalid output", () => {
  const r = JSON.parse(fixture);
  delete r.total_cost_usd;
  expect(parseClaudeResult(JSON.stringify(r)).usage.cost_usd).toBeNull();
  r.is_error = true;
  expect(parseClaudeResult(JSON.stringify(r))).toMatchObject({ error: expect.any(String), usage: { input_tokens: 2 } });
  delete r.usage;
  expect(() => parseClaudeResult(JSON.stringify(r))).toThrow();
  expect(() => parseClaudeResult("no JSON")).toThrow();
});

it("disables tools and settings and only passes explicit model and effort selections", () => {
  const isolation = ["--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", ""];
  expect(claudeArgs({ model: "session", effort: "session" })).toEqual(["-p", "--output-format", "json", ...isolation]);
  expect(claudeArgs({ model: "sonnet", effort: "medium" })).toEqual([
    "-p", "--output-format", "json", "--model", "sonnet", "--effort", "medium", ...isolation]);
});
