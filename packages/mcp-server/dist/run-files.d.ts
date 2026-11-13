import { type NextAction, type PipelineState } from "@prd-gen/orchestration";
/** Where the server keeps its runs: beside its databases. */
export declare const RUNS_DIR: string;
export interface KeptRun {
    readonly state: PipelineState;
    /** The action the host has to execute next; null when none was kept. */
    readonly action: NextAction | null;
}
export type RunFileRead = {
    readonly kind: "found";
    readonly run: KeptRun;
} | {
    readonly kind: "absent";
} | {
    readonly kind: "unreadable";
    readonly reason: string;
};
export interface SweepBounds {
    /** A finished run is dropped once its file is older than this. */
    readonly ttlMs: number;
    /** At most this many run files are left. */
    readonly maxRuns: number;
    readonly now: number;
}
export declare class RunFiles {
    private readonly dir;
    constructor(dir: string);
    /**
     * postcondition: the path of the file of run `runId`, or null when `runId`
     *                is not of the form the server generates.
     */
    pathOf(runId: string): string | null;
    /**
     * precondition:  `state.run_id` is an id the server generated.
     * postcondition: the file of the run holds `state` and `action`, whole: it
     *                is written under another name and renamed, so a reader
     *                sees the previous content or this one. The directory and
     *                the file are readable by their owner only.
     * throws:        when the id is not a run id, or the file system refuses.
     */
    write(state: PipelineState, action: NextAction | null): void;
    /**
     * postcondition: `found` with the state and the action of the file, both
     *                checked against their schemas; `absent` when `runId` is
     *                not a run id or has no file; `unreadable`, with the
     *                reason, when the file is there and is not a run of this
     *                version under this id. Nothing is written or removed.
     */
    read(runId: string): RunFileRead;
    /**
     * postcondition: run `runId` has no file, unless the file system refuses;
     *                a file left that way is removed by a later sweep. Never
     *                throws: this runs while a run is dropped from memory.
     */
    remove(runId: string): void;
    /**
     * Applies to the files the bounds the run store applies to memory.
     *
     * postcondition: no file of a finished run, and no partial file, is older
     *                than `ttlMs`; at most `maxRuns` run files are left, the
     *                most recently written. Returns the number of files
     *                removed. A file that cannot be read as JSON is not a
     *                finished run: it is kept until the cap removes it. A
     *                file the file system refuses to remove is left, and the
     *                sweep goes on: this never throws, so that the first tool
     *                call of a server does not fail on a leftover.
     */
    sweep(bounds: SweepBounds): number;
    private list;
}
//# sourceMappingURL=run-files.d.ts.map