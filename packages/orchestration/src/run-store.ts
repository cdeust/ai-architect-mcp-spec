/**
 * In-memory store of pipeline runs, keyed by run_id.
 *
 * This is the memory side only. Since #121 the composition root keeps each
 * run in a file as well, so that a restart of the server does not lose it
 * (mcp-server, kept-runs.ts): it writes the file when it sets a run here,
 * reads it when a run is not here, and removes it when this store evicts
 * the run. The two bounds below are exported for that file side.
 *
 * Bounded-I/O (Phase 3): without eviction the map grows once per
 * start_pipeline for the life of the process — a long-lived MCP host that
 * starts many runs leaks every terminal run's PipelineState forever. This
 * store now evicts TERMINAL runs (current_step === "complete") by TTL and by
 * a max-runs cap (LRU on last access). In-flight runs are NEVER evicted —
 * dropping an active run would strand the host mid-loop. Eviction is
 * observable (evicted counter + onEvict callback) — never silent loss,
 * mirroring appendError's errors_dropped (Phase 1c rule).
 */

import type { PipelineState } from "./types/state.js";
// MAX_RESPONSE_CHARS is the measured per-run serialization budget — the basis
// for the resident-memory ceiling the max-runs cap enforces.
import { MAX_RESPONSE_CHARS } from "./types/state.js";

export interface RunStore {
  get(runId: string): PipelineState | undefined;
  set(state: PipelineState): void;
  delete(runId: string): void;
  list(): readonly PipelineState[];
}

/**
 * Injectable clock so TTL eviction is testable without sleeping.
 * Default is `Date.now`. Tests pass a mutable fake.
 * source: ADR-006 sibling pattern (inject time for deterministic tests);
 * mirrors the get_pipeline_state bounded-I/O tests that never sleep.
 */
export type Clock = () => number;

/**
 * A run is evictable only when it has reached the terminal step. The runner
 * sets current_step to "complete" when the pipeline finishes (see runner.ts:
 * the `complete` handler and the coalescing boundary). There is no separate
 * "failed" terminal step — a run that errors stays in-flight until it either
 * reaches "complete" or is abandoned by the host. Treating only "complete" as
 * evictable is the conservative choice: we never drop a run the host might
 * still be driving.
 *
 * source: PipelineStepSchema terminal value "complete" in state.ts.
 */
export function isTerminalRun(state: Pick<PipelineState, "current_step">): boolean {
  return state.current_step === "complete";
}

/**
 * TTL for a terminal run before it becomes eligible for eviction.
 *
 * A terminal PipelineState is read back by the host (get_pipeline_state) after
 * the run finishes — to fetch the final PRD, grounding, or self-check verdict.
 * The TTL must outlive that read-back window but not pin terminal state for the
 * whole process lifetime. 30 minutes is the engineering default.
 *
 * source: engineering default pending measurement; calibrate by the observed
 * gap between a run reaching "complete" and the host's last get_pipeline_state
 * read for that run_id (instrument get_pipeline_state with run_id + age, then
 * set TTL to p99 of that gap). No measured read-back distribution exists yet,
 * so 30 min is chosen as a conservative upper bound on an interactive host's
 * post-completion read window.
 */
export const RUN_STORE_TTL_MS = 30 * 60 * 1_000; // 30 min — see source note above

/**
 * Max runs retained in the store. Each PipelineState is bounded to the
 * 100,000-char MCP response budget (MAX_RESPONSE_CHARS) by the Phase 1c per-run
 * caps. Capping the store at 64 runs bounds resident memory at
 * 64 × 100,000 chars ≈ 6.4M UTF-16 chars ≈ 12.8 MB worst case — a safe ceiling
 * for an MCP host process. The cap evicts terminal runs LRU-first once exceeded;
 * if every run is in-flight the store may legitimately exceed the cap (we never
 * drop an active run) and the overflow is surfaced via the evicted-skipped path.
 *
 * source: derived from the existing measured per-run bound MAX_RESPONSE_CHARS =
 * 100_000 (state.ts, Cortex sibling MAX_RESPONSE_CHARS). MAX_RUNS_MULTIPLIER =
 * 64 is the engineering default pending measurement; calibrate by the observed
 * peak concurrent + recently-terminal run count on a real host (instrument
 * runStore.size() over a session and set the multiplier to p99 + headroom).
 * Resident ceiling ≈ MAX_RUNS_MULTIPLIER × MAX_RESPONSE_CHARS chars.
 */
const MAX_RUNS_MULTIPLIER = 64; // engineering default — see source note above
export const RUN_STORE_MAX_RUNS = MAX_RUNS_MULTIPLIER;
/**
 * Worst-case resident chars if every retained run is at the per-run budget.
 * Exported so the composition root and tests can assert the ceiling is bounded
 * rather than re-deriving the product. ≈ 6.4M chars ≈ 12.8 MB UTF-16.
 */
