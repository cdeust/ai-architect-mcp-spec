import { expect, it } from "vitest";
import { projectDefineDocument } from "../index.js";

it("extracts definitions and resolvable lexical references without counting examples or comments", () => {
  const projected = projectDefineDocument([
    { type: "overview", content: "- FR-990: Another section." },
    { type: "requirements", content: [
      "- **FR-001:** Stop after CI.",
      "",
      "| ID | Requirement |",
      "| --- | --- |",
      "| NFR-002 | Keep a receipt: include its digest. |",
      "",
      "```md",
      "- FR-991: Sample only.",
      "```",
    ].join("\n") },
    { type: "acceptance_criteria", content: [
      "- AC-001: Check the receipt (FR-001, NFR-002).",
      "",
      "<!-- FR-992 -->",
      "",
      "```md",
      "- AC-997: Example only (FR-997).",
      "```",
    ].join("\n") },
  ]);
  expect(projected).toEqual({
    requirements: [{ id: "FR-001", text: "Stop after CI." }, { id: "NFR-002", text: "Keep a receipt: include its digest." }],
    acceptance: [{
      id: "AC-001",
      text: "Check the receipt (FR-001, NFR-002).",
      requirement_ids: ["FR-001", "NFR-002"],
    }],
  });
});

it.each([
  "Write the receipt <!-- (FR-001) -->",
  "Write the receipt `example (FR-001)`",
  "Write the [receipt](FR-001)",
  "Write the receipt (OLD-FR-001).",
  "Write the receipt (FR-001-suffix).",
  "Write the receipt about FR-001.",
  "Write (FR-001) to the receipt.",
])("does not infer traceability from %s", statement => {
  expect(projectDefineDocument([{ type: "acceptance_criteria", content: `- AC-001: ${statement}` }])
    .acceptance[0]?.requirement_ids).toEqual([]);
});

it("returns explicit duplicates so the v1 schema can reject them", () => {
  expect(projectDefineDocument([{ type: "acceptance_criteria", content: "- AC-001: Record it (FR-1\t,FR-1)" }])
    .acceptance[0]?.requirement_ids).toEqual(["FR-1", "FR-1"]);
});

it("requires visible prose in every definition, outside links, examples and comments", () => {
  const document = projectDefineDocument([
    { type: "requirements", content: "- FR-001: Keep the record.\n- FR-002: ...\n- FR-003: FR-002 <!-- Invisible -->" },
    { type: "acceptance_criteria", content: "- AC-001: (FR-001).\n- AC-002: ... (FR-002).\n- AC-003: FR-003 <!-- placeholder --> (FR-003).\n- AC-004: `example` (FR-003)." },
  ]);
  expect(document.requirements).toEqual([
    { id: "FR-001", text: "Keep the record." }, { id: "FR-002", text: "" }, { id: "FR-003", text: "" },
  ]);
  expect(document.acceptance).toEqual([
    { id: "AC-001", text: "", requirement_ids: [] },
    { id: "AC-002", text: "", requirement_ids: ["FR-002"] },
    { id: "AC-003", text: "", requirement_ids: ["FR-003"] },
    { id: "AC-004", text: "", requirement_ids: ["FR-003"] },
  ]);
});

it("keeps a missing reference distinguishable from an absent criterion", () => {
  expect(projectDefineDocument([{ type: "acceptance_criteria", content: "- AC-001: Record the result." }])).toEqual({
    requirements: [],
    acceptance: [{ id: "AC-001", text: "Record the result.", requirement_ids: [] }],
  });
});
