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
