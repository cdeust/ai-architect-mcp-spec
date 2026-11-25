import { ARCHITECT_OS_BOUNDARY, runRequestSize, type PipelineState } from "@prd-gen/orchestration";
import { getEvidenceRepo } from "./evidence-db-path.js";
import { KeptRuns, type FoundRun } from "./kept-runs.js";
import { RunFiles, RUNS_DIR } from "./run-files.js";

/**
 * Global run semaphore cap — max pipeline runs in flight at once.
 *
 * A "run in flight" is a run whose current_step !== "complete": the host is
 * still driving its loop (start_pipeline → submit_action_result*). Each in-flight
 * run pins one PipelineState (≤ MAX_RESPONSE_CHARS) plus any subagent work the
 * host spawns for it. Without a cap, a host that fires start_pipeline in a loop
 * grows unbounded concurrent work.
 *
 * source: engineering default pending measurement; calibrate by the observed
 * peak concurrent in-flight run count on a real interactive host (instrument
 * runs.inFlightCount() at each start_pipeline and set MAX_CONCURRENT_RUNS to
 * p99 + headroom). 8 is chosen conservatively: an interactive Claude Code host
 * drives one pipeline at a time in the common case, so 8 leaves generous room
 * for overlap while bounding fan-out. It is well under the RunStore max-runs cap
 * (64) so the semaphore — not eviction — is the first limit a runaway caller
 * hits, yielding a clear structured rejection instead of silent eviction.
 */
export const MAX_CONCURRENT_RUNS = Number(
  process.env.PRD_MAX_CONCURRENT_RUNS ?? 8,
); // env-configurable; default 8 — see source note above

/**
 * The runs of this server: in memory, and each in its file under
 * `~/.prd-gen/runs/` so that a restart does not lose them (#121,
 * kept-runs.ts). Beside the state, a run keeps the last UNBOUNDED action
 * `step()` emitted, before `boundEnvelopeResponse` sheds the `spawn_subagents`
 * prompts that do not fit: it serves `get_pipeline_state(run_id,
 * format:"action")`, the path a host follows when it sees a `__bounded` marker
 * on an envelope, or when it comes back to a run after a restart (source:
 * e2e run_mrlqa0aj_u2rh15, 2026-07-15, bound-envelope-action.ts).
 *
 * When a finished run is dropped (TTL or max-runs), its persisted
 * strategy-execution evidence is released so disk growth tracks live runs.
 * Best-effort: a missing repo is a no-op. source: evidence-repository.ts
 * pruneRunEvidence.
 */
export const runs = new KeptRuns(new RunFiles(RUNS_DIR), {
  onDrop: (runId: string) => {
    getEvidenceRepo()?.pruneRunEvidence(runId);
  },
});

/**
 * postcondition: the tool error for a run id that names no run the server
 *                can go on with: `unknown run_id`, or, when the run has a
 *                file that cannot be read as a run, that fact and the reason.
 */
export function runNotFound(runId: string, found: Exclude<FoundRun, { kind: "found" }>) {
  const error =
    found.kind === "unknown"
      ? `unknown run_id: ${runId}`
      : `the state kept for run_id ${runId} cannot be read: ${found.reason}`;
  return { content: [{ type: "text" as const, text: JSON.stringify({ error }) }], isError: true };
}

/**
 * Per-run_id in-flight guard for submit_action_result. The reducer pattern
 * (read state → step → write state) is atomic only under Node.js cooperative
 * scheduling because step() is synchronous and there is no await between get
 * and set. This Set explicitly rejects concurrent submissions for the same
 * run_id, providing defense-in-depth if the runtime ever changes.
 */
export const inFlight = new Set<string>();

export function generateRunId(): string {
  return (
    "run_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  );
}

export function envelope(
  state: PipelineState,
  action: unknown,
  messages: ReadonlyArray<{ text: string; level: "info" | "warn" | "error" }> = [],
) {
  return {
    run_id: state.run_id,
    current_step: state.current_step,
    /** Banners/status lines emitted while advancing to `action`. Display before acting. */
    messages,
    action,
    state_summary: {
      sections: state.sections.map((s) => ({
        section_type: s.section_type,
        status: s.status,
        attempt: s.attempt,
        violation_count: s.violation_count,
      })),
      clarification_rounds: state.clarifications.length,
      errors: state.errors.length,
      // The kind and the size the run is held to: what its rounds and sections follow.
      prd_context: state.prd_context,
      request_size: runRequestSize(state),
    },
  };
}

export function architectOsRequired() {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: ARCHITECT_OS_BOUNDARY }) }],
    isError: true,
  };
}

const planningSizeErrors = {
  define: { code: "define_response_too_large", message: "The complete Define result exceeds the MCP response budget." },
  plan: { code: "plan_response_too_large", message: "The complete verified plan exceeds the MCP response budget." },
  review: { code: "review_response_too_large", message: "The complete implementation review exceeds the MCP response budget." },
};

export function planningSizeError(kind: keyof typeof planningSizeErrors) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: planningSizeErrors[kind] }) }], isError: true };
}
