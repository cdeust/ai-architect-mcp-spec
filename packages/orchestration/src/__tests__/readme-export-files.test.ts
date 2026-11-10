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
import { newPipelineState, SECTIONS_BY_CONTEXT, step } from "../index.js";
import type { PipelineState } from "../index.js";

const README = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../README.md"),
  "utf8",
);

type Section = PipelineState["sections"][number];
type Context = keyof typeof SECTIONS_BY_CONTEXT;

function passed(section_type: Section["section_type"]): Section {
  return {
    section_type,
    status: "passed",
    attempt: 1,
    violation_count: 0,
    last_violations: [],
    attempt_log: [],
    content: `${section_type} content`,
  };
}

/** Basenames written by file_export for a fully passed run of `context`. */
function exportedFiles(context: Context): string[] {
  let state: PipelineState = {
    ...newPipelineState({ run_id: `readme_export_${context}`, feature_description: "x" }),
    current_step: "file_export",
    prd_context: context,
    sections: [...SECTIONS_BY_CONTEXT[context].map(passed), passed("jira_tickets")],
  };
  const written: string[] = [];
  let out = step({ state });
  for (let i = 0; i < 20 && out.action.kind === "write_file"; i++) {
    const path = out.action.path;
    written.push(path.slice(path.lastIndexOf("/") + 1));
    out = step({ state, result: { kind: "file_written", path, bytes: 1 } });
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
});
