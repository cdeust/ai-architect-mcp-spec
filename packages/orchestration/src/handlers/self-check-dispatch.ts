import { agentSubagentType, type JudgeRequest } from "@prd-gen/core";
import { buildBatchedJudgePrompt } from "@prd-gen/verification";
import type { NextAction } from "../types/actions.js";
import type { PipelineState, VerifyBudgetConfig } from "../types/state.js";
import { buildJudgeIndex, groupJudgeIndex } from "./self-check-verdicts.js";

export const VERIFY_BATCH_ID = "self_check_verify";

/**
 * precondition:  `requests` is the FINAL request set — already reduced
 *                (reduceJudgeRequests) and, if the budget gate fired,
 *                sampled or explicitly overridden. This function performs
 *                no further filtering.
 * postcondition: one spawn_subagents invocation per (judge, model) batch of
 *                buildJudgeIndex, in order of first appearance: the judge
 *                sees all its claims in one prompt that embeds the PRD once
 *                (issue #119). Each invocation carries `model`/`effort` —
 *                `model` comes from assignJudgeModels (architecture claims
 *                cycle through `config.diversity_models`; every other claim
 *                dispatches under `config.diversity_models[0]`) — no judge
 *                invocation is dispatched under the session model by default
 *                (source: measured e2e run run_mrlqa0aj_u2rh15; see
 *                self-check-verify-budget.ts module doc).
 */
function buildVerifyAction(
  requests: readonly JudgeRequest[],
  config: VerifyBudgetConfig,
): NextAction {
  return {
    kind: "spawn_subagents",
    purpose: "judge",
    batch_id: VERIFY_BATCH_ID,
    invocations: groupJudgeIndex(buildJudgeIndex(requests, config)).map((group) => {
      const built = buildBatchedJudgePrompt(group.map((e) => e.request));
      return {
        invocation_id: group[0].invocation_id,
        subagent_type: agentSubagentType(group[0].request.judge),
        description: built.description,
        prompt: built.prompt,
        isolation: "none" as const,
        model: group[0].model,
        effort: config.judge_effort,
      };
    }),
  };
}

/**
 * Assemble the snapshot + spawn_subagents action for a final invocation set.
 *
 * precondition:  `requests` is non-empty and already reduced/sampled.
 * postcondition: verification_plan.claim_ids/judges are parallel arrays,
 *                index-aligned with the final request set (invariant enforced
 *                by VerificationPlanSnapshotSchema's refine); several requests
 *                share one invocation when buildJudgeIndex batches them.
 */
export function dispatchVerify(
  state: PipelineState,
  requests: readonly JudgeRequest[],
  config: VerifyBudgetConfig,
  sampled: boolean,
) {
  return {
    state: {
      ...state,
      verification_plan: {
        batch_id: VERIFY_BATCH_ID,
        claim_ids: requests.map((r) => r.claim.claim_id),
        judges: requests.map((r) => r.judge),
        sampled,
      },
    },
    action: buildVerifyAction(requests, config),
  };
}
