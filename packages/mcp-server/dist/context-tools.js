import { PRD_CONTEXT_CONFIGS, PRDContextSchema } from "@prd-gen/core";
/**
 * postcondition: `get_prd_context_info` is registered on `server`; the handle
 *                is returned by its tool name.
 */
export function registerContextTools(server) {
    const getPrdContextInfo = server.tool("get_prd_context_info", "Get configuration for a specific PRD context type", { context: PRDContextSchema.describe("The PRD context type") }, { readOnlyHint: true }, async ({ context }) => ({
        content: [{ type: "text", text: JSON.stringify(PRD_CONTEXT_CONFIGS[context], null, 2) }],
    }));
    return { get_prd_context_info: getPrdContextInfo };
}
//# sourceMappingURL=context-tools.js.map