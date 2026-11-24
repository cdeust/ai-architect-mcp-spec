import { type CallToolResult, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { makeCannedDispatcher, NextActionSchema } from "@prd-gen/orchestration";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startStdioServer, type StdioServer } from "./stdio-server.js";

let server: StdioServer;

beforeAll(async () => {
  server = await startStdioServer(undefined, {
    args: ["--profile", "full"],
    unset: ["PRD_GEN_SEMANTIC_REVIEW_MODEL", "PRD_MAX_CONCURRENT_RUNS"],
  });
});

afterAll(async () => {
  await server?.close();
});

async function callTool(name: string, args: Record<string, unknown>) {
  return await server.requestResult("tools/call", { name, arguments: args }) as CallToolResult;
}

function normalizedResult(result: CallToolResult, runId?: string) {
  return {
    ...result,
    content: result.content.map(part => {
      if (part.type !== "text") return part;
      const text = runId === undefined ? part.text : part.text.replaceAll(runId, "<run_id>");
      return { ...part, text: text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>") };
    }),
  };
}

it("lists the complete MCP tool descriptors", async () => {
  const result = await server.requestResult("tools/list", {}) as ListToolsResult;
  expect(result.tools).toHaveLength(16);
  expect(result).toMatchSnapshot();
});

it("starts, reads and advances the same run through stdio", async () => {
  const started = await callTool("start_pipeline", {
    feature_description: "Add a copy button to each configuration example.",
    skip_preflight: true,
    prd_context: "feature",
    request_size: "tiny",
  });
  const part = started.content[0];
  if (started.isError || part?.type !== "text") throw new Error("Expected a pipeline start envelope");
  const { run_id, action } = JSON.parse(part.text) as { run_id: string; action: unknown };
  expect(run_id).toMatch(/^run_[a-z0-9]+_[a-z0-9]+$/);
  expect(normalizedResult(started, run_id)).toMatchSnapshot("start_pipeline");

  const result = makeCannedDispatcher()(NextActionSchema.parse(action));
  expect(result).toBeDefined();
  const submitted = await callTool("submit_action_result", { run_id, result });
  expect(submitted.isError).toBeFalsy();
  expect(normalizedResult(submitted, run_id)).toMatchSnapshot("submit_action_result");

  const state = await callTool("get_pipeline_state", { run_id, format: "summary" });
  expect(state.isError).toBeFalsy();
  expect(normalizedResult(state, run_id)).toMatchSnapshot("get_pipeline_state");
});

it("plans section and document verification and concludes a verdict through stdio", async () => {
  const content = "- FR-001: Copying a configuration example MUST preserve its exact contents.";
  const section = await callTool("plan_section_verification", { section_type: "requirements", content });
  expect(section.isError).toBeFalsy();
  expect(section).toMatchSnapshot("plan_section_verification");

  const document = await callTool("plan_document_verification", {
    sections: [
      { type: "requirements", content },
      { type: "testing", content: "Compare the copied configuration with the original example." },
    ],
  });
  expect(document.isError).toBeFalsy();
  expect(document).toMatchSnapshot("plan_document_verification");

  const report = await callTool("conclude_verification", {
    scope: "section",
    section_type: "requirements",
    verdicts: [{
      judge: { kind: "team", name: "engineer" },
      claim_id: "FR-001",
      verdict: "PASS",
      rationale: "The requirement specifies what must be preserved.",
      caveats: [],
      confidence: 0.9,
    }],
  });
  expect(report.isError).toBeFalsy();
  expect(normalizedResult(report)).toMatchSnapshot("conclude_verification");
});

it.each<[string, Record<string, unknown>]>([
  ["start_pipeline", {}],
  ["submit_action_result", { run_id: "run_unknown_checkpoint" }],
  ["get_pipeline_state", {}],
  ["plan_section_verification", { section_type: "not_a_section", content: "example" }],
  ["plan_document_verification", { sections: [] }],
  ["conclude_verification", { verdicts: "not a list" }],
])("pins the invalid argument response for %s", async (name, args) => {
  const result = await callTool(name, args);
  expect(result.isError).toBe(true);
  expect(result).toMatchSnapshot();
});
