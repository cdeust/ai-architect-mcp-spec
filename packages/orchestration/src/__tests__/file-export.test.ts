import { describe, expect, it } from "vitest";
import { newPipelineState, step } from "../index.js";
import type { PipelineState } from "../index.js";
import { resolveRemember } from "./helpers/resolve-completion.js";

function stateAtFileExport(): PipelineState {
  const s = newPipelineState({
    run_id: "test_export_001",
    feature_description: "x",
  });
  return {
    ...s,
    current_step: "file_export",
    prd_context: "feature",
    sections: [
      {
        section_type: "overview",
        status: "passed",
        attempt: 1,
        violation_count: 0,
        last_violations: [],
        content: "Overview content",
      },
    ],
  };
}

/**
 * A "feature" context run with content for every SCHEDULED section
 * (SECTIONS_BY_CONTEXT.feature: overview, goals, requirements, user_stories,
 * technical_specification, acceptance_criteria, data_model,
 * api_specification, security_considerations, performance_requirements,
 * testing) plus a JIRA tickets section. `deployment`/`timeline`/`risks`
 * (06) and `source_code`/`test_code` (08/09) are deliberately absent — no
 * PRD context ever schedules them — so this fixture exercises BOTH the
 * "content present → file written" and "not in context profile → skipped,
 * listed in run-notes" branches in one state.
 */
function stateAtFileExportFullyPopulated(): PipelineState {
  const s = newPipelineState({
    run_id: "test_export_002",
    feature_description: "full feature",
  });
  const passed = (
    section_type: PipelineState["sections"][number]["section_type"],
    content: string,
  ): PipelineState["sections"][number] => ({
    section_type,
    status: "passed",
    attempt: 1,
    violation_count: 0,
    last_violations: [],
    content,
  });
  return {
    ...s,
    current_step: "file_export",
    prd_context: "feature",
    sections: [
      passed("overview", "Overview content"),
      passed("goals", "Goals content"),
      passed("requirements", "Requirements content"),
      passed("user_stories", "User stories content"),
      passed("technical_specification", "Technical spec content"),
      passed("acceptance_criteria", "Acceptance criteria content"),
      passed("data_model", "Data model content"),
      passed("api_specification", "API spec content"),
      passed("security_considerations", "Security content"),
      passed("performance_requirements", "Performance content"),
      passed("testing", "Testing content"),
      passed("jira_tickets", "JIRA ticket content"),
    ],
  };
}

/**
 * Drain every write_file until the handler produces a non-write_file
 * action. This crosses file_export's own multi-file loop AND
 * implementation_gate's single verification-report write (see
 * implementation-gate.ts module doc) — both use the identical
 * write_file/file_written protocol, so a generic drain captures the full
 * exported-file set for a "PRD only" (default) run.
 */
function drainFileExport(state: PipelineState): {
  written: string[];
  final: ReturnType<typeof step>;
} {
  const written: string[] = [];
  let current = state;
  let out = step({ state: current });
  for (let i = 0; i < 20 && out.action.kind === "write_file"; i++) {
    written.push(out.action.path);
    const next = step({
      state: current,
      result: { kind: "file_written", path: out.action.path, bytes: 1 },
    });
    current = next.state;
    out = next;
  }
  return { written, final: out };
}

