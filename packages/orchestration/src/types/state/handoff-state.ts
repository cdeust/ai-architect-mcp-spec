import { z } from "zod";
import { DefineHandoffV1Schema, JiraResultSchema } from "@prd-gen/core";

/**
 * The checkpoint fields the architect-os handoff reads.
 * - jira_result: absent on checkpoints made by the Markdown-only ticket generator.
 * - passed_define: the Define projection that passed when the gate advanced
 *   (define-handoff.ts withPassedDefine).
 */
export const HandoffStateFields = {
  jira_result: JiraResultSchema.optional(),
  passed_define: z.strictObject({ handoff: DefineHandoffV1Schema, intent: z.string() }).optional(),
};

/** A kept Define belongs to the run that keeps it. */
export function passedDefineInRun(s: { run_id: string; passed_define?: { handoff: { run_id: string } } }): boolean {
  return !s.passed_define || s.passed_define.handoff.run_id === s.run_id;
}
export const PASSED_DEFINE_FOREIGN = "PipelineState: passed_define belongs to another run.";
