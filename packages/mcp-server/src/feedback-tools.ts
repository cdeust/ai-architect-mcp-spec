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
import { z } from "zod";
import { HardOutputRuleViolationSchema } from "@prd-gen/core";
import { mapFailuresToRetrievals } from "./failure-mapper.js";

export function registerFeedbackTools(server: McpServer): Record<string, RegisteredTool> {
  const mapFailureToRetrieval = server.tool(
    "map_failure_to_retrieval",
    "When validate_prd_section returns violations, call this to get corrective Cortex recall queries. Closes the validation→retrieval feedback loop so retries use better context.",
    {
      // Validate at the MCP boundary using the canonical domain schema
      // (HardOutputRuleViolationSchema). Pre-fix this used a hand-written
      // loose schema and an `as any` cast at the call site, defeating the
      // type system at the layer boundary (cross-audit code-reviewer C3 +
      // dijkstra §3.2, Phase 3+4, 2026-04).
      violations: z
        .array(HardOutputRuleViolationSchema)
        .describe("Violations from validate_prd_section"),
    },
    { readOnlyHint: true },
    async ({ violations }) => {
      // No cast required: Zod has already parsed violations into the exact
      // shape mapFailuresToRetrievals expects.
      const result = mapFailuresToRetrievals(violations);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  return {
    map_failure_to_retrieval: mapFailureToRetrieval,
  };
}