describe("file_export handler", () => {
  it("emits the first write_file when no files are written yet", () => {
    const out = step({ state: stateAtFileExport() });
    expect(out.action.kind).toBe("write_file");
    if (out.action.kind === "write_file") {
      expect(out.action.path).toMatch(/01-prd\.md$/);
    }
  });

  it("appends the path to written_files on file_written result", () => {
    const s = stateAtFileExport();
    const next = step({
      state: s,
      result: {
        kind: "file_written",
        path: "prd-output/test_exp/01-prd.md",
        bytes: 100,
      },
    });
    expect(next.state.written_files).toContain("prd-output/test_exp/01-prd.md");
  });

  it("does not double-record a file that was already recorded", () => {
    const s: PipelineState = {
      ...stateAtFileExport(),
      written_files: ["prd-output/test_exp/01-prd.md"],
    };
    const next = step({
      state: s,
      result: {
        kind: "file_written",
        path: "prd-output/test_exp/01-prd.md",
        bytes: 100,
      },
    });
    const occurrences = next.state.written_files.filter(
      (p) => p === "prd-output/test_exp/01-prd.md",
    ).length;
    expect(occurrences).toBe(1);
  });

  it("logs an error when an unexpected result kind arrives", () => {
    const s = stateAtFileExport();
    const next = step({
      state: s,
      result: {
        kind: "tool_result",
        correlation_id: "wrong",
        success: true,
        data: {},
      },
    });
    expect(
      next.state.errors.some((e) => e.includes("[file_export] unexpected")),
    ).toBe(true);
    // Pipeline does not advance — re-issues the write.
    expect(next.action.kind).toBe("write_file");
  });

  it("never writes a placeholder file — a section with no content is omitted, not stubbed", () => {
    const { written } = drainFileExport(stateAtFileExport());
    // Only "overview" has content, so ONLY 01-prd.md (core document),
    // 00-run-notes.md (every companion file is skipped), and
    // 10-verification-report.md (implementation_gate's report write) are
    // written — no 02-*.md..09-*.md placeholder stub.
    expect(written).toEqual([
      "prd-output/test_exp/01-prd.md",
      "prd-output/test_exp/00-run-notes.md",
      "prd-output/test_exp/10-verification-report.md",
    ]);
  });

  it("00-run-notes.md names every skipped file and a reason, never fabricates content", () => {
    const { written, final } = drainFileExport(stateAtFileExport());
    void final;
    const s2 = stateAtFileExport();
    let current = s2;
    let out = step({ state: current });
    let runNotesContent = "";
    for (let i = 0; i < 20 && out.action.kind === "write_file"; i++) {
      if (out.action.path.endsWith("00-run-notes.md")) {
        runNotesContent = out.action.content;
      }
      const next = step({
        state: current,
        result: { kind: "file_written", path: out.action.path, bytes: 1 },
      });
      current = next.state;
      out = next;
    }
    expect(written).toContain("prd-output/test_exp/00-run-notes.md");
    expect(runNotesContent).toContain("# Run Notes");
    // data_model IS scheduled for "feature" context but has no content →
    // "skipped" (not "not part of this run's PRD context profile").
    expect(runNotesContent).toMatch(/Data Model.*not generated in this run/);
    // source_code is NEVER scheduled for any PRD context.
    expect(runNotesContent).toMatch(
      /Source Code.*not part of this run's PRD context profile/,
    );
  });

  it("transitions through self_check once every scheduled file is written (no gaps)", () => {
    const { final } = drainFileExport(stateAtFileExport());
    const out = resolveRemember(final);
    expect(out.state.current_step).toBe("complete");
    expect(out.action.kind).toBe("done");
  });

  it("writes every generated file with real content and skips only the unscheduled ones, keeping numbering stable", () => {
    const { written } = drainFileExport(stateAtFileExportFullyPopulated());
    expect(written).toEqual(
      expect.arrayContaining([
        "prd-output/test_exp/01-prd.md",
        "prd-output/test_exp/02-data-model.md",
        "prd-output/test_exp/03-api-spec.md",
        "prd-output/test_exp/04-security.md",
        "prd-output/test_exp/05-testing.md",
        "prd-output/test_exp/07-jira-tickets.md",
        "prd-output/test_exp/00-run-notes.md",
      ]),
    );
    // 06 (deployment/timeline/risks), 08 (source_code), 09 (test_code) are
    // never scheduled for "feature" context — correctly absent, not stubbed.
    expect(written).not.toContain("prd-output/test_exp/06-deployment.md");
    expect(written).not.toContain("prd-output/test_exp/08-source-code.md");
    expect(written).not.toContain("prd-output/test_exp/09-test-code.md");
  });
});

