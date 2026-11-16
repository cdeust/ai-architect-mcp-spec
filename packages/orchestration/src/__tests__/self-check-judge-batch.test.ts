/**
 * Issue #119: one judge prompt per (judge, model) batch, the PRD embedded
 * once, one JSON array of verdicts back. These tests pin the index that
 * maps (judge × claim) requests to invocations and the parser that reads a
 * batched answer back per claim.
 */
import { describe, it, expect } from "vitest";
import type { ActionResult } from "../types/actions.js";
import type { JudgeRequest } from "@prd-gen/core";
import { buildJudgeIndex, groupJudgeIndex, parseVerdicts } from "../handlers/self-check-verdicts.js";
import { DEFAULT_VERIFY_BUDGET } from "../handlers/self-check-verify-budget.js";

function request(claim_id: string, judgeName = "fermi", claim_type: "fr_traceability" | "architecture" = "fr_traceability"): JudgeRequest {
  return {
    judge: { kind: "genius", name: judgeName },
    claim: { claim_id, claim_type, text: `claim ${claim_id}`, evidence: "e" },
    context: { prd_excerpt: "PRD", codebase_excerpts: [], memory_excerpts: [] },
  };
}

function verdict(claim_id: string | undefined, v = "PASS") {
  return { ...(claim_id ? { claim_id } : {}), verdict: v, rationale: `r ${claim_id}`, caveats: [], confidence: 0.8 };
}

function batch(responses: Array<{ invocation_id: string; raw_text?: string; error?: string }>): Extract<ActionResult, { kind: "subagent_batch_result" }> {
  return { kind: "subagent_batch_result", batch_id: "self_check_verify", responses };
}

describe("buildJudgeIndex batches requests per (judge, model)", () => {
  it("gives the requests of one judge and one model one invocation, numbered by first appearance", () => {
    const index = buildJudgeIndex(
      [request("FR-001"), request("FR-002", "curie"), request("FR-003"), request("FR-004", "curie")],
      DEFAULT_VERIFY_BUDGET,
    );
    expect(index.map((e) => e.invocation_id)).toEqual([
      "self_check_judge_0000",
      "self_check_judge_0001",
      "self_check_judge_0000",
      "self_check_judge_0001",
    ]);
    expect(groupJudgeIndex(index).map((g) => g.map((e) => e.request.claim.claim_id))).toEqual([
      ["FR-001", "FR-003"],
      ["FR-002", "FR-004"],
    ]);
  });

  it("splits a judge's batch by model: an architecture claim's diversity slots never share a prompt", () => {
    const index = buildJudgeIndex(
      [request("ARCH-1", "fermi", "architecture"), request("ARCH-1", "curie", "architecture"), request("ARCH-2", "fermi", "architecture")],
      DEFAULT_VERIFY_BUDGET,
    );
    for (const group of groupJudgeIndex(index)) {
      expect(new Set(group.map((e) => e.model)).size).toBe(1);
      expect(new Set(group.map((e) => e.request.judge.name)).size).toBe(1);
    }
  });

  it("opens a new invocation rather than asking one judge about the same claim twice", () => {
    const index = buildJudgeIndex([request("FR-001"), request("FR-001")], DEFAULT_VERIFY_BUDGET);
    expect(index[0].invocation_id).not.toBe(index[1].invocation_id);
  });
});

describe("parseVerdicts reads a batched answer per claim", () => {
  const index = buildJudgeIndex([request("FR-001"), request("FR-002"), request("FR-003")], DEFAULT_VERIFY_BUDGET);
  const id = index[0].invocation_id;

  it("matches each object of the array to its claim, whatever the order", () => {
    const out = parseVerdicts(index, batch([{ invocation_id: id, raw_text: JSON.stringify([verdict("FR-003", "FAIL"), verdict("FR-001"), verdict("FR-002", "NEEDS-RUNTIME")]) }]));
    expect(out.map((v) => [v.claim_id, v.verdict])).toEqual([
      ["FR-001", "PASS"],
      ["FR-002", "NEEDS-RUNTIME"],
      ["FR-003", "FAIL"],
    ]);
    expect(out.every((v) => v.model === DEFAULT_VERIFY_BUDGET.diversity_models[0])).toBe(true);
  });

  it("degrades a claim the array leaves out, answers twice or answers invalidly to INCONCLUSIVE parse_error", () => {
    const raw = JSON.stringify([verdict("FR-001"), verdict("FR-001"), { claim_id: "FR-002", verdict: "MAYBE" }, verdict("OTHER")]);
    const out = parseVerdicts(index, batch([{ invocation_id: id, raw_text: raw }]));
    expect(out.map((v) => v.verdict)).toEqual(["INCONCLUSIVE", "INCONCLUSIVE", "INCONCLUSIVE"]);
    expect(out.every((v) => v.caveats.includes("parse_error"))).toBe(true);
    expect(out[0].rationale).toMatch(/two verdicts for claim_id FR-001/);
    expect(out[1].rationale).toMatch(/invalid verdict for claim_id FR-002/);
    expect(out[2].rationale).toMatch(/no verdict for claim_id FR-003/);
  });

  it("refuses a single object for an invocation of several claims", () => {
    const out = parseVerdicts(index, batch([{ invocation_id: id, raw_text: JSON.stringify(verdict(undefined)) }]));
    expect(out.every((v) => v.verdict === "INCONCLUSIVE" && v.caveats.includes("parse_error"))).toBe(true);
  });

  it("maps an errored or missing invocation to INCONCLUSIVE judge_invocation_failed for every claim it carried", () => {
    const errored = parseVerdicts(index, batch([{ invocation_id: id, error: "host skipped" }]));
    expect(errored.map((v) => v.rationale)).toEqual(["host skipped", "host skipped", "host skipped"]);
    expect(errored.every((v) => v.caveats.includes("judge_invocation_failed"))).toBe(true);
    const missing = parseVerdicts(index, batch([]));
    expect(missing.every((v) => v.rationale === "no response")).toBe(true);
  });

  it("accepts the single-object answer for an invocation of one claim, and checks its claim_id", () => {
    const one = buildJudgeIndex([request("AC-001")], DEFAULT_VERIFY_BUDGET);
    const oid = one[0].invocation_id;
    expect(parseVerdicts(one, batch([{ invocation_id: oid, raw_text: JSON.stringify(verdict(undefined, "FAIL")) }]))[0].verdict).toBe("FAIL");
    expect(parseVerdicts(one, batch([{ invocation_id: oid, raw_text: JSON.stringify([verdict("AC-001")]) }]))[0].verdict).toBe("PASS");
    const wrong = parseVerdicts(one, batch([{ invocation_id: oid, raw_text: JSON.stringify(verdict("AC-999")) }]))[0];
    expect(wrong.verdict).toBe("INCONCLUSIVE");
    expect(wrong.rationale).toMatch(/AC-999/);
  });
});
