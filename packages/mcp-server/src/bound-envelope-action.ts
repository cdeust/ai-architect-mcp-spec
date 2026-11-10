/**
 * Response bounding for `submit_action_result` / `start_pipeline` envelopes
 * that carry a `spawn_subagents` action (Phase 1e).
 *
 * THE BUG THIS FIXES
 * -------------------
 * self_check's judge-verification batch can spawn dozens of judge subagents
 * in one `spawn_subagents` action, each carrying a multi-KB prompt (built by
 * `buildJudgePrompt` — full section content + claim + judge instructions). A
 * batch of 89 invocations at ~37K chars each measured a 3.5MB serialized
 * envelope — 35x the Claude Code 100,000-char MCP response budget
 * (MAX_RESPONSE_CHARS, `@prd-gen/orchestration` bounded-io.ts) that
 * `get_pipeline_state format:"full"` already respects via
 * `boundFullStateResponse`. `envelope()` in pipeline-tools.ts (the shared
 * response builder for `start_pipeline` and `submit_action_result`) had NO
 * equivalent bound — the host had to grep a spilled file to recover the
 * batch.
 * source: e2e run_mrlqa0aj_u2rh15 (2026-07-15) — measured 3.5MB response.
 *
 * THE FIX
 * -------
 * Mirror `bound-full-state.ts`'s degrade-observably pattern at the ENVELOPE
 * boundary. When the full envelope's pretty-printed serialization exceeds
 * MAX_RESPONSE_CHARS and the action is `spawn_subagents`, replace every
 * invocation's `prompt` with an `OmittedStub` — keeping `invocation_id`,
 * `subagent_type`, `description`, and `isolation` intact — and record the
 * shed via a top-level `__bounded` marker (present on EVERY envelope, empty
 * `applied` when no degradation occurred — same invariant
 * `boundFullStateResponse` establishes). The full, unbounded action
 * (including every prompt) is recoverable via
 * `get_pipeline_state(run_id, format:"action")`, served from an in-memory
 * per-run cache that pipeline-tools.ts updates on every
 * start_pipeline/submit_action_result call BEFORE bounding is applied — no
 * silent truncation, no filesystem spooling required. That refetch is itself
 * paged under MAX_RESPONSE_CHARS by whole invocations (page-action-response.ts,
 * #125).
 *
 * Stripping is ALL-OR-NOTHING across the batch, never per-invocation: a host
 * driving a `spawn_subagents` batch needs every invocation's prompt or none.
 * A partially-stripped batch would silently corrupt an arbitrary subset of a
 * parallel dispatch with no uniform signal the host could act on.
 */

import { MAX_RESPONSE_CHARS } from "@prd-gen/orchestration";
import type { Degradation, OmittedStub } from "./bound-full-state.js";

export interface EnvelopePayload {
  readonly run_id: string;
  readonly current_step: string;
  readonly messages: unknown;
  /**
   * `unknown` — mirrors envelope()'s own `action: unknown` parameter
   * (pipeline-tools.ts). Callers pass either a NextAction or a raw
   * HandlerAction (get_pipeline_state's format:"summary" path passes
   * `null`); narrowed internally via a runtime shape check, never trusted
   * by static type alone.
   */
  readonly action: unknown;
  readonly state_summary: unknown;
}

export interface BoundedEnvelope extends EnvelopePayload {
  readonly __bounded: {
    readonly original_chars: number;
    readonly final_chars: number;
    readonly budget_chars: number;
    readonly applied: ReadonlyArray<Degradation>;
  };
}

/**
 * Measure the payload the way the host will — `JSON.stringify(payload, null, 2)`
 * is the exact wire format pipeline-tools.ts ships (see envelope() callers).
 */
function wireChars(value: unknown): number {
  return JSON.stringify(value, null, 2).length;
}

/**
 * precondition:  `payload` is the envelope object about to be returned to
 *                the host over MCP — NOT YET serialized.
 * postcondition: wireChars(result) <= MAX_RESPONSE_CHARS whenever
 *                `payload.action.kind === "spawn_subagents"` and at least
 *                one invocation carries a non-empty prompt (stripping every
 *                prompt reclaims the entire overshoot in the observed 3.5MB
 *                case — prompts dominate the payload). For any other
 *                oversized action kind (no bounding strategy currently
 *                applies to those shapes), the overshoot is recorded in
 *                `__bounded` but NOT silently hidden — the caller can
 *                observe `final_chars > budget_chars` and decide how to
 *                proceed; this never happens today (only spawn_subagents
 *                batches are large enough to threaten the budget — see
 *                MAX_RESPONSE_CHARS's derivation). Every degradation is
 *                recorded in `__bounded.applied` with the exact chars
 *                reclaimed. The full action (prompts included) stays
 *                recoverable via
 *                `get_pipeline_state(run_id, format:"action")`, paged by
 *                `invocation_offset`.
 */
export function boundEnvelopeResponse(payload: EnvelopePayload): BoundedEnvelope {
  const applied: Degradation[] = [];
  const originalChars = wireChars(payload);

  const marker = (finalChars: number) => ({
    original_chars: originalChars,
    final_chars: finalChars,
    budget_chars: MAX_RESPONSE_CHARS,
    applied,
  });

  if (originalChars <= MAX_RESPONSE_CHARS) {
    return { ...payload, __bounded: marker(originalChars) };
  }

  const action = payload.action as { kind?: string; invocations?: unknown[] } | null;
  if (
    action &&
    action.kind === "spawn_subagents" &&
    Array.isArray(action.invocations) &&
    action.invocations.length > 0
  ) {
    const invocations = action.invocations as Array<Record<string, unknown>>;
    let reclaimed = 0;
    const stripped = invocations.map((inv) => {
      const prompt = inv.prompt;
      if (typeof prompt === "string" && prompt.length > 0) {
        const chars = wireChars(prompt);
        reclaimed += chars;
        const stub: OmittedStub = {
          omitted: true,
          chars,
          hint: `re-fetch via get_pipeline_state(run_id, format:"action") — every invocation with its prompt, paged under the response budget: follow __page.next_offset as invocation_offset until it is null`,
        };
        return { ...inv, prompt: stub };
      }
      return inv;
    });

    if (reclaimed > 0) {
      const boundedPayload: EnvelopePayload = {
        ...payload,
        action: { ...action, invocations: stripped },
      };
      applied.push({
        field: "action.invocations[].prompt",
        kind: "omitted",
        reclaimed_chars: reclaimed,
      });
      const finalChars = wireChars({ ...boundedPayload, __bounded: marker(0) });
      return { ...boundedPayload, __bounded: marker(finalChars) };
    }
  }

  // Over budget but no bounding strategy applies (not a spawn_subagents
  // action, or no prompts to shed) — record the overshoot rather than
  // silently pass it through.
  return { ...payload, __bounded: marker(originalChars) };
}
