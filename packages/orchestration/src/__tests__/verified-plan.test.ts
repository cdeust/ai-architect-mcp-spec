import { createHash } from "node:crypto";
import { DefineHandoffV1Schema } from "@prd-gen/core";
import { expect, it } from "vitest";
import { buildVerifiedPlan, verifyPlanProposal } from "../verified-plan.js";

const intent = "Vérifier la livraison";
const define = DefineHandoffV1Schema.parse({
  version: 1,
  run_id: "run_plan_fixture",
  requirements: [
    { id: "FR-001", text: "Retain a receipt." },
    { id: "NFR-001", text: "Preserve its bytes." },
  ],
  acceptance: [
    { id: "AC-001", text: "Compare file bytes.", requirement_ids: ["FR-001", "NFR-001"] },
    { id: "AC-002", text: "Check the receipt.", requirement_ids: ["FR-001"] },
  ],
});
const proposal = {
  step: "delivery",
  objective: "Vérifier la livraison\nFR-001: Retain a receipt.\nNFR-001: Preserve its bytes.",
  verification: "AC-001 [FR-001, NFR-001]: Compare file bytes.\nAC-002 [FR-001]: Check the receipt.",
  acceptance_ids: ["AC-001", "AC-002"],
};

function sha256(file: string) {
  return createHash("sha256").update(Buffer.from(file, "utf8")).digest("hex");
}

it("binds the exact Define and proposal JSON files to the plan", () => {
  const binding = {
    version: 1,
    run_id: define.run_id,
    define_sha256: sha256(JSON.stringify({ handoff: define }) + "\n"),
    proposal_sha256: sha256(JSON.stringify(proposal) + "\n"),
  };
  const expected = {
    verified_plan: { ...binding, plan_sha256: sha256(JSON.stringify(binding) + "\n"), proposal },
  };
  expect(buildVerifiedPlan(define, intent, "delivery")).toEqual(expected);
  expect(buildVerifiedPlan(define, intent, "delivery")).toEqual(expected);
  expect(buildVerifiedPlan(define, intent, "retention")).not.toEqual(expected);
  expect(buildVerifiedPlan({ ...define, run_id: "run_another" }, intent, "delivery")).not.toEqual(expected);
  expect(verifyPlanProposal(define, intent, proposal)).toEqual(proposal);
});

it.each([
  { acceptance_ids: ["AC-001"] },
  { acceptance_ids: ["AC-001", "AC-002", "AC-003"] },
  { acceptance_ids: ["AC-001", "AC-001"] },
  { acceptance_ids: ["AC-001", "AC-003"] },
  { acceptance_ids: ["AC-002", "AC-001"] },
  { verification: proposal.verification.replace(", NFR-001", "") },
  { verification: proposal.verification.replace("Compare", "Compare normalized") },
  { objective: proposal.objective.replace("its bytes", "most bytes") },
  { objective: " " },
  { args: [] },
  { approved: true },
  { models: {} },
])("refuses proposal changed by %j", patch => {
  expect(verifyPlanProposal(define, intent, { ...proposal, ...patch })).toBeUndefined();
});

it.each([undefined, "", "../delivery", "Delivery", "delivery\n", "a".repeat(33)])(
  "refuses invalid Step name %j",
  step => expect(buildVerifiedPlan(define, intent, step)).toEqual({
    error: { code: "plan_step_invalid", message: "Supply a valid architect-os Step name in plan_step." },
  }),
);

it("refuses empty saved intent", () => {
  expect(buildVerifiedPlan(define, " ", "delivery")).toEqual({
    error: { code: "plan_source_invalid", message: "The saved intent and Define criteria must yield a complete plan." },
  });
});

it("keeps the approved proposal text stable at the Step and whitespace boundaries", () => {
  const padded = DefineHandoffV1Schema.parse({
    ...define,
    requirements: define.requirements.map((requirement, index) =>
      index === 1 ? { ...requirement, text: requirement.text + "  " } : requirement),
    acceptance: define.acceptance.map((criterion, index) =>
      index === 1 ? { ...criterion, text: criterion.text + "\n" } : criterion),
  });
  const step = "delivery-2" + "a".repeat(22);
  expect(buildVerifiedPlan(padded, "  " + intent + "\n", step)).toMatchObject({
    verified_plan: { proposal: { ...proposal, step } },
  });
});
