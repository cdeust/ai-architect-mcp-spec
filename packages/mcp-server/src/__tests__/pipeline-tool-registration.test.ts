import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import { registerPipelineTools } from "../pipeline-tools.js";
import { startStdioServer } from "./stdio-server.js";

const PIPELINE_TOOLS = [
  "start_pipeline",
  "submit_action_result",
  "get_pipeline_state",
  "plan_section_verification",
  "plan_document_verification",
  "conclude_verification",
];

it("registers the same six descriptors in source and in the built stdio server", async () => {
  const server = new McpServer({ name: "pipeline-registration-test", version: "0" });
  const client = new Client({ name: "pipeline-registration-client", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const registered = registerPipelineTools(server);
  const reference = await startStdioServer(undefined, { args: ["--profile", "full"] });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await reference.requestResult("tools/list", {}) as ListToolsResult;
    expect(Object.keys(registered)).toEqual(PIPELINE_TOOLS);
    expect((await client.listTools()).tools).toEqual(
      listed.tools.filter(({ name }) => PIPELINE_TOOLS.includes(name)),
    );
  } finally {
    await client.close();
    await server.close();
    await reference.close();
  }
});