/** Every write_file action (path → content) of a file_export drain. */
function exportedContents(state: PipelineState): Map<string, string> {
  const files = new Map<string, string>();
  let current = state;
  let out = step({ state: current });
  for (let i = 0; i < 20 && out.action.kind === "write_file"; i++) {
    files.set(out.action.path, out.action.content);
    const next = step({
      state: current,
      result: { kind: "file_written", path: out.action.path, bytes: 1 },
    });
    current = next.state;
    out = next;
  }
  return files;
}

/** Drives file_export until every file is written; returns the state it leaves. */
function runToSelfCheck(state: PipelineState): PipelineState {
  let out = step({ state });
  for (let i = 0; i < 20 && out.action.kind === "write_file"; i++) {
    out = step({
      state: out.state,
      result: { kind: "file_written", path: out.action.path, bytes: 1 },
    });
  }
  expect(out.action.kind).not.toBe("write_file");
  return out.state;
}

/** The fully populated fixture with the named sections failed, drafts kept. */
function withFailed(
  types: readonly PipelineState["sections"][number]["section_type"][],
): PipelineState {
  const s = stateAtFileExportFullyPopulated();
  return {
    ...s,
    sections: s.sections.map((section) =>
      types.includes(section.section_type)
        ? {
            ...section,
            status: "failed" as const,
            attempt: 3,
            violation_count: 4,
            content: `FAILED DRAFT of ${section.section_type}`,
          }
        : section,
    ),
  };
}

