/**
 * Judge-verdict parsing + rule-tier verdict computation for self-check's
 * Phase A/B multi-judge verification batch. Extracted from self-check.ts
 * (§4.1 500-line file cap) — this module owns ONE concern: turning raw
 * `subagent_batch_result` responses (plus the claim/judge/model context
 * that produced each invocation) into typed `JudgeVerdict[]`, and
 * synthesizing the rule-tier verdicts for mechanical-tier claims
 * (claim-tier.ts) that never received an invocation at all.
 *
 * self-check.ts owns phase sequencing, dispatch, and snapshot bookkeeping;
 * this module owns the pure parsing/synthesis functions. Both are
 * "self-check's own files" — no other handler imports from here.
 */

import { z } from "zod";
import type { ActionResult } from "../types/actions.js";
import type { VerifyBudgetConfig } from "../types/state/verify-budget.js";
import {
  planDocumentVerification,
  buildMechanicalVerdicts,
} from "@prd-gen/verification";
import {
  VerdictSchema,
  extractJsonValue,
  type JudgeRequest,
  type JudgeVerdict,
  type SectionType,
} from "@prd-gen/core";
import { SELF_CHECK_JUDGE_INV_PREFIX } from "./protocol-ids.js";
import { assignJudgeModels } from "./self-check-verify-budget.js";

/**
 * Defensive char cap for a single JudgeVerdict.rationale persisted into
 * `pending_completion.verification.judge_verdicts` (state serialized into
 * MCP responses — see bounded-io.ts:MAX_RESPONSE_CHARS derivation). The judge
 * prompt asks for "one paragraph" (judge-prompt.ts) — a few sentences, so 500
 * chars matches the project's existing per-item convention for short
 * judge/error text (bounded-io.ts:ERROR_MESSAGE_CHARS). At the 20-invocation
 * default cap (DEFAULT_VERIFY_BUDGET.invocation_cap), 20 verdicts x ~600
 * chars each (rationale + judge/claim_id/verdict/confidence/caveats
 * overhead) is ~12,000 chars — well inside the 100,000-char budget alongside
 * the rest of pending_completion.
 * source: self-check-verify-budget.ts DEFAULT_VERIFY_BUDGET.invocation_cap
 * (20) + bounded-io.ts ERROR_MESSAGE_CHARS convention (500).
 */
const JUDGE_VERDICT_RATIONALE_TRUNCATE_CHARS = 500;
const JUDGE_VERDICT_RATIONALE_TRUNCATION_MARKER = "...";

export function truncateJudgeVerdictRationale(v: JudgeVerdict): JudgeVerdict {
  return v.rationale.length > JUDGE_VERDICT_RATIONALE_TRUNCATE_CHARS
    ? {
        ...v,
        rationale:
          v.rationale.slice(0, JUDGE_VERDICT_RATIONALE_TRUNCATE_CHARS) +
          JUDGE_VERDICT_RATIONALE_TRUNCATION_MARKER,
      }
    : v;
}