export const RUN_STORE_RESIDENT_CHAR_CEILING =
  RUN_STORE_MAX_RUNS * MAX_RESPONSE_CHARS;

export interface RunStoreOptions {
  readonly ttlMs?: number;
  readonly maxRuns?: number;
  readonly clock?: Clock;
  /**
   * Called once per evicted run with its run_id, AFTER it is removed from the
   * map. The composition root uses this to release run-tied evidence
   * (EvidenceRepository.pruneRunEvidence) so eviction frees both the in-memory
   * state and its persisted feedback rows. Must not throw — eviction is
   * best-effort cleanup, not a correctness gate.
   */
  readonly onEvict?: (runId: string) => void;
}

interface Entry {
  state: PipelineState;
  /** Monotonic-ish wall-clock of the last get/set — drives LRU and TTL. */
  lastAccess: number;
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxRuns: number;
  private readonly clock: Clock;
  private readonly onEvict?: (runId: string) => void;

  /** Observable counter — total terminal runs evicted over the store's life. */
  private _evicted = 0;

  constructor(options: RunStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? RUN_STORE_TTL_MS;
    this.maxRuns = options.maxRuns ?? RUN_STORE_MAX_RUNS;
    this.clock = options.clock ?? Date.now;
    this.onEvict = options.onEvict;
  }

  /** Total terminal runs evicted (TTL + max-runs) since construction. */
  get evicted(): number {
    return this._evicted;
  }

  /** Current number of runs resident in the store (in-flight + terminal). */
  size(): number {
    return this.runs.size;
  }

  /**
   * precondition: runId is any string.
   * postcondition: returns the live PipelineState for runId, or undefined.
   *   A successful get refreshes lastAccess (LRU) and first sweeps expired
   *   terminal runs — so a get on an expired terminal run returns undefined.
   */
  get(runId: string): PipelineState | undefined {
    this.sweepExpired();
    const entry = this.runs.get(runId);
    if (!entry) return undefined;
    entry.lastAccess = this.clock();
    return entry.state;
  }

  /**
   * precondition: state.run_id is the key.
   * postcondition: state is stored with lastAccess = now; expired terminal runs
   *   are swept; if the store exceeds maxRuns, terminal runs are evicted
   *   LRU-first until size <= maxRuns OR no terminal run remains. The run being
   *   set is never the eviction target (it was just touched → most-recent LRU).
   * invariant: an in-flight run is never evicted.
   */
  set(state: PipelineState): void {
    this.sweepExpired();
    this.runs.set(state.run_id, { state, lastAccess: this.clock() });
    this.evictOverCap();
  }

  delete(runId: string): void {
    this.runs.delete(runId);
  }

  list(): readonly PipelineState[] {
    return Array.from(this.runs.values(), (e) => e.state);
  }

  /**
   * Evict terminal runs whose age since lastAccess exceeds ttlMs.
   * In-flight runs are skipped regardless of age (a slow host loop is not a
   * leak — the run is still active). source: see RUN_STORE_TTL_MS.
   */
  private sweepExpired(): void {
    const now = this.clock();
    for (const [runId, entry] of this.runs) {
      if (!isTerminalRun(entry.state)) continue;
      if (now - entry.lastAccess >= this.ttlMs) {
        this.evict(runId);
      }
    }
  }

  /**
   * Evict terminal runs LRU-first until size <= maxRuns. If only in-flight runs
   * remain, the store stays over cap rather than dropping an active run — the
   * overflow is bounded by the host's real concurrency, not unbounded growth.
   * source: see RUN_STORE_MAX_RUNS.
   */
  private evictOverCap(): void {
    while (this.runs.size > this.maxRuns) {
      const victim = this.lruTerminal();
      if (victim === null) return; // nothing terminal to evict — keep in-flight
      this.evict(victim);
    }
  }

  /** run_id of the least-recently-accessed TERMINAL run, or null if none. */
  private lruTerminal(): string | null {
    let oldestId: string | null = null;
    let oldestAccess = Infinity;
    for (const [runId, entry] of this.runs) {
      if (!isTerminalRun(entry.state)) continue;
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestId = runId;
      }
    }
    return oldestId;
  }

  /** Remove a run, bump the observable counter, and fire onEvict. */
  private evict(runId: string): void {
    this.runs.delete(runId);
    this._evicted += 1;
    if (this.onEvict) {
      try {
        this.onEvict(runId);
      } catch {
        // Best-effort cleanup — eviction must not throw.
      }
    }
  }
}
