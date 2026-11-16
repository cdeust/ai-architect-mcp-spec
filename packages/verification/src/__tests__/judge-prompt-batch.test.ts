import { describe, it, expect } from "vitest";
import type { JudgeRequest } from "@prd-gen/core";
import {
  buildBatchedJudgePrompt,
  buildJudgePrompt,
  claimIdsInJudgePrompt,
} from "../judge-prompt.js";

const PRD = "# PRD\n\nThe whole document, embedded once (issue #119).";

function request(claim_id: string, judgeName = "fermi"): JudgeRequest {
  return {
    judge: { kind: "genius", name: judgeName },
    claim: {
      claim_id,
      claim_type: "fr_traceability",
      text: `claim ${claim_id}`,
      evidence: `evidence of ${claim_id}`,
      source_section: "requirements",
    },
    context: { prd_excerpt: PRD, codebase_excerpts: [], memory_excerpts: [] },
  };
}

describe("buildBatchedJudgePrompt (issue #119)", () => {
  it("embeds the PRD once for every claim of the judge, and lists each claim in order", () => {
    const built = buildBatchedJudgePrompt([request("FR-001"), request("FR-002"), request("FR-003")]);
    expect(built.prompt.split("<prd_excerpt>").length - 1).toBe(1);
    expect(built.prompt.split(PRD).length - 1).toBe(1);
    expect(claimIdsInJudgePrompt(built.prompt)).toEqual(["FR-001", "FR-002", "FR-003"]);
    for (const id of ["FR-001", "FR-002", "FR-003"]) {
      expect(built.prompt).toContain(`evidence of ${id}`);
    }
    expect(built.prompt).toContain('"claim_id"');
    expect(built.description).toBe("Judge 3 claims (genius:fermi)");
  });

  it("is smaller than one prompt per claim by the PRD copies it no longer repeats", () => {
    const requests = [request("FR-001"), request("FR-002"), request("FR-003")];
    const batched = buildBatchedJudgePrompt(requests).prompt.length;
    const separate = requests.map((r) => buildJudgePrompt(r).prompt.length).reduce((a, b) => a + b, 0);
    expect(batched).toBeLessThan(separate - 2 * PRD.length);
  });

  it("reads the claim id of a one-claim prompt of either builder", () => {
    expect(claimIdsInJudgePrompt(buildJudgePrompt(request("AC-007")).prompt)).toEqual(["AC-007"]);
    expect(claimIdsInJudgePrompt(buildBatchedJudgePrompt([request("AC-007")]).prompt)).toEqual(["AC-007"]);
  });

  it("does not read an `id:` line of the PRD as a claim", () => {
    const req = request("FR-001");
    const withIdLine: JudgeRequest = { ...req, context: { ...req.context, prd_excerpt: "id: NOT-A-CLAIM" } };
    expect(claimIdsInJudgePrompt(buildBatchedJudgePrompt([withIdLine]).prompt)).toEqual(["FR-001"]);
  });

  it("refuses an empty batch, mixed judges and mixed PRD excerpts", () => {
    expect(() => buildBatchedJudgePrompt([])).toThrow(/no request/);
    expect(() => buildBatchedJudgePrompt([request("FR-001"), request("FR-002", "curie")])).toThrow(/mixed judges/);
    const other = request("FR-002");
    const otherPrd: JudgeRequest = { ...other, context: { ...other.context, prd_excerpt: "another" } };
    expect(() => buildBatchedJudgePrompt([request("FR-001"), otherPrd])).toThrow(/different PRD/);
  });
});
