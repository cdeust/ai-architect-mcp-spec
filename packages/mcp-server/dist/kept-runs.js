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
import { InMemoryRunStore, RUN_STORE_MAX_RUNS, RUN_STORE_TTL_MS, isTerminalRun, } from "@prd-gen/orchestration";
export class KeptRuns {
    files;
    options;
    store;
    actions = new Map();
    warned = new Set();
    swept = false;
    constructor(files, options = {}) {
        this.files = files;
        this.options = options;
        this.store = new InMemoryRunStore({
            ttlMs: options.ttlMs,
            maxRuns: options.maxRuns,
            clock: options.clock,
            onEvict: (runId) => {
                this.actions.delete(runId);
                this.files.remove(runId);
                options.onDrop?.(runId);
            },
        });
    }
    /**
     * precondition:  `action` is the action `step()` returned with `state`.
     * postcondition: the run is in memory with its action, and in its file. A
     *                file that cannot be written does not stop the run: it is
     *                said once per cause, and the run stays in memory only.
     */
    keep(state, action) {
        this.sweepOnce();
        this.store.set(state);
        this.actions.set(state.run_id, action);
        try {
            this.files.write(state, action);
        }
        catch (error) {
            this.warnOnce(String(error.code ?? error), state.run_id, error);
        }
    }
    /**
     * postcondition: `found` with the state and the pending action of the run,
     *                from memory, or from its file when the memory does not
     *                hold it (the run is then in memory again); `unknown` when
     *                neither does; `unreadable` when the file is there and is
     *                not a run of this id, which is not the same answer as
     *                `unknown`: the file is left for whoever looks into it.
     */
    find(runId) {
        this.sweepOnce();
        const state = this.store.get(runId);
        if (state !== undefined)
            return { kind: "found", run: { state, action: this.actions.get(runId) ?? null } };
        const read = this.files.read(runId);
        if (read.kind === "absent")
            return { kind: "unknown" };
        if (read.kind === "unreadable")
            return read;
        this.store.set(read.run.state);
        if (read.run.action !== null)
            this.actions.set(runId, read.run.action);
        return read;
    }
    /** The runs in memory that have not reached their last step. */
    inFlightCount() {
        return this.store.list().filter((state) => !isTerminalRun(state)).length;
    }
    sweepOnce() {
        if (this.swept)
            return;
        this.swept = true;
        this.files.sweep({
            ttlMs: this.options.ttlMs ?? RUN_STORE_TTL_MS,
            maxRuns: this.options.maxRuns ?? RUN_STORE_MAX_RUNS,
            now: (this.options.clock ?? Date.now)(),
        });
    }
    warnOnce(cause, runId, error) {
        if (this.warned.has(cause))
            return;
        this.warned.add(cause);
        const warn = this.options.warn ?? ((message) => console.error(message));
        warn(`[prd-gen] the state of run ${runId} could not be written (${String(error)}); ` +
            "runs stay in memory only and do not survive a restart of the server.");
    }
}
//# sourceMappingURL=kept-runs.js.map