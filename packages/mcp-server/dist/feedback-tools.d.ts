/**
 * The retrieval-feedback tool.
 *
 * Extracted from index.ts to keep the composition root below the
 * 500-line cap (rules/coding-standards.md §4.1).
 *
 * `coordinate_context_budget` was registered here until #120. It had no
 * effect on a run: the pipeline asks Cortex for 8 results per section
 * whatever the tool answered, and the figures it answered were unsourced and
 * would have asked for more, not less (decision and measurement on the
 * issue).
 */
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
export declare function registerFeedbackTools(server: McpServer): Record<string, RegisteredTool>;
//# sourceMappingURL=feedback-tools.d.ts.map