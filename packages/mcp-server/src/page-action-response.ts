/**
 * Response bounding for `get_pipeline_state(run_id, format:"action")` (#125).
 *
 * THE BUG THIS FIXES
 * -------------------
 * `boundEnvelopeResponse` strips every `spawn_subagents` prompt from an
 * oversized `start_pipeline` / `submit_action_result` envelope and points the
 * host at `get_pipeline_state(run_id, format:"action")` to recover them. That
 * recovery path returned the whole unbounded action in one response, so a
 * judge batch whose envelope overshot the 100,000-char budget overshot it
 * again on the refetch: the 2026-10-10 audit of v0.8.0 measured about 112k
 * characters on that path, above the budget the server itself declares in
 * `__bounded.budget_chars`.
 *
 * THE FIX
 * -------
 * The refetch is paged by invocation. Each page carries the action with a
 * contiguous slice of `invocations`, starting at `invocation_offset`: the
 * longest slice whose serialized response stays within MAX_RESPONSE_CHARS.
 * The host refetches when the normal envelope's `__bounded.applied` records
 * `action.invocations[].prompt` (the prompts arrive as `omitted` stubs);
 * `__bounded` itself is present on every envelope.
 * Prompts are never cut: a host needs each prompt whole, so the unit of a page
 * is one invocation. A `__page` marker states where the slice sits in the
 * batch (`offset`, `count`, `total`, `next_offset`) and its measured size; the
 * host follows `next_offset` until it is `null`, then dispatches the batch.
 *
 * A page overshoots only when a single invocation, with the envelope around
 * it, does not fit. It is still returned whole (cutting it would hand the
 * judge a corrupt prompt), and the overshoot is observable: `final_chars >
 * budget_chars`. Judge prompts measured ~37k chars (e2e run_mrlqa0aj_u2rh15),
 * so this does not happen with the shipped prompt builder.
 */

import { MAX_RESPONSE_CHARS } from "@prd-gen/orchestration";

export interface ActionPageMarker {
  /** Index in the full batch of the first invocation on this page. */
  readonly offset: number;
  /** Number of invocations on this page. */
  readonly count: number;
  /** Number of invocations in the full batch. */
  readonly total: number;
  /** `invocation_offset` of the next page, or `null` on the last page. */
  readonly next_offset: number | null;
  /** Serialized size of this response, `__page` included. */
  readonly final_chars: number;
  readonly budget_chars: number;
}

export interface ActionPage {
  readonly run_id: string;
  readonly action: unknown;
  readonly __page: ActionPageMarker;
}

export interface ActionPageError {
  readonly error: string;
}

/** The exact wire format pipeline-tools.ts ships (pretty-printed JSON). */
function wireChars(value: unknown): number {
  return JSON.stringify(value, null, 2).length;
}

type SpawnAction = { kind: "spawn_subagents"; invocations: unknown[] } & Record<string, unknown>;

function isSpawnAction(action: unknown): action is SpawnAction {
  if (action === null || typeof action !== "object") return false;
  const a = action as { kind?: unknown; invocations?: unknown };
  return a.kind === "spawn_subagents" && Array.isArray(a.invocations);
}

interface Slice {
  readonly offset: number;
  readonly count: number;
  readonly total: number;
}

function pageOf(runId: string, action: unknown, { offset, count, total }: Slice): ActionPage {
  const end = offset + count;
  const draft: ActionPage = {
    run_id: runId,
    action,
    __page: {
      offset,
      count,
      total,
      next_offset: end < total ? end : null,
      final_chars: 0,
      budget_chars: MAX_RESPONSE_CHARS,
    },
  };
  // final_chars is part of the payload it measures: start from the size
  // with a 0 placeholder and re-measure until the value is stable (2-3
  // passes), so the reported size is the shipped size.
  let measured = wireChars(draft);
  for (;;) {
    const candidate = { ...draft, __page: { ...draft.__page, final_chars: measured } };
    const actual = wireChars(candidate);
    if (actual === measured) return candidate;
    measured = actual;
  }
}

/**
 * precondition:  `action` is the unbounded last action cached for `runId`
 *                (or `null` when none is cached); `offset` is an integer >= 0.
 * postcondition: for a `spawn_subagents` action, the returned page holds the
 *                invocations [offset, offset + count) of the batch, every
 *                other field of the action unchanged, and
 *                `__page.final_chars <= MAX_RESPONSE_CHARS` unless the single
 *                invocation at `offset` alone exceeds the budget (count = 1,
 *                overshoot visible in `final_chars`). Following `next_offset`
 *                from 0 visits every invocation exactly once. Any other
 *                action is returned whole on one page (offset must be 0).
 *                An offset past the end of the batch is an error.
 */
export function pageActionResponse(
  runId: string,
  action: unknown,
  offset: number,
): ActionPage | ActionPageError {
  // zod enforces this over MCP; an in-process call does not go through zod,
  // and NaN or a negative offset would make slice() drop or misplace
  // invocations while next_offset still reported a complete walk.
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return { error: `invocation_offset ${offset} is not a non-negative integer` };
  }
  if (!isSpawnAction(action)) {
    if (offset !== 0) {
      return { error: `invocation_offset ${offset} out of range: the last action is not a spawn_subagents batch` };
    }
    return pageOf(runId, action, { offset: 0, count: 0, total: 0 });
  }

  const all = action.invocations;
  const total = all.length;
  if (total === 0 && offset === 0) {
    return pageOf(runId, action, { offset: 0, count: 0, total: 0 });
  }
  if (offset >= total) {
    return { error: `invocation_offset ${offset} out of range: the batch has ${total} invocations` };
  }

  const build = (count: number) =>
    pageOf(runId, { ...action, invocations: all.slice(offset, offset + count) }, { offset, count, total });
  return largestFittingPage(build, total - offset);
}

/**
 * precondition:  `build(n)` is the page holding the next `n` invocations, for
 *                1 <= n <= remaining, and its size grows with `n`.
 * postcondition: the page for the largest `n` that fits the budget, or the
 *                page for `n = 1` when none does.
 */
function largestFittingPage(build: (count: number) => ActionPage, remaining: number): ActionPage {
  // The serialized size grows with `count`. The largest slice that fits is
  // bracketed by doubling from 1, then found by binary search inside the
  // bracket, so no probe serializes more than about twice a page (a binary
  // search over the whole remainder would serialize half the batch first).
  // At least one invocation is always returned so a walk along next_offset
  // makes progress.
  let best = build(1);
  let fit = 1;
  let over = remaining + 1;
  for (let probe = 2; probe <= remaining; probe *= 2) {
    const candidate = build(probe);
    if (candidate.__page.final_chars > MAX_RESPONSE_CHARS) {
      over = probe;
      break;
    }
    best = candidate;
    fit = probe;
  }
  if (over === remaining + 1 && fit < remaining) {
    const last = build(remaining);
    if (last.__page.final_chars <= MAX_RESPONSE_CHARS) return last;
    over = remaining;
  }
  let lo = fit + 1;
  let hi = over - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = build(mid);
    if (candidate.__page.final_chars <= MAX_RESPONSE_CHARS) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
