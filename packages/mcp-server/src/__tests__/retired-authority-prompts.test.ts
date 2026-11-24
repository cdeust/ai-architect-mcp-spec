import { readFileSync } from "node:fs";
import { initialPostSpecs, newPipelineState } from "@prd-gen/orchestration";
import { expect, it } from "vitest";
import { handleFinalize } from "../../../orchestration/src/handlers/finalize.js";
import { RUNS_DIR, RunFiles } from "../run-files.js";
import { startStdioServer } from "./stdio-server.js";

const historicalPrStatus = "PR: not opened (declined at the gate, or publication failed).";
// source: MCP Vitest config's cold-start allowance for the server dependency graph.
const checkpointTimeoutMs = 60_000;

function historicalCompletion(run_id: string) {
  return {
    ...newPipelineState({ run_id, feature_description: "Resume a legacy result" }),
    current_step: "finalize" as const,
    pending_completion: { summary: "Specification complete", artifacts: [] },
    post_specs: { ...initialPostSpecs(), pr: { pushed: false, url: null } },
  };
}

it("ships no retired publication commands or claim of human approval", () => {
  const bundle = readFileSync(new URL("../../../../mcp-server/index.js", import.meta.url), "utf8");
  const phrases = [["ALREADY", "approved"].join(" "), "gh pr create", "git push"];
  expect(phrases.filter((phrase) => bundle.includes(phrase))).toEqual([]);
});

it("refuses submitted results for all four retired steps over MCP stdio", async () => {
  const checkpoints = [
    ["implementation", "run_retired_implementation"],
    ["testing", "run_retired_testing"],
    ["review", "run_retired_review"],
    ["pr_creation", "run_retired_prcreation"],
  ] as const;
  const files = new RunFiles(RUNS_DIR);
  for (const [current_step, run_id] of checkpoints) {
    // Older state-only checkpoints have no saved action to identify the step.
    files.write({ ...newPipelineState({ run_id, feature_description: "Legacy execution" }), current_step }, null);
  }

  const server = await startStdioServer();
  try {
    for (const [current_step, run_id] of checkpoints) {
      const response = await server.call("submit_action_result", {
        run_id,
        result: { kind: "subagent_batch_result", batch_id: "legacy_batch", responses: [] },
      });
      expect(response.isError, `${current_step}: ${response.text}`).toBe(true);
      expect(JSON.parse(response.text), current_step).toMatchObject({
        error: { code: "architect_os_required" },
      });
    }
  } finally {
    await server.close();
  }
}, checkpointTimeoutMs);

it("resumes a legacy finalize checkpoint and records the unpublished PR over MCP stdio", async () => {
  const run_id = "run_historical_status";
  new RunFiles(RUNS_DIR).write(historicalCompletion(run_id), null);
  const server = await startStdioServer();
  try {
    const replay = await server.call("submit_action_result", {
      run_id,
      result: { kind: "tool_result", correlation_id: "previous_action", success: true, data: {} },
    });
    expect(replay.isError, replay.text).toBe(false);
    const { action } = JSON.parse(replay.text);
    expect(action).toMatchObject({
      kind: "call_cortex_tool",
      tool_name: "remember",
      arguments: { content: expect.stringContaining(historicalPrStatus) },
    });
    const result = await server.call("submit_action_result", {
      run_id,
      result: { kind: "tool_result", correlation_id: action.correlation_id, success: true, data: {} },
    });
    expect(result.isError, result.text).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ current_step: "complete", action: { kind: "done" } });
  } finally {
    await server.close();
  }
}, checkpointTimeoutMs);

it.each([
  { pr: { pushed: false, url: null }, status: historicalPrStatus },
  { pr: { pushed: true, url: "https://example.com/pull/1" }, status: "PR: opened at https://example.com/pull/1." },
])("records the historical PR status when pushed is $pr.pushed", ({ pr, status }) => {
  const checkpoint = historicalCompletion("run_historical_summary");
  const state = { ...checkpoint, post_specs: { ...checkpoint.post_specs, pr } };
  expect(handleFinalize({ state }).action).toMatchObject({
    kind: "call_cortex_tool",
    tool_name: "remember",
    arguments: { content: expect.stringContaining(status) },
  });
});
