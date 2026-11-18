/**
 * MCP contract of the `prd_context` input of start_pipeline (#119, slice 3).
 *
 * Drives a real MCP Client over an in-memory transport against the production
 * registerPipelineTools, so the registered input schema and its forwarding to
 * the reducer are exercised through the protocol: a declared context reaches
 * the run state, an omitted one is detected from the description as before, and a
 * value outside PRDContextSchema is refused before any run starts.
 *
 * source: Codex review of #356 (P1, "Add MCP contract tests for the new
 * context input"); AGENTS.md review guideline on observable behavior.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerPipelineTools } from "../pipeline-tools.js";

let client: Client;

beforeAll(async () => {
  const server = new McpServer({ name: "test", version: "0" });
  registerPipelineTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
});

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function stateOf(run_id: string): Promise<Record<string, unknown>> {
  const res = await call("get_pipeline_state", { run_id, format: "full" });
  expect(res.isError).toBeFalsy();
  const body = JSON.parse(res.content[0].text) as Record<string, unknown>;
  return (body.state ?? body) as Record<string, unknown>;
}

async function start(args: Record<string, unknown>): Promise<string> {
  const res = await call("start_pipeline", { skip_preflight: true, ...args });
  expect(res.isError).toBeFalsy();
  const run_id = (JSON.parse(res.content[0].text) as { run_id?: string }).run_id;
  expect(typeof run_id).toBe("string");
  return run_id as string;
}

describe("start_pipeline prd_context over MCP (#119)", () => {
  it("lists prd_context as an optional input of start_pipeline", async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "start_pipeline")?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty("prd_context");
    expect(schema.required ?? []).not.toContain("prd_context");
  });

  it("forwards a declared context to the run, over the trigger words of the description", async () => {
    // "build" and "feature" would detect `feature`.
    const run_id = await start({ feature_description: "build a feature: copy button", prd_context: "tiny" });
    expect((await stateOf(run_id)).prd_context).toBe("tiny");
  });

  it("detects the context from the description when prd_context is omitted", async () => {
    // start_pipeline steps through context_detection before it answers.
    const run_id = await start({ feature_description: "build a feature: copy button" });
    expect((await stateOf(run_id)).prd_context).toBe("feature");
  });

  it("refuses a context outside PRDContextSchema", async () => {
    let refused: boolean;
    try {
      const res = await call("start_pipeline", {
        feature_description: "build a feature: copy button",
        skip_preflight: true,
        prd_context: "huge",
      });
      refused = res.isError === true;
    } catch {
      refused = true; // SDK versions that raise the validation error as McpError
    }
    expect(refused).toBe(true);
  });
});
