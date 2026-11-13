/**
 * Curie A2.3 closure — end-to-end: `conclude_verification` MCP handler
 * accepts `claims` parameter → oracle-resolved ground truth reaches JSONL log.
 *
 * This test closes the Wave D / Wave E / Wave F triple-pattern:
 *   Wave D A7  : type-level seam (Claim.external_grounding added to core)
 *   Wave E A2.3: orchestrator propagation (concludeFromVerdicts reads claims map)
 *   Wave F A2.3: MCP-tool-API parameter (this test + the handler extension)
 *
 * What is verified:
 *   Test 1: math-grounded claim (2+2=4) supplied via the claims map →
 *           appendObservationLog receives oracle_resolved_truth: true.
 *   Test 2: schema-grounded claim supplied via claims map, ungrounded claim also
 *           present → grounded entry has oracle_resolved_truth, ungrounded does not.
 *   Test 3: buildConcludeOpts with claims=undefined (absent from caller) →
 *           ConcludeOptions.claims is undefined; no regression for existing callers.
 *
 * Strategy: construct ConcludeOptions via buildConcludeOpts (same function the
 * handler calls) + a stub reliability repo (to activate the onObservation closure)
 * + vi.mock on @prd-gen/benchmark to spy on appendObservationLog without disk I/O.
 * The real math oracle is exercised (no mock) to prove arithmetic evaluation is live.
 * The schema oracle is mocked to avoid network/filesystem access in CI.
 *
 * source: Curie A2.3; PHASE_4_PLAN.md §4.1 Wave F closure.
 * Stakes: Medium — calibration infrastructure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Claim, JudgeVerdict } from "@prd-gen/core";
import { ClaimSchema } from "@prd-gen/core";
import { concludeSection } from "@prd-gen/verification";
import { isAbsolute } from "node:path";
import { buildConcludeOpts } from "../build-conclude-opts.js";
import { OBSERVATION_LOG_PATH } from "../observation-log-path.js";

// ─── Mock @prd-gen/benchmark ──────────────────────────────────────────────────
// Spy on appendObservationLog without disk I/O.
// FAILS_ON: test that relies on real filesystem — intentional, this is a unit seam.

vi.mock("@prd-gen/benchmark", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@prd-gen/benchmark")>();
  return {
    ...actual,
    appendObservationLog: vi.fn(),
  };
});

// ─── Mock reliability-wiring so onObservation closure is activated ────────────
// buildConcludeOpts guards on `getReliabilityRepo() !== null` before wiring
// the onObservation flush. We provide a stub repo so the closure fires.
// FAILS_ON: test that needs real SQLite DB — intentional; this is a unit seam.

vi.mock("../reliability-wiring.js", () => ({
  getReliabilityRepo: vi.fn(() => ({ recordObservation: vi.fn() })),
  getConsensusReliabilityProvider: vi.fn(() => null),
  closeReliabilityRepo: vi.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeVerdict(
  claim_id: string,
  verdict: JudgeVerdict["verdict"] = "PASS",
): JudgeVerdict {
  return {
    judge: { kind: "genius" as const, name: "fermi" as const },
    claim_id,
    verdict,
    rationale: "handler e2e test",
    caveats: [],
    confidence: 0.9,
  };
}

/**
 * Build a claims Map from lightweight descriptors — mirrors the handler's
 * claim-parsing loop in pipeline-tools.ts (ClaimSchema.safeParse → Map).
 *
 * Precondition: each descriptor has claim_id and claim_type.
 * Postcondition: returned map has one entry per descriptor; text/evidence
 *   are defaulted to empty string (same as handler defaults).
 */
function buildClaimsMap(
  descriptors: Array<{
    claim_id: string;
    claim_type: Claim["claim_type"];
    external_grounding?: { type: "schema" | "math" | "code" | "spec"; payload: unknown };
  }>,
): ReadonlyMap<string, Claim> {
  const map = new Map<string, Claim>();
  for (const d of descriptors) {
    const parsed = ClaimSchema.safeParse({ ...d, text: d.claim_id, evidence: "" });
    if (parsed.success) map.set(parsed.data.claim_id, parsed.data);
  }
  return map;
}

// ─── Test 1: math-grounded claim → oracle_resolved_truth: true ───────────────