const RawVerdictSchema = z.object({
  verdict: VerdictSchema,
  rationale: z.string(),
  caveats: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

const RawBatchedVerdictSchema = RawVerdictSchema.extend({ claim_id: z.string() });

export interface JudgeIndexEntry {
  request: JudgeRequest;
  /** The invocation that carries this request: shared by every request of one batch. */
  invocation_id: string;
  /** Model this invocation was (or would be) dispatched under — assignJudgeModels(). */
  model: string;
}

export function invocationIdFor(idx: number): string {
  return `${SELF_CHECK_JUDGE_INV_PREFIX}${idx.toString().padStart(4, "0")}`;
}

/**
 * precondition:  `requests` is the FINAL request set (post-reduction,
 *                post-sampling) — same precondition as buildVerifyAction.
 * postcondition: result.length === requests.length, index-aligned. Requests
 *                that share a judge and a model share one invocation_id
 *                (issue #119: one prompt per judge, the PRD embedded once),
 *                so one invocation never carries the same claim twice: a
 *                repeated (judge, model, claim) opens a new invocation.
 *                Invocation ids are numbered in order of first appearance.
 *                `invocation_id`/`model` come from the SAME deterministic
 *                mapping used to build the dispatched spawn_subagents action,
 *                so Phase A dispatch and Phase B parsing always agree on both.
 */
export function buildJudgeIndex(
  requests: readonly JudgeRequest[],
  config: VerifyBudgetConfig,
): readonly JudgeIndexEntry[] {
  const models = assignJudgeModels(requests, config);
  const open = new Map<string, { invocation_id: string; claims: Set<string> }>();
  let next = 0;
  return requests.map((request, idx) => {
    const key = `${request.judge.kind}:${request.judge.name}|${models[idx]}`;
    let batch = open.get(key);
    if (!batch || batch.claims.has(request.claim.claim_id)) {
      batch = { invocation_id: invocationIdFor(next++), claims: new Set() };
      open.set(key, batch);
    }
    batch.claims.add(request.claim.claim_id);
    return { request, invocation_id: batch.invocation_id, model: models[idx] };
  });
}

/**
 * The index entries grouped by invocation, in invocation order.
 *
 * postcondition: every entry appears in exactly one group, in index order
 *                within its group; all entries of a group share the same
 *                invocation_id, judge and model.
 */
export function groupJudgeIndex(
  index: readonly JudgeIndexEntry[],
): ReadonlyArray<readonly JudgeIndexEntry[]> {
  const groups = new Map<string, JudgeIndexEntry[]>();
  for (const entry of index) {
    const group = groups.get(entry.invocation_id);
    if (group) group.push(entry);
    else groups.set(entry.invocation_id, [entry]);
  }
  return [...groups.values()];
}

type RawVerdict = z.infer<typeof RawVerdictSchema>;
type ParsedVerdict = RawVerdict | { failure: string };

/**
 * A judge answer is an object with a `verdict` or a `claim_id`, or a
 * non-empty array of objects of which one at least has one of the two;
 * anything else in the reply (a footnote `[1]`, a checkbox `[ ]`, an aside
 * `{see below}`) is prose, skipped by extractJsonValue (review note 3 of
 * #326). An array element that is incomplete (`{"claim_id": "B"}`) does not
 * make the array prose: readJudgeResponse degrades that claim alone and
 * keeps its siblings' verdicts (Codex review of #327).
 */
function isVerdictShaped(value: unknown): boolean {
  const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);
  const answers = (v: unknown) => isObject(v) && ("verdict" in v || "claim_id" in v);
  return Array.isArray(value)
    ? value.length > 0 && value.every(isObject) && value.some(answers)
    : answers(value);
}

/**
 * One judge response, read for the claims of its invocation.
 *
 * precondition:  `claimIds` are the distinct claim_ids of one invocation.
 * postcondition: one entry per claim_id. A JSON array is matched by
 *                claim_id: a claim with no object, an invalid object or two
 *                objects gets a failure. A single object is accepted only
 *                for an invocation of one claim, and only when its claim_id
 *                is that claim's: an object without claim_id (the answer to
 *                the former one-claim prompt, which a run saved by an older
 *                server may hold for a renumbered invocation id) is refused
 *                rather than credited to another claim (review note 2 of
 *                #325). Throws when the response holds no JSON at all.
 */
function readJudgeResponse(
  rawText: string,
  claimIds: readonly string[],
): ReadonlyMap<string, ParsedVerdict> {
  const value = extractJsonValue(rawText, isVerdictShaped);
  const out = new Map<string, ParsedVerdict>();
  if (!Array.isArray(value)) {
    if (claimIds.length !== 1) {
      throw new Error(`expected a JSON array of ${claimIds.length} verdicts, got one object`);
    }
    const parsed = RawBatchedVerdictSchema.parse(value);
    if (parsed.claim_id !== claimIds[0]) {
      throw new Error(`verdict for claim_id ${parsed.claim_id}, expected ${claimIds[0]}`);
    }
    out.set(claimIds[0], parsed);
    return out;
  }
  const wanted = new Set(claimIds);
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = RawBatchedVerdictSchema.safeParse(item);
    const id =
      parsed.success
        ? parsed.data.claim_id
        : typeof (item as { claim_id?: unknown })?.claim_id === "string"
          ? (item as { claim_id: string }).claim_id
          : undefined;
    if (id === undefined || !wanted.has(id)) continue;
    if (seen.has(id)) {
      out.set(id, { failure: `two verdicts for claim_id ${id}` });
      continue;
    }
    seen.add(id);
    out.set(
      id,
      parsed.success ? parsed.data : { failure: `invalid verdict for claim_id ${id}: ${parsed.error.message}` },
    );
  }
  for (const id of claimIds) {
    if (!out.has(id)) out.set(id, { failure: `no verdict for claim_id ${id} in the judge's array` });
  }
  return out;
}

/**
 * precondition:  `index` is the dispatched invocation index for the batch
 *                `batchResult` responds to (buildJudgeIndex output).
 * postcondition: result.length === index.length, index-aligned; a missing/
 *                errored/unparseable response, or a claim the judge's array
 *                does not answer, degrades to an INCONCLUSIVE verdict rather
 *                than throwing — see caveats for the reason
 *                ("judge_invocation_failed" | "parse_error").
 */
