/**
 * The README's "Exported files per context profile" table lists exactly the
 * files `file_export` writes for each PRD context.
 *
 * Proves: for every context in SECTIONS_BY_CONTEXT, a run whose scheduled
 * sections all passed with content, and whose JIRA generation succeeded,
 * writes the files named on that context's README row, no more and no fewer.
 * This is the most files a run of that context can write; a failed or
 * skipped section can only remove files (see file-export.ts module doc).
 *
 * source: #122 — the README promised "9 files (6 core + 3 companion)"; the
 * v0.8.0 audit of a `feature` run on 2026-10-10 found 7, and 08-source-code.md
 * / 09-test-code.md are fed by section types no context schedules.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RequestSize } from "@prd-gen/core";
import { makeCannedDispatcher, newPipelineState, plannedSections, SECTIONS_BY_CONTEXT, step } from "../index.js";
import type { PipelineState } from "../index.js";

const README = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../README.md"),
  "utf8",
);

type Section = PipelineState["sections"][number];
type Context = keyof typeof SECTIONS_BY_CONTEXT;

const SECTION_CONTENT: Partial<Record<Section["section_type"], string>> = {
  requirements: "- FR-001: Encrypt exported files.",
  acceptance_criteria: "- AC-001: The exported file can only be read with its key (FR-001).",
};

function passed(section_type: Section["section_type"]): Section {
  return {
    section_type,
    status: "passed",
    attempt: 1,
    violation_count: 0,
    last_violations: [],
    attempt_log: [],
    content: SECTION_CONTENT[section_type] ?? `${section_type} content`,
  };
}

/** Basenames written by file_export for a fully passed run of `context`. */
function exportedFiles(context: Context, request_size: RequestSize = "standard"): string[] {
  let state: PipelineState = {
    ...newPipelineState({ run_id: `readme_export_${context}`, feature_description: "x", request_size }),
    current_step: "file_export",
    prd_context: context,
    sections: [...plannedSections(context, request_size).map(passed), passed("jira_tickets")],
  };
  const written: string[] = [];
  const dispatch = makeCannedDispatcher();
  let out = step({ state });
  for (let i = 0; i < 20 && out.action.kind !== "ask_user"; i++) {
    if (out.action.kind === "write_file") {
      const path = out.action.path;
      written.push(path.slice(path.lastIndexOf("/") + 1));
    }
    const result = dispatch(out.action);
    if (!result) break;
    out = step({ state, result });
    state = out.state;
  }
  return written.sort();
}

/** context → file basenames, read from the README table. */
function readmeTable(): Map<string, string[]> {
  const section = README.split("### Exported files per context profile")[1];
  expect(section, "README has an 'Exported files per context profile' section").toBeDefined();
  const rows = new Map<string, string[]>();
  for (const line of (section ?? "").split("\n")) {
    const row = /^\| `([a-z]+)` \| (.+) \|$/.exec(line);
    if (!row) continue;
    const files = [...row[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    rows.set(row[1], files.sort());
  }
  return rows;
}

describe("README exported-files table", () => {
  const table = readmeTable();

  it("has one row per PRD context", () => {
    expect([...table.keys()].sort()).toEqual(Object.keys(SECTIONS_BY_CONTEXT).sort());
  });

  for (const context of Object.keys(SECTIONS_BY_CONTEXT) as Context[]) {
    it(`lists the files a full ${context} run writes`, () => {
      expect(table.get(context)).toEqual(exportedFiles(context));
    });
  }

  it("lists the files a run declared tiny writes, whatever its context but an incident", () => {
    const sentence = /A run declared `request_size: "tiny"` writes (.+?), whatever its context/.exec(README);
    expect(sentence, "README says what a tiny run writes").not.toBeNull();
    const files = [...sentence![1].matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
    for (const context of Object.keys(SECTIONS_BY_CONTEXT) as Context[]) {
      const expected = context === "incident" ? table.get("incident") : files;
      expect(exportedFiles(context, "tiny"), context).toEqual(expected);
    }
  });
});