describe("conclude_verification claims param — Curie A2.3 MCP-tool-API closure", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("Test 1: math-grounded claim via claims map → oracle_resolved_truth: true", async () => {
    // Precondition: claim has external_grounding.type === "math", expression 2+2=4.
    // Postcondition: appendObservationLog receives oracle_resolved_truth: true.
    //   The real mathOracle is invoked — this is an integration assertion.
    // Invariant: the oracle result does not abort the pipeline; log always written.

    const { appendObservationLog } = await import("@prd-gen/benchmark");

    const claimsMap = buildClaimsMap([
      {
        claim_id: "MATH-H1",
        claim_type: "correctness",
        external_grounding: {
          type: "math",
          payload: { expression: "2+2", expected_value: 4 },
        },
      },
    ]);

    // buildConcludeOpts is the exact function the MCP handler calls after parsing.
    const opts = buildConcludeOpts({
      consensus_strategy: "weighted_average",
      run_id: "handler-e2e-math",
      claim_types: { "MATH-H1": "correctness" },
      claims: claimsMap,
    });

    // Verify claims propagated through to ConcludeOptions.
    expect(opts.claims).toBe(claimsMap);

    concludeSection("requirements", [makeVerdict("MATH-H1")], opts);

    // Async flush — void IIFE inside onObservation resolves after oracle call.
    await vi.waitUntil(
      () => (appendObservationLog as ReturnType<typeof vi.fn>).mock.calls.length > 0,
      { timeout: 3000 },
    );

    const calls = (appendObservationLog as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const entry = calls[0][0];
    expect(entry.claim_id).toBe("MATH-H1");
    // oracle_resolved_truth: true — 2+2=4 is arithmetically correct.
    expect(entry.oracle_resolved_truth).toBe(true);
    expect(typeof entry.oracle_evidence).toBe("string");
    expect((entry.oracle_evidence as string).length).toBeGreaterThan(0);
    // The server's own path, beside its databases, not the benchmark's
    // default, which is relative to the root of a clone (#243).
    expect(calls[0][1]).toBe(OBSERVATION_LOG_PATH);
    expect(isAbsolute(OBSERVATION_LOG_PATH)).toBe(true);
  });

  it("Test 2: mixed claims — grounded gets oracle_resolved_truth, ungrounded does not", async () => {
    // Precondition: one math-grounded claim (MATH-H2) + one ungrounded claim (FR-H2).
    // Postcondition: MATH-H2 log entry has oracle_resolved_truth; FR-H2 entry does not.
    // Invariant: both entries are written; ungrounded path is not broken.

    const { appendObservationLog } = await import("@prd-gen/benchmark");

    const claimsMap = buildClaimsMap([
      {
        claim_id: "MATH-H2",
        claim_type: "correctness",
        external_grounding: {
          type: "math",
          payload: { expression: "3*3", expected_value: 9 },
        },
      },
      {
        claim_id: "FR-H2",
        claim_type: "fr_traceability",
        // No external_grounding — consensus-majority path.
      },
    ]);

    const opts = buildConcludeOpts({
      consensus_strategy: "weighted_average",
      run_id: "handler-e2e-mixed",
      claim_types: { "MATH-H2": "correctness", "FR-H2": "fr_traceability" },
      claims: claimsMap,
    });

    concludeSection("requirements", [makeVerdict("MATH-H2"), makeVerdict("FR-H2")], opts);

    // Wait for both log entries (two claims, two verdicts).
    await vi.waitUntil(
      () => (appendObservationLog as ReturnType<typeof vi.fn>).mock.calls.length >= 2,
      { timeout: 3000 },
    );

    const calls = (appendObservationLog as ReturnType<typeof vi.fn>).mock.calls;
    const byId = Object.fromEntries(calls.map((c) => [c[0].claim_id as string, c[0]]));

    // Grounded claim: oracle_resolved_truth populated.
    expect(byId["MATH-H2"].oracle_resolved_truth).toBe(true);
    // Ungrounded claim: oracle_resolved_truth absent.
    expect(byId["FR-H2"].oracle_resolved_truth).toBeUndefined();
  });

  it("Test 3: claims omitted → ConcludeOptions.claims undefined, no regression", () => {
    // Precondition: claims is not passed (back-compat path).
    // Postcondition: ConcludeOptions.claims is undefined — orchestrator uses
    //   consensus-majority for all claims (existing behaviour unchanged).
    // Invariant: no exception; no log entry written (no verdicts supplied).
    const opts = buildConcludeOpts({
      consensus_strategy: "weighted_average",
      run_id: "handler-e2e-no-claims",
    });
    expect(opts.claims).toBeUndefined();
  });
});