export function parseVerdicts(
  index: ReadonlyArray<JudgeIndexEntry>,
  batchResult: Extract<ActionResult, { kind: "subagent_batch_result" }>,
): JudgeVerdict[] {
  // Detect duplicate invocation_ids — silent overwrite would lose verdicts.
  // Replace any duplicate with an explicit error response so the affected
  // claims surface as INCONCLUSIVE rather than silently keeping last-write.
  const byId = new Map<string, (typeof batchResult.responses)[number]>();
  for (const r of batchResult.responses) {
    if (byId.has(r.invocation_id)) {
      byId.set(r.invocation_id, {
        invocation_id: r.invocation_id,
        error: `duplicate invocation_id in batch: ${r.invocation_id}`,
      });
    } else {
      byId.set(r.invocation_id, r);
    }
  }
  const read = new Map<string, ReadonlyMap<string, ParsedVerdict> | { failure: string }>();
  for (const group of groupJudgeIndex(index)) {
    const response = byId.get(group[0].invocation_id);
    if (!response || response.error || !response.raw_text) continue;
    try {
      read.set(group[0].invocation_id, readJudgeResponse(response.raw_text, group.map((e) => e.request.claim.claim_id)));
    } catch (err) {
      read.set(group[0].invocation_id, { failure: (err as Error).message });
    }
  }
  return index.map((entry): JudgeVerdict => {
    const base = { judge: entry.request.judge, claim_id: entry.request.claim.claim_id, model: entry.model };
    const response = read.get(entry.invocation_id);
    if (response === undefined) {
      return {
        ...base,
        verdict: "INCONCLUSIVE",
        rationale: byId.get(entry.invocation_id)?.error ?? "no response",
        caveats: ["judge_invocation_failed"],
        confidence: 0,
      };
    }
    const parsed = "failure" in response ? response : response.get(base.claim_id)!;
    if ("failure" in parsed) {
      return {
        ...base,
        verdict: "INCONCLUSIVE",
        rationale: `parse failure: ${parsed.failure}`,
        caveats: ["parse_error"],
        confidence: 0,
      };
    }
    return {
      ...base,
      verdict: parsed.verdict,
      rationale: parsed.rationale,
      caveats: parsed.caveats,
      confidence: parsed.confidence,
    };
  });
}

/**
 * Rule-tier verdicts for claims classified "mechanical" (claim-tier.ts) —
 * synthesized directly, never dispatched as a judge invocation. Recomputed
 * (not persisted in the snapshot) because it is a pure function of
 * `sections`, the same rederivation strategy self-check.ts's
 * parseVerdictsFromSnapshot already relies on for the subjective-tier plan.
 * Called from BOTH Phase A's fast-paths (zero subjective claims to dispatch)
 * and Phase B (merged alongside the judge-parsed subjective verdicts) so
 * mechanical claims are present in `judge_verdicts` on every exit path, not
 * only when a judge panel also ran.
 *
 * precondition:  `sections` is the claim-rich section list (self-check.ts's
 *                gatherSections output — content-bearing, non-jira_tickets).
 * postcondition: one JudgeVerdict per mechanical claim, verdict
 *                "SPEC-COMPLETE", judge=RULE_TIER_JUDGE (mechanical-verdict.ts).
 */
export function computeMechanicalVerdicts(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): readonly JudgeVerdict[] {
  const plan = planDocumentVerification(sections);
  return buildMechanicalVerdicts(plan.mechanical_claims);
}

/**
 * Distinct SUBJECTIVE-tier claim count (claim-tier.ts) — the denominator
 * `handlers/verification-policy.ts`'s `min_subjective_sampled_ratio` gate
 * needs. `judge_requests` carries one entry per (claim, judge) pair BEFORE
 * budget reduction/sampling (orchestrator.ts `buildRequests`) — a claim with
 * a 5-judge architecture panel appears 5 times — so the distinct claim_id
 * count, not `requests.length`, is the claim count.
 *
 * precondition:  `requests` is `planDocumentVerification(sections)
 *                .judge_requests` — the FULL, pre-reduction plan (NOT the
 *                reduced/sampled dispatch set) — see
 *                `VerificationSummarySchema.total_subjective_claims` doc for
 *                why the denominator must be the pre-sampling total.
 * postcondition: pure function; returns 0 for an empty plan.
 */
export function countSubjectiveClaims(requests: readonly JudgeRequest[]): number {
  return new Set(requests.map((r) => r.claim.claim_id)).size;
}
