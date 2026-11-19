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
  r.is_error = false;
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

it("keeps the subtype, error text and reported billing without a result or model", () => {
  const failure = { type: "result", subtype: "error_during_execution", is_error: true,
    errors: ["service unavailable"], modelUsage: {}, total_cost_usd: 0.42,
    usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  const result = parseClaudeResult(JSON.stringify(failure));
  expect(result.error).toContain(failure.subtype);
  expect(result.error).toContain("service unavailable");
  expect(result.usage).toMatchObject({ cost_usd: 0.42, input_tokens: 3, output_tokens: 1 });
});

it("recognizes an error envelope without any usable metering", () => {
  const failure = { type: "result", subtype: "error_max_turns", is_error: true, modelUsage: {} };
  expect(parseClaudeResult(JSON.stringify(failure))).toMatchObject({
    text: "", error: expect.stringContaining("error_max_turns"), usage: null,
  });
});

it("retains each mixed model's own counters independently of the top-level totals", () => {
  const r = JSON.parse(fixture);
  const first = r.modelUsage["claude-haiku-5-5"];
  r.modelUsage.second = { ...first, inputTokens: 123, costUSD: 0.75 };
  const { usage } = parseClaudeResult(JSON.stringify(r));
  expect(usage).toMatchObject({ input_tokens: 2, cost_usd: r.total_cost_usd, per_model: {
    "claude-haiku-5-5": { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 649,
      cacheCreationInputTokens: 3122, costUSD: first.costUSD },
    second: { inputTokens: 123, costUSD: 0.75 },
  } });
});
