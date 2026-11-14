/**
 * Prompts + profile-gating integration tests (issue #28, criteria 1,2,5,7,8).
 *
 * Drives a real MCP Client over an in-memory transport against a server wired
 * exactly like index.ts (stub tool bodies), so prompts/list, prompts/get, and
 * the disable() gate are exercised through the protocol, not just in-process.
 */
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { registerPrompts } from "../mcp-prompts.js";
import { isAllowed } from "../tool-profiles.js";

// Tools the prompts reference, with descriptions that are the source of truth
// for the prompt step summaries.
const TOOLS: Record<string, string> = {
  get_config: "Get the full skill configuration.",
  read_skill_config: "Read the active skill configuration.",
  check_health: "Check server health.",
  get_prd_context_info: "Describe a PRD context.",
  list_available_strategies: "List generation strategies.",
  validate_prd_section: "Run deterministic validation on one PRD section.",
  validate_prd_document: "Run full document validation including cross-section checks.",
  get_quality_history: "Read historical quality scores.",
  get_strategy_effectiveness: "Read strategy effectiveness.",
  map_failure_to_retrieval: "Map validation failures to retrieval queries.",
  start_pipeline: "Initialize a pipeline run. Returns the first NextAction to execute.",
  get_pipeline_state: "Read the current pipeline state by run_id.",
  submit_action_result: "Feed an ActionResult to the reducer. Returns the next action.",
  plan_section_verification: "Emit JudgeRequest[] for one section.",
  plan_document_verification: "Emit JudgeRequest[] across all sections of the document.",
  conclude_verification: "Aggregate JudgeVerdict[] into a VerificationReport.",
};

function buildServer(): { server: McpServer; handles: Record<string, RegisteredTool> } {
  const server = new McpServer({ name: "test", version: "0" });
  const handles: Record<string, RegisteredTool> = {};
  for (const [name, description] of Object.entries(TOOLS)) {
    handles[name] = server.tool(name, description, {}, { readOnlyHint: true }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
  }
  registerPrompts(server, (name) => handles[name]?.description);
  return { server, handles };
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("prompts/list + prompts/get", () => {
  it("lists both pipeline prompts with fully-specified arguments", async () => {
    const { server } = buildServer();
    const client = await connect(server);
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual(["run_prd_pipeline", "verify_prd_document"]);
    for (const prompt of prompts) {
      for (const arg of prompt.arguments ?? []) {
        expect(arg.name).toBeTruthy();
        expect(arg.description).toBeTruthy(); // human title folded into description
        expect(typeof arg.required).toBe("boolean");
      }
    }
    await client.close();
  });

  it("renders run_prd_pipeline with args and canonical tool summaries (criterion 2)", async () => {
    const { server } = buildServer();
    const client = await connect(server);
    const result = await client.getPrompt({
      name: "run_prd_pipeline",
      arguments: { context: "feature", request: "add SSO login" },
    });
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("feature");
    expect(text).toContain("add SSO login");
    expect(text).toContain("`start_pipeline`");
    // The summary is the first sentence of the tool's own description.
    expect(text).toContain("Initialize a pipeline run.");
    await client.close();
  });

  it("rejects an unknown prompt (criterion 8)", async () => {
    const { server } = buildServer();
    const client = await connect(server);
    await expect(client.getPrompt({ name: "nope", arguments: {} })).rejects.toThrow();
    await client.close();
  });

  it("rejects a missing required argument (criterion 8)", async () => {
    const { server } = buildServer();
    const client = await connect(server);
    await expect(
      client.getPrompt({ name: "run_prd_pipeline", arguments: { context: "feature" } }),
    ).rejects.toThrow();
    await client.close();
  });
});

describe("profile gate: disable() hides AND rejects (criterion 5)", () => {
  it("a disabled tool is absent from tools/list and rejected on call", async () => {
    const { server, handles } = buildServer();
    handles.get_config.disable(); // simulate exclusion under the agent profile
    const client = await connect(server);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("get_config");

    // Calling the excluded tool is rejected: an error result naming it as
    // disabled, NOT the tool's normal output — it is gated, not merely hidden.
    const call = (await client.callTool({ name: "get_config", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(call.isError).toBe(true);
    expect(call.content[0].text).toContain("disabled");

    // A still-enabled tool remains listed.
    const { tools: after } = await client.listTools();
    expect(after.map((t) => t.name)).toContain("start_pipeline");
    await client.close();
  });

  it("verifier advertises only its two validators and rejects an excluded call", async () => {
    const { server, handles } = buildServer();
    for (const [name, handle] of Object.entries(handles)) {
      if (!isAllowed("verifier", name)) handle.disable();
    }
    const client = await connect(server);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "validate_prd_document",
      "validate_prd_section",
    ]);

    const call = (await client.callTool({ name: "start_pipeline", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(call.isError).toBe(true);
    expect(call.content[0].text).toContain("disabled");
    await client.close();
  });
});

describe("resources interop shim (criterion 6)", () => {
  it("resources/list and templates answer empty when the shim is installed", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    server.server.registerCapabilities({ resources: {} });
    // Minimal inline shim mirroring index.ts.
    const { ListResourcesRequestSchema, ListResourceTemplatesRequestSchema } = await import(
      "@modelcontextprotocol/sdk/types.js"
    );
    server.server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
    server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
      resourceTemplates: [],
    }));
    const client = await connect(server);
    expect((await client.listResources()).resources).toEqual([]);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
    await client.close();
  });
});
