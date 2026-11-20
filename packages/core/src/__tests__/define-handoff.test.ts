import { expect, it } from "vitest";
import { DefineHandoffV1Schema } from "../index.js";

const requirement = { id: "FR-001", text: "Stop before publication with `--until ci`." };
const criterion = { id: "AC-001", text: "The command stops after CI (FR-001).", requirement_ids: ["FR-001"] };
const handoff = { version: 1, run_id: "run_define_v1", requirements: [requirement], acceptance: [criterion] };

it("accepts descriptive text and stable references in the v1 contract", () => {
  expect(DefineHandoffV1Schema.parse(handoff)).toEqual(handoff);
});

it.each([
  { version: 2 },
  { run_id: "" },
  { build: { command: "git push" } },
  { requirements: [] },
  { requirements: [{ ...requirement, args: ["--force"] }] },
  { requirements: [{ ...requirement, id: "AC-001" }] },
  { requirements: [{ ...requirement, id: "OLD-FR-001" }] },
  { requirements: [{ ...requirement, id: "FR-001-x" }] },
  { requirements: [{ ...requirement, id: "FR-1234567890" }] },
  { requirements: [{ ...requirement, text: " \n" }] },
  { requirements: [{ ...requirement, text: "..." }] },
  { requirements: [requirement, requirement] },
  { requirements: [requirement, { ...requirement, id: "NFR-001" }] },
  { acceptance: [] },
  { acceptance: [{ ...criterion, policy: "unrestricted" }] },
  { acceptance: [{ ...criterion, id: "FR-001" }] },
  { acceptance: [{ ...criterion, id: "OLD-AC-001" }] },
  { acceptance: [{ ...criterion, id: "AC-001-x" }] },
  { acceptance: [{ ...criterion, id: "AC-1234567890" }] },
  { acceptance: [{ ...criterion, text: "" }] },
  { acceptance: [{ ...criterion, text: "(FR-001)." }] },
  { acceptance: [criterion, criterion] },
  { acceptance: [{ ...criterion, requirement_ids: [] }] },
  { acceptance: [{ ...criterion, requirement_ids: ["FR-001", "FR-001"] }] },
  { acceptance: [{ ...criterion, requirement_ids: ["FR-001", "FR-002"] }] },
])("refuses an incompatible handoff %j", change => {
  expect(DefineHandoffV1Schema.safeParse({ ...handoff, ...change }).success).toBe(false);
});

it("accepts both identifier lengths supported by the document parser", () => {
  const payload = {
    ...handoff,
    requirements: [
      { id: "FR-1", text: "Keep one receipt." },
      { id: "NFR-123456789", text: "Record its digest." },
    ],
    acceptance: [
      { id: "AC-1", text: "Test the receipt.", requirement_ids: ["FR-1"] },
      { id: "AC-123456789", text: "Test the digest.", requirement_ids: ["NFR-123456789"] },
    ],
  };
  expect(DefineHandoffV1Schema.parse(payload)).toEqual(payload);
});

it.each([
  [{ requirements: [requirement, requirement] }, "Define identifiers must be unique."],
  [{ acceptance: [criterion, criterion] }, "Define identifiers must be unique."],
  [{ acceptance: [{ ...criterion, requirement_ids: ["FR-001", "FR-001"] }] }, "AC-001 repeats a requirement reference."],
  [{ acceptance: [{ ...criterion, requirement_ids: ["FR-001", "FR-002"] }] }, "AC-001 references unknown requirement FR-002."],
  [{ requirements: [requirement, { ...requirement, id: "NFR-002" }] }, "NFR-002 has no acceptance criterion."],
] as const)("gives the contract diagnostic for %j", (change, message) => {
  const parsed = DefineHandoffV1Schema.safeParse({ ...handoff, ...change });
  expect(parsed.error?.issues.map(issue => issue.message)).toContain(message);
});