// source: cdeust/ai-architect-mcp-spec#122 — failSection keeps the last draft
// in state, and the audit of v0.8.0 found those drafts exported as deliverables.
describe("file_export handler — failed sections are withheld, never exported", () => {
  it("leaves a failed core section's draft out of 01-prd.md and names it in run notes", () => {
    const files = exportedContents(withFailed(["goals"]));
    const prd = files.get("prd-output/test_exp/01-prd.md")!;
    expect(prd).not.toContain("FAILED DRAFT");
    expect(prd).not.toContain("## Goals & Objectives");
    expect(prd).toContain("Overview content");
    const notes = files.get("prd-output/test_exp/00-run-notes.md")!;
    expect(notes).toContain(
      "- **Goals & Objectives** (`01-prd.md`): failed after 3 attempt(s) with 4 violation(s).",
    );
  });

  it("skips a companion file whose only source failed, as failed_validation", () => {
    const files = exportedContents(withFailed(["data_model"]));
    expect(files.has("prd-output/test_exp/02-data-model.md")).toBe(false);
    const notes = files.get("prd-output/test_exp/00-run-notes.md")!;
    expect(notes).toMatch(
      /Data Model\*\* \(`02-data-model.md`\): section generation failed validation/,
    );
    expect(notes).toContain("- **Data Model** (`02-data-model.md`): failed after 3 attempt(s)");
  });

  it("keeps the passed half of a two-source file and withholds the failed half", () => {
    const files = exportedContents(withFailed(["performance_requirements"]));
    const security = files.get("prd-output/test_exp/04-security.md")!;
    expect(security).toContain("Security content");
    expect(security).not.toContain("FAILED DRAFT");
  });

  it("names every file a failed section would have fed", () => {
    const files = exportedContents(withFailed(["acceptance_criteria"]));
    for (const [path, content] of files) {
      if (!path.endsWith("00-run-notes.md")) expect(content, path).not.toContain("FAILED DRAFT");
    }
    expect(files.get("prd-output/test_exp/00-run-notes.md")).toContain(
      "- **Acceptance Criteria** (`01-prd.md`, `05-testing.md`, `07-jira-tickets.md`): failed after 3 attempt(s)",
    );
  });

  it("skips 07-jira-tickets.md as failed_validation when every JIRA source failed", () => {
    const s = withFailed(["requirements", "user_stories", "acceptance_criteria"]);
    // jira_generation builds nothing from failed drafts, so no ticket section exists.
    const files = exportedContents({
      ...s,
      sections: s.sections.filter((section) => section.section_type !== "jira_tickets"),
    });
    expect(files.has("prd-output/test_exp/07-jira-tickets.md")).toBe(false);
    expect(files.get("prd-output/test_exp/00-run-notes.md")).toMatch(
      /JIRA Tickets\*\* \(`07-jira-tickets.md`\): section generation failed validation/,
    );
  });

  it("keeps 07-jira-tickets.md as merely skipped when there is no JIRA source material", () => {
    const files = exportedContents(stateAtFileExport());
    expect(files.get("prd-output/test_exp/00-run-notes.md")).toMatch(
      /JIRA Tickets\*\* \(`07-jira-tickets.md`\): not generated in this run/,
    );
  });

  it("keeps 07-jira-tickets.md as merely skipped when one JIRA source failed and another passed", () => {
    const s = withFailed(["user_stories"]);
    const files = exportedContents({
      ...s,
      sections: s.sections.filter((section) => section.section_type !== "jira_tickets"),
    });
    expect(files.get("prd-output/test_exp/00-run-notes.md")).toMatch(
      /JIRA Tickets\*\* \(`07-jira-tickets.md`\): not generated in this run/,
    );
  });

  it("writes no sidecar from a failed technical_specification draft and names it in run notes", () => {
    const s = withFailed(["technical_specification"]);
    const files = exportedContents(s);
    expect(files.get("prd-output/test_exp/01-prd.md")).not.toContain("FAILED DRAFT");
    // An absent sidecar means "extraction did not run" (module doc): a
    // withheld draft is not an extraction result (#122).
    expect(files.has("prd-output/test_exp/stage-5.affected_symbols.json")).toBe(false);
    expect(files.get("prd-output/test_exp/00-run-notes.md")).toContain(
      "- **Technical Specification** (`01-prd.md`, `stage-5.affected_symbols.json`): failed after",
    );
    expect(runToSelfCheck(s).affected_symbols_path).toBeNull();
  });

  it("does not list a failed section with no draft, but still skips its file as failed_validation", () => {
    const s = withFailed(["data_model"]);
    const files = exportedContents({
      ...s,
      sections: s.sections.map((section) =>
        section.section_type === "data_model" ? { ...section, content: undefined } : section,
      ),
    });
    const notes = files.get("prd-output/test_exp/00-run-notes.md")!;
    expect(notes).toMatch(/Data Model\*\* \(`02-data-model.md`\): section generation failed validation/);
    expect(notes).not.toContain("following sections failed validation");
  });

  it("lists withheld sections apart from the skipped files in run notes", () => {
    const s = stateAtFileExport();
    const files = exportedContents({
      ...s,
      prd_context: "poc",
      sections: [
        ...s.sections,
        {
          section_type: "goals",
          status: "failed",
          attempt: 3,
          violation_count: 2,
          last_violations: [],
          content: "FAILED DRAFT of goals",
        },
      ],
    });
    const notes = files.get("prd-output/test_exp/00-run-notes.md")!;
    expect(notes).toContain("- **Goals & Objectives** (`01-prd.md`): failed after 3 attempt(s) with 2 violation(s).");
    const skippedAt = notes.indexOf("were not generated in this run");
    const withheldAt = notes.indexOf("following sections failed validation");
    expect(skippedAt).toBeGreaterThan(-1);
    expect(withheldAt).toBeGreaterThan(skippedAt);
    expect(files.get("prd-output/test_exp/01-prd.md")).not.toContain("FAILED DRAFT");
  });
});

