import type { McpServer, RegisteredTool, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  isLegacyExecutionCheckpoint,
  isRetiredImplementationAnswer,
  recordLegacyDefineRefusal,
  step,
  ActionResultSchema,
  // ActionResult (the type) is not imported: the tool declares its input via
  // ActionResultSchema directly (see the schema below), so zod infers
  // the shape and a separate type import would be a second source of truth.
} from "@prd-gen/orchestration";
import { drainEvidenceQueues } from "../evidence-drain.js";
import { boundEnvelopeResponse } from "../bound-envelope-action.js";
import { inFlight, runs, runNotFound, architectOsRequired, envelope } from "../pipeline-runs.js";

const submitActionResultInput = () => ({
  run_id: z.string(),
  // Use the canonical ActionResultSchema directly. Pre-fix this duplicated
  // the discriminated union inline; adding a new ActionResult kind would
  // have required updating both the canonical schema in orchestration AND
  // this inline copy with no compile-time enforcement of synchrony
  // (cross-audit feynman HIGH-1, Phase 3+4 follow-up, 2026-04).
  result: ActionResultSchema,
});

const handleSubmitActionResult: ToolCallback<ReturnType<typeof submitActionResultInput>> =
  async ({ run_id, result }) => {
    if (inFlight.has(run_id)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `concurrent submission rejected for run_id ${run_id}`,
            }),
          },
        ],
        isError: true,
      };
    }
    inFlight.add(run_id);
    try {
      const found = runs.find(run_id);
      if (found.kind !== "found") return runNotFound(run_id, found);
      if (isLegacyExecutionCheckpoint(found.run.state, found.run.action) ||
          isRetiredImplementationAnswer(found.run.state, result)) return architectOsRequired();
      const { state, action } = found.run;
      // A finished run whose terminal action carries its verdict (automatic
      // review, or a kept Define) answers a retried submission with that
      // action: re-stepping would replace it with a bare "already complete".
      const out = (state.semantic_review_requested || state.passed_define) && state.current_step === "complete" && action
        ? { state, action, messages: [] }
        : step({ state: recordLegacyDefineRefusal(state, action), result });
      // Drain the evidence queues BEFORE the state is kept: a state on
      // disk has empty queues, so a run that comes back after a restart
      // writes nothing twice. drainEvidenceQueues is a no-op when the
      // queues are empty.
      const drained = drainEvidenceQueues(out.state);
      // With the UNBOUNDED action: see start_pipeline's identical comment.
      runs.keep(drained, out.action);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              boundEnvelopeResponse(envelope(drained, out.action, out.messages)),
              null,
              2,
            ),
          },
        ],
      };
    } finally {
      inFlight.delete(run_id);
    }
  };

export function registerSubmitActionResult(server: McpServer): RegisteredTool {
  return server.tool(
    "submit_action_result",
    "Feed an ActionResult to the pipeline runner; receive the next NextAction.",
    submitActionResultInput(),
    { destructiveHint: true },
    handleSubmitActionResult,
  );
}
