import type { PipelineState } from "./types/state.js";

/**
 * Why a run that attempted tickets cannot hand them off: the gate's findings
 * and the Define projection give the same reason, in the same words.
 */
export function jiraTicketsRefusal(state: PipelineState): string | undefined {
  const jira = state.jira_result;
  return jira?.status === "failed" ? `jira_tickets_${jira.cause}: ${jira.detail}` : undefined;
}