describe("file_export handler — stage-5.affected_symbols.json sidecar", () => {
  const AFFECTED_SYMBOLS_BLOCK = [
    "## Technical Specification",
    "",
    "We use ports-and-adapters architecture.",
    "",
    "<!-- AFFECTED_SYMBOLS_JSON -->",
    "```json",
    JSON.stringify({
      affected_symbols: [
        {
          qualified_name: "src/main.rs::handle_tool_call",
          change_kind: "modify",
          rationale: "add retry logic",
        },
      ],
    }),
    "```",
  ].join("\n");

  function stateWithTechSpec(content: string): PipelineState {
    const s = stateAtFileExport();
    return {
      ...s,
      sections: [
        ...s.sections,
        {
          section_type: "technical_specification",
          status: "passed",
          attempt: 1,
          violation_count: 0,
          last_violations: [],
          content,
        },
      ],
    };
  }

  it("emits the sidecar as an extra file when the technical_specification section carries claims", () => {
    const s: PipelineState = {
      ...stateWithTechSpec(AFFECTED_SYMBOLS_BLOCK),
      written_files: [
        "prd-output/test_exp/01-prd.md",
        "prd-output/test_exp/00-run-notes.md",
      ],
    };
    const out = step({ state: s });
    expect(out.action.kind).toBe("write_file");
    if (out.action.kind === "write_file") {
      expect(out.action.path).toBe(
        "prd-output/test_exp/stage-5.affected_symbols.json",
      );
      const parsed = JSON.parse(out.action.content);
      expect(parsed.affected_symbols).toEqual([
        {
          qualified_name: "src/main.rs::handle_tool_call",
          change_kind: "modify",
          rationale: "add retry logic",
        },
      ]);
    }
  });

  it("does NOT emit a sidecar when technical_specification never ran at all (the true 'absent' state — extraction did not run)", () => {
    const { written } = drainFileExport(stateAtFileExport()); // only "overview"; no technical_specification section exists
    expect(
      written.some((p) => p.endsWith("stage-5.affected_symbols.json")),
    ).toBe(false);
  });

  // Root-cause regression coverage (ai-architect-mcp-codebase stages/stage-6.md
  // §4.2, "Zero-claims case — not the same as absent", pinned at commit
  // 92216cd90f8f26cb15348675fc6556b8293edfc1): a PRD whose
  // technical_specification section RAN and legitimately found zero
  // code-level claims (docs-only/infra-only change) MUST still get the
  // sidecar written, with empty arrays — never treated the same as "the
  // section never ran". Before the fix, `affectedSymbolsFile` returned null
  // whenever `affected_symbols.length === 0`, indistinguishable from the
  // section never having run.
  it("emits the sidecar with EMPTY arrays (not null/omitted) when technical_specification ran and explicitly asserted zero claims", () => {
    const ZERO_CLAIMS_BLOCK = [
      "## Technical Specification",
      "",
      "This PRD only updates documentation; no code symbols are touched.",
      "",
      "<!-- AFFECTED_SYMBOLS_JSON -->",
      "```json",
      JSON.stringify({ affected_symbols: [], scope_claims: [] }),
      "```",
    ].join("\n");
    const s: PipelineState = {
      ...stateWithTechSpec(ZERO_CLAIMS_BLOCK),
      written_files: [
        "prd-output/test_exp/01-prd.md",
        "prd-output/test_exp/00-run-notes.md",
      ],
    };
    const out = step({ state: s });
    expect(out.action.kind).toBe("write_file");
    if (out.action.kind === "write_file") {
      expect(out.action.path).toBe(
        "prd-output/test_exp/stage-5.affected_symbols.json",
      );
      expect(JSON.parse(out.action.content)).toEqual({
        affected_symbols: [],
        scope_claims: [],
      });
    }
  });

  it("emits the sidecar with EMPTY arrays even when the model omits the affected-symbols block entirely, as long as technical_specification ran and produced content", () => {
    const NO_BLOCK_CONTENT = [
      "## Technical Specification",
      "",
      "This PRD only updates documentation; no code symbols are touched.",
    ].join("\n");
    const { written } = drainFileExport(stateWithTechSpec(NO_BLOCK_CONTENT));
    expect(written).toContain("prd-output/test_exp/stage-5.affected_symbols.json");
  });

  it("records affected_symbols_path in state once the sidecar is written", () => {
    const s: PipelineState = {
      ...stateWithTechSpec(AFFECTED_SYMBOLS_BLOCK),
      written_files: [
        "prd-output/test_exp/01-prd.md",
        "prd-output/test_exp/00-run-notes.md",
        "prd-output/test_exp/stage-5.affected_symbols.json",
      ],
    };
    const out = step({ state: s });
    expect(out.state.affected_symbols_path).toBe(
      "prd-output/test_exp/stage-5.affected_symbols.json",
    );
    expect(out.state.current_step).toBe("self_check");
  });

  it("strips the affected-symbols block from the human-readable 01-prd.md content", () => {
    const s = stateWithTechSpec(AFFECTED_SYMBOLS_BLOCK);
    const out = step({ state: s });
    expect(out.action.kind).toBe("write_file");
    if (out.action.kind === "write_file" && out.action.path.endsWith("01-prd.md")) {
      expect(out.action.content).not.toContain("AFFECTED_SYMBOLS_JSON");
      expect(out.action.content).not.toContain("affected_symbols");
      expect(out.action.content).toContain(
        "We use ports-and-adapters architecture.",
      );
    }
  });
});

