import { makeCannedDispatcher } from "@prd-gen/orchestration";
import type { Ports } from "./types.js";

const dispatch = makeCannedDispatcher();
export const cannedAnswer: Ports["answer"] = question => {
  const result = dispatch(question);
  if (result?.kind !== "user_answer") throw new Error("Expected a canned answer");
  return result;
};

export const cannedInvoke: Ports["invoke"] = async inv => {
  const result = dispatch({ kind: "spawn_subagents", batch_id: "dry-run", purpose: inv.purpose, invocations: [inv] });
  const text = result?.kind === "subagent_batch_result" && result.responses[0].raw_text;
  if (typeof text !== "string") throw new Error("Expected a canned subagent response");
  return { text, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    cost_usd: 0, duration_ms: 0, model_reported: "canned" } };
};
