/**
 * The runs of the server (#121): in memory while they are used, and each in
 * a file of its own, so that a restart of the server does not lose them.
 *
 * The memory side is the run store as it was (TTL and cap on finished runs,
 * run-store.ts) with the pending action of each run beside it. The file side
 * (run-files.ts) follows it: a run is written each time it is kept, read when
 * a tool names a run the memory does not hold, and removed when the run store
 * drops the run. The first use applies the run store's two bounds to the
 * files left by earlier server processes.
 */
import { type Clock, type NextAction, type PipelineState } from "@prd-gen/orchestration";
import type { KeptRun, RunFiles } from "./run-files.js";
export type FoundRun = {
    readonly kind: "found";
    readonly run: KeptRun;
} | {
    readonly kind: "unknown";
} | {
    readonly kind: "unreadable";
    readonly reason: string;
};
export interface KeptRunsOptions {
    /** Called once per run dropped from memory, after its file is removed. */
    readonly onDrop?: (runId: string) => void;
    /** Where a state that could not be written is reported. */
    readonly warn?: (message: string) => void;
    readonly ttlMs?: number;
    readonly maxRuns?: number;
    readonly clock?: Clock;
}
export declare class KeptRuns {
    private readonly files;
    private readonly options;
    private readonly store;
    private readonly actions;
    private readonly warned;
    private swept;
    constructor(files: RunFiles, options?: KeptRunsOptions);
    /**
     * precondition:  `action` is the action `step()` returned with `state`.
     * postcondition: the run is in memory with its action, and in its file. A
     *                file that cannot be written does not stop the run: it is
     *                said once per cause, and the run stays in memory only.
     */
    keep(state: PipelineState, action: NextAction): void;
    /**
     * postcondition: `found` with the state and the pending action of the run,
     *                from memory, or from its file when the memory does not
     *                hold it (the run is then in memory again); `unknown` when
     *                neither does; `unreadable` when the file is there and is
     *                not a run of this id, which is not the same answer as
     *                `unknown`: the file is left for whoever looks into it.
     */
    find(runId: string): FoundRun;
    /** The runs in memory that have not reached their last step. */
    inFlightCount(): number;
    private sweepOnce;
    private warnOnce;
}
//# sourceMappingURL=kept-runs.d.ts.map