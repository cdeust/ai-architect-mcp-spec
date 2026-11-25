/**
 * Pipeline-tool registration — orchestrator + verification.
 *
 * Adds the new MCP tools that drive the full PRD workflow:
 *
 *   start_pipeline     — initialize a pipeline run, return first NextAction
 *   submit_action_result  — feed an ActionResult to the reducer, return next action
 *   get_pipeline_state — read current state by run_id
 *   plan_section_verification    — emit JudgeRequest[] for a section
 *   plan_document_verification   — emit JudgeRequest[] across all sections
 *   conclude_verification        — aggregate JudgeVerdict[] → VerificationReport
 *
 * The host (Claude Code) drives the loop: call start, execute the action,
 * call submit_action_result with the result, repeat until `done`.
 */

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStartPipeline } from "./tools/start-pipeline.js";
import { registerSubmitActionResult } from "./tools/submit-action-result.js";
import { registerGetPipelineState } from "./tools/get-pipeline-state.js";
import { registerPlanVerificationTools } from "./tools/plan-verification.js";
import { registerConcludeVerification } from "./tools/conclude-verification.js";

export function registerPipelineTools(server: McpServer): Record<string, RegisteredTool> {
  return {
    start_pipeline: registerStartPipeline(server),
    submit_action_result: registerSubmitActionResult(server),
    get_pipeline_state: registerGetPipelineState(server),
    ...registerPlanVerificationTools(server),
    conclude_verification: registerConcludeVerification(server),
  };
}
