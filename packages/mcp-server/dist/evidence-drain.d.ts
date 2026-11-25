import type { PipelineState } from "@prd-gen/orchestration";
/**
 * The three queues the reducer fills for the evidence and reliability
 * stores, emptied before a state is stored. A repository is asked for only
 * when its queue holds something.
 */
export declare function drainEvidenceQueues(state: PipelineState): PipelineState;
//# sourceMappingURL=evidence-drain.d.ts.map