describe("file_export handler — one heading per section (#122)", () => {
  /** The fully populated fixture with the named section's draft replaced. */
  function withDraft(
    type: PipelineState["sections"][number]["section_type"],
    content: string,
  ): PipelineState {
    const s = stateAtFileExportFullyPopulated();
    return {
      ...s,
      sections: s.sections.map((section) =>
        section.section_type === type ? { ...section, content } : section,
      ),
    };
  }

  function count(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it("exports a draft that starts with its own heading (prompt rule 2) under one heading", () => {
    const files = exportedContents(withDraft("goals", "## Goals & Objectives\n\nShip it."));
    const prd = files.get("prd-output/test_exp/01-prd.md")!;
    expect(count(prd, "Goals & Objectives")).toBe(1);
    expect(prd).toContain("## Goals & Objectives\n\nShip it.");
  });

  it("deduplicates a companion file's heading whatever the draft's level and case", () => {
    const files = exportedContents(withDraft("data_model", "# data   MODEL\n\n\n  - users table"));
    const dataModel = files.get("prd-output/test_exp/02-data-model.md")!;
    expect(count(dataModel.toLowerCase().replace(/[ \t]+/g, " "), "data model")).toBe(1);
    expect(dataModel).toContain("## Data Model\n\n  - users table");
  });

  it("drops a closed ATX heading and stays linear on a long run of spaces", () => {
    const closed = exportedContents(withDraft("goals", "### Goals & Objectives ###\n\nShip it."));
    expect(closed.get("prd-output/test_exp/01-prd.md")).toContain("## Goals & Objectives\n\nShip it.");

    const spaces = `## ${" ".repeat(50_000)}x`;
    const started = performance.now();
    const files = exportedContents(withDraft("goals", spaces));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(files.get("prd-output/test_exp/01-prd.md")).toContain(spaces);
  });

  it("drops the heading of a CRLF draft and a closing run followed by spaces", () => {
    const crlf = exportedContents(withDraft("goals", "## Goals & Objectives\r\n\r\nShip it."));
    expect(count(crlf.get("prd-output/test_exp/01-prd.md")!, "Goals & Objectives")).toBe(1);
    const trailing = exportedContents(withDraft("goals", "## Goals & Objectives ##  \n\nShip it."));
    expect(count(trailing.get("prd-output/test_exp/01-prd.md")!, "Goals & Objectives")).toBe(1);
  });

  it("keeps a trailing # that is part of the title, not a closing sequence", () => {
    const files = exportedContents(withDraft("goals", "## Goals & Objectives#\n\nShip it."));
    expect(files.get("prd-output/test_exp/01-prd.md")).toContain(
      "## Goals & Objectives\n\n## Goals & Objectives#\n\nShip it.",
    );
  });

  it("keeps a leading heading that does not name the section", () => {
    const files = exportedContents(withDraft("goals", "## Context\n\nWhy now."));
    expect(files.get("prd-output/test_exp/01-prd.md")).toContain(
      "## Goals & Objectives\n\n## Context\n\nWhy now.",
    );
  });
});
