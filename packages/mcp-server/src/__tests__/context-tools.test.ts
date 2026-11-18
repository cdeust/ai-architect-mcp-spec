/**
 * MCP contract of `get_prd_context_info`, over a real MCP Client and an
 * in-memory transport against the production registration. Proves: (1) the
 * tool is registered under its name, read-only, with a described input;
 * (2) its input lists exactly the kinds of PRD a run can be started with;
 * (3) it answers the configuration of each of them; (4) a value that is no
 * kind, a request size included, is refused by name.
 *
 * source: independent review of the #119 follow-up (the tool kept a list of
 * kinds of its own, which could drift from the one start_pipeline reads).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRD_CONTEXT_CONFIGS, PRDContextSchema } from "@prd-gen/core";

import { registerContextTools } from "../context-tools.js";

let client: Client;
let handles: ReturnType<typeof registerContextTools>;

beforeAll(async () => {
  const server = new McpServer({ name: "test", version: "0" });
  handles = registerContextTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
});

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** What the server answers when it refuses the call (as a tool error or a protocol error); null when it accepts it. */
async function refusal(context: string): Promise<string | null> {
  try {
    const res = (await client.callTool({ name: "get_prd_context_info", arguments: { context } })) as ToolResult;
    return res.isError === true ? res.content.map((part) => part.text).join("\n") : null;
  } catch (error) {
    return String((error as Error).message);
  }
}

describe("get_prd_context_info, over MCP", () => {
  it("is registered under its name, read-only, and lists the kinds a run can be started with", async () => {
    expect(Object.keys(handles)).toEqual(["get_prd_context_info"]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_prd_context_info"]);
    const [tool] = tools;
    expect(tool.description).toBe("Get configuration for a specific PRD context type");
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.inputSchema.required).toEqual(["context"]);
    expect(tool.inputSchema.properties?.context).toMatchObject({
      enum: [...PRDContextSchema.options],
      description: "The PRD context type",
    });
  });

  it("answers the configuration of each kind", async () => {
    for (const context of PRDContextSchema.options) {
      const res = (await client.callTool({ name: "get_prd_context_info", arguments: { context } })) as ToolResult;
      expect(res.isError, context).toBeFalsy();
      expect(res.content).toHaveLength(1);
      expect(res.content[0].type).toBe("text");
      expect(res.content[0].text).toBe(JSON.stringify(PRD_CONTEXT_CONFIGS[context], null, 2));
    }
  });

  it("refuses what is no kind of PRD, a request size included", async () => {
    expect(await refusal("tiny")).toContain("context");
    expect(await refusal("huge")).toContain("context");
    expect(await refusal("bug")).toBeNull();
  });
});
