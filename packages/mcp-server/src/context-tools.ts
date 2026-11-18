/**
 * The lookup of a kind of PRD: `get_prd_context_info`.
 *
 * Registered here, apart from the composition root, so the contract of the
 * tool is tested through the protocol (context-tools.test.ts). Its input is
 * the list of kinds start_pipeline reads (PRDContextSchema): a kind a run can
 * be started with is a kind this tool answers for.
 */
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PRD_CONTEXT_CONFIGS, PRDContextSchema } from "@prd-gen/core";

/**
 * postcondition: `get_prd_context_info` is registered on `server`; the handle
 *                is returned by its tool name.
 */
export function registerContextTools(server: McpServer): Record<string, RegisteredTool> {
  const getPrdContextInfo = server.tool(
    "get_prd_context_info",
    "Get configuration for a specific PRD context type",
    { context: PRDContextSchema.describe("The PRD context type") },
    { readOnlyHint: true },
    async ({ context }) => ({
      content: [{ type: "text" as const, text: JSON.stringify(PRD_CONTEXT_CONFIGS[context], null, 2) }],
    }),
  );
  return { get_prd_context_info: getPrdContextInfo };
}
