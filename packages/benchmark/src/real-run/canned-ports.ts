import { makeCannedDispatcher } from "@prd-gen/orchestration";
import type { Invocation } from "./types.js";

const dispatch = makeCannedDispatcher();

export async function cannedInvoke(inv: Invocation) {
  const result = dispatch({
    kind: "spawn_subagents",
    // Stryker disable next-line StringLiteral: equivalent: the dispatcher only echoes batch_id and this adapter reads responses alone.
    batch_id: "dry-run",
    purpose: inv.purpose, invocations: [inv],
  });
  const text = result?.kind === "subagent_batch_result" && result.responses[0].raw_text;
  if (typeof text !== "string") throw new Error("Expected a canned subagent response");
  return { text, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    cost_usd: 0, duration_ms: 0, model_reported: "canned" } };
}
