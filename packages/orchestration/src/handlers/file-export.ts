/**
 * File export — write the PRD deliverable files (the core PRD, the companion
 * and JIRA files whose sections passed, one run-notes file when any file was
 * skipped or any failed section was withheld) per SKILL.md Phase 4, plus a
 * sidecar
 * (`stage-5.affected_symbols.json`) whenever the technical_specification
 * section passed with content.
 *
 * Protocol:
 *   - On entry with no result: emit write_file for the first un-written file.
 *   - On file_written result: append to state.written_files, emit the next.
 *   - When state.written_files covers every file in the set → transition to self_check.
 *
 * Progress is tracked in `state.written_files` (a dedicated field). It is
 * NOT folded into `state.errors`; that field is reserved for genuine errors.
 *
 * NO PLACEHOLDER FILES (root-cause fix — see buildFileSet doc below):
 * a companion file whose source section(s) produced no content is NEVER
 * written; its skip and the reason are recorded in `00-run-notes.md`
 * instead. source: e2e run_mrlqa0aj_u2rh15 (2026-07-15) — 5 of 10 exported
 * files were one-line "_No ... section._" placeholders the user discovered
 * only after delivery.
 *
 * NO FAILED DRAFTS AS DELIVERABLES: a section whose terminal status is
 * "failed" keeps its last draft in state (failSection stores it so the run
 * stays inspectable), but that draft is not a deliverable. It is withheld
 * from every exported markdown file, and `00-run-notes.md` names it with
 * its attempt and violation counts. A companion file whose only sources
 * failed is then skipped as "failed_validation". The affected-symbols
 * sidecar below is not built from a failed technical_specification draft
 * either, and pre_impl_grounding queries no symbol of one. JIRA tickets are
 * not generated from failed drafts (jira-generation.ts
 * gatherSourceSections) and self-check does not judge them (self-check.ts
 * gatherSections).
 * source: cdeust/ai-architect-mcp-spec#122 — audit of v0.8.0 on 2026-10-10
 * found failed sections exported as deliverables.
 *
 * The affected-symbols sidecar's presence, not its claim count, is the
 * signal ai-architect-mcp-codebase stage 6 reads: an ABSENT
 * `stage-5.affected_symbols.json` means "the generator's structured-
 * extraction step did not run at all" and triggers the §4.3 regex fallback;
 * a PRESENT sidecar — even with empty `affected_symbols`/`scope_claims`
 * arrays — means "extraction ran and found nothing" (a docs-only or
 * infra-only PRD) and must suppress the fallback. These are different
 * states and conflating them silently routes a legitimate zero-claims PRD
 * through the low-precision regex path. So the sidecar is written whenever
 * the technical_specification section passed with content (extraction
 * ran), regardless of how many claims parseAffectedSymbolsBlock found in
 * it; it is omitted when that section has no exportable content (not
 * scheduled / skipped / failed, with or without a draft). A failed draft is
 * withheld from the PRD, so its claims are not an extraction result: a
 * sidecar built from it, even an empty one, would tell stage 6 "extraction
 * ran" about a section the PRD does not contain. Its absence is the honest
 * signal, and `00-run-notes.md` names the sidecar among the files the
 * failed section would have fed.
 * source: ai-architect-mcp-codebase stages/stage-6.md, "Zero-claims case —
 * not the same as absent" (§4.2), pinned at commit
 * 92216cd90f8f26cb15348675fc6556b8293edfc1.
 */

import type { StepHandler } from "../runner.js";
import { appendError, type PipelineState } from "../types/state.js";
import { SECTIONS_BY_CONTEXT } from "../section-plan.js";
import { JIRA_SOURCE_TYPES } from "./jira-generation.js";
import {
  SECTION_DISPLAY_NAMES,
  SECTION_ORDER,
  parseAffectedSymbolsBlock,
  stripAffectedSymbolsBlock,
  type AffectedSymbolsDocument,
  type SectionType,
} from "@prd-gen/core";

const OUTPUT_DIR = "prd-output";
const AFFECTED_SYMBOLS_FILENAME = "stage-5.affected_symbols.json";
const RUN_NOTES_FILENAME = "00-run-notes.md";

export interface PrdFile {
  readonly path: string;
  readonly content: () => string;
}

/**
 * Why a companion file's source section(s) produced no content.
 *   "not_in_context_profile" — none of the section types feeding this file
 *                               are scheduled for this run's PRD context
 *                               (SECTIONS_BY_CONTEXT[state.prd_context]).
 *   "failed_validation"      — at least one of the section types was
 *                               attempted and its terminal status is
 *                               "failed" (MAX_ATTEMPTS exhausted).
 *                               For JIRA: the subagent failed, or every
 *                               source section that ran failed — see
 *                               jiraSkipReason.
 *   "skipped"                — planned but never reached a terminal state
 *                               with content (e.g. the run ended early), or
 *                               (for JIRA) no source material.
 */
type SkipReason = "not_in_context_profile" | "failed_validation" | "skipped";

const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  not_in_context_profile:
    "not part of this run's PRD context profile — never scheduled for generation",
  failed_validation:
    "section generation failed validation after the maximum number of attempts",
  skipped: "not generated in this run",
};

interface SkippedFile {
  readonly display: string;
  readonly filename: string;
  readonly reason: SkipReason;
}

/**
 * precondition:  `types` is the set of section types a companion file draws
 *                content from (e.g. ["security_considerations",
 *                "performance_requirements"] for 04-security.md).
 * postcondition: "not_in_context_profile" when state.prd_context is known
 *                and NONE of `types` are scheduled for it; else
 *                "failed_validation" when any of `types` reached a
 *                terminal "failed" status; else "skipped" (planned, but no
 *                content landed — e.g. run ended before generation).
 */
function reasonForSectionTypes(
  state: PipelineState,
  types: readonly SectionType[],
): SkipReason {
  const planned = state.prd_context ? SECTIONS_BY_CONTEXT[state.prd_context] : null;
  if (planned && !types.some((t) => planned.includes(t))) {
    return "not_in_context_profile";
  }
  const anyFailed = types.some((t) =>
    state.sections.some((s) => s.section_type === t && s.status === "failed"),
  );
  return anyFailed ? "failed_validation" : "skipped";
}

/**
 * JIRA generation is context-independent (jira-generation.ts runs for every
 * PRD context when source material exists), so `reasonForSectionTypes`'s
 * "not_in_context_profile" bucket does not apply — distinguish "the
 * subagent failed" or "every source that ran failed validation" (no
 * exportable source left, #122) from "there was nothing to build tickets
 * from".
 */
function jiraSkipReason(state: PipelineState): SkipReason {
  const subagentFailed = state.errors.some((e) => e.startsWith("[jira_generation] failed"));
  const sources = state.sections.filter((s) => JIRA_SOURCE_TYPES.includes(s.section_type));
  const sourcesFailed =
    sources.some((s) => s.status === "failed") && !sources.some(exportable);
  return subagentFailed || sourcesFailed ? "failed_validation" : "skipped";
}

type Section = PipelineState["sections"][number];

/**
 * precondition:  none.
 * postcondition: true iff the section carries content that may be exported:
 *                a failed section's draft never is (see module doc).
 */
function exportable(section: Section): boolean {
  return Boolean(section.content) && section.status !== "failed";
}

/**
 * Section body for markdown assembly. Strips the affected-symbols marker
 * block from technical_specification so the internal validator payload
 * never leaks into the human-readable PRD (it is exported separately, as
 * its own sidecar file, when present).
 */
function sectionBody(section: Section): string {
  const trimmed = section.content!.trim();
  return section.section_type === "technical_specification"
    ? stripAffectedSymbolsBlock(trimmed)
    : trimmed;
}

/**
 * precondition:  `display` is the section's SECTION_DISPLAY_NAMES entry.
 * postcondition: `body` without its first line when that line is a markdown
 *                heading (any level) whose text is `display` (case and
 *                inner whitespace ignored), and without the blank lines
 *                that followed it; `body` unchanged otherwise.
 *
 * joinSections owns each section's heading in the exported files. The
 * section prompt (meta-prompting section-prompts.ts COMMON_RULES #2) also
 * tells the model to start its draft with `## <Section Display Name>`, so
 * a compliant draft carried a second copy of the heading the export adds.
 * Only a heading that names the section is removed: any other leading
 * heading is draft content.
 * source: cdeust/ai-architect-mcp-spec#122 — audit of v0.8.0 on 2026-10-10
 * found every exported file with duplicated headings.
 */
function withoutOwnHeading(body: string, display: string): string {
  const newline = body.indexOf("\n");
  const line = newline === -1 ? body : body.slice(0, newline);
  const first = line.endsWith("\r") ? line.slice(0, -1) : line;
  const text = headingText(first);
  if (text === null || normalizeTitle(text) !== normalizeTitle(display)) return body;
  const rest = newline === -1 ? "" : body.slice(newline + 1);
  return rest.slice(leadingBlankLinesLength(rest));
}

/**
 * precondition:  `line` holds no newline.
 * postcondition: the text of an ATX heading line (`#` to `######`, then a
 *                space or tab), without its optional closing sequence (a
 *                run of `#` preceded by a space or tab, then optional
 *                spaces or tabs, as in CommonMark: `## C#` keeps its `#`);
 *                null when `line` is not a heading. Scans by index, with
 *                no regular expression: a backtracking heading pattern is
 *                polynomial on long runs of spaces in model output
 *                (CodeQL js/polynomial-redos on #198).
 */
function headingText(line: string): string | null {
  let level = 0;
  while (level < line.length && line[level] === "#") level++;
  const separator = line[level];
  if (level < 1 || level > 6 || (separator !== " " && separator !== "\t")) return null;
  const isBlank = (ch: string | undefined): boolean => ch === " " || ch === "\t";
  let end = line.length;
  while (end > level && isBlank(line[end - 1])) end--;
  let hashes = end;
  while (hashes > level && line[hashes - 1] === "#") hashes--;
  if (hashes < end && isBlank(line[hashes - 1])) end = hashes;
  return line.slice(level, end);
}

function normalizeTitle(text: string): string {
  return text.split(/[ \t]+/).filter(Boolean).join(" ").toLowerCase();
}

/** Length of the run of whitespace-only lines at the start of `text`. */
function leadingBlankLinesLength(text: string): number {
  let cut = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") cut = i + 1;
    else if (text[i] !== " " && text[i] !== "\t" && text[i] !== "\r") break;
  }
  return cut;
}

function joinSections(
  state: PipelineState,
  types: readonly SectionType[],
): string {
  return state.sections
    .filter((s) => types.includes(s.section_type) && exportable(s))
    .sort(
      (a, b) =>
        SECTION_ORDER[a.section_type] - SECTION_ORDER[b.section_type],
    )
    .map((s) => {
      const display = SECTION_DISPLAY_NAMES[s.section_type];
      return `## ${display}\n\n${withoutOwnHeading(sectionBody(s), display)}`;
    })
    .join("\n\n");
}

function jiraContent(state: PipelineState): string {
  const last = [...state.sections]
    .reverse()
    .find((s) => s.section_type === "jira_tickets" && exportable(s));
  return last?.content?.trim() ?? "";
}

/**
 * precondition:  none.
 * postcondition: returns the technical_specification section when it
 *                passed with content (a failed draft is withheld — see
 *                module doc); null otherwise. This is the sole
 *                signal for "did the generator's structured-extraction step
 *                run at all" — distinct from whether that section's own
 *                affected-symbols block was non-empty (see module doc).
 */
function technicalSpecSection(
  state: PipelineState,
): PipelineState["sections"][number] | null {
  return (
    state.sections.find(
      (s) => s.section_type === "technical_specification" && exportable(s),
    ) ?? null
  );
}

/**
 * Extract affected-symbol claims from the technical_specification section.
 * Claims come exclusively from the LLM's own "Affected Symbols" block (see
 * @prd-gen/meta-prompting section-prompts.ts) — never from
 * `state.codebase_grounding`, which would validate the graph against itself.
 *
 * source: ai-architect-mcp-codebase stages/stage-6.md §4.2, pinned at commit
 * 92216cd90f8f26cb15348675fc6556b8293edfc1.
 */
function affectedSymbolsForState(state: PipelineState): AffectedSymbolsDocument {
  const techSpec = technicalSpecSection(state);
  return techSpec
    ? parseAffectedSymbolsBlock(techSpec.content!)
    : { affected_symbols: [], scope_claims: [] };
}

interface CompanionFileSpec {
  readonly filename: string;
  readonly display: string;
  readonly sectionTypes: readonly SectionType[];
}

/** 02-06, 08-09 — every companion file whose content is section-type-driven. */
const COMPANION_FILES: readonly CompanionFileSpec[] = [
  { filename: "02-data-model.md", display: "Data Model", sectionTypes: ["data_model"] },
  { filename: "03-api-spec.md", display: "API Specification", sectionTypes: ["api_specification"] },
  {
    filename: "04-security.md",
    display: "Security & Performance",
    sectionTypes: ["security_considerations", "performance_requirements"],
  },
  { filename: "05-testing.md", display: "Testing Strategy", sectionTypes: ["testing", "acceptance_criteria"] },
  { filename: "06-deployment.md", display: "Deployment Plan", sectionTypes: ["deployment", "timeline", "risks"] },
  { filename: "08-source-code.md", display: "Source Code", sectionTypes: ["source_code"] },
  { filename: "09-test-code.md", display: "Test Code", sectionTypes: ["test_code"] },
];

const CORE_FILENAME = "01-prd.md";
const JIRA_FILENAME = "07-jira-tickets.md";
const CORE_SECTION_TYPES: readonly SectionType[] = [
  "overview",
  "goals",
  "requirements",
  "user_stories",
  "technical_specification",
  "acceptance_criteria",
];

/**
 * precondition:  none.
 * postcondition: returns the core PRD file (always written).
 */
function corePrdFile(state: PipelineState, base: string): PrdFile {
  return {
    path: `${base}/${CORE_FILENAME}`,
    content: () =>
      [
        `# PRD: ${state.feature_description}`,
        "",
        `Run ID: ${state.run_id}`,
        `Context: ${state.prd_context ?? "unknown"}`,
        "",
        joinSections(state, CORE_SECTION_TYPES),
      ].join("\n"),
  };
}

interface WithheldSection {
  readonly display: string;
  readonly filenames: readonly string[];
  readonly attempt: number;
  readonly violations: number;
}

/**
 * precondition:  none.
 * postcondition: one entry per failed section that holds a draft, in
 *                SECTION_ORDER, naming the file(s) it would have fed. A
 *                failed section with no draft withholds nothing.
 */
function withheldSections(state: PipelineState): WithheldSection[] {
  const files: readonly { filename: string; sectionTypes: readonly SectionType[] }[] = [
    { filename: CORE_FILENAME, sectionTypes: CORE_SECTION_TYPES },
    ...COMPANION_FILES,
    { filename: JIRA_FILENAME, sectionTypes: ["jira_tickets", ...JIRA_SOURCE_TYPES] },
    { filename: AFFECTED_SYMBOLS_FILENAME, sectionTypes: ["technical_specification"] },
  ];
  return state.sections
    .filter((s) => s.status === "failed" && s.content)
    .sort((a, b) => SECTION_ORDER[a.section_type] - SECTION_ORDER[b.section_type])
    .map((s) => ({
      display: SECTION_DISPLAY_NAMES[s.section_type],
      filenames: files
        .filter((f) => f.sectionTypes.includes(s.section_type))
        .map((f) => f.filename),
      attempt: s.attempt,
      violations: s.violation_count,
    }));
}

/**
 * precondition:  none.
 * postcondition: returns every companion + JIRA file THAT HAS CONTENT (no
 *                placeholders — see module doc); every skipped file (empty
 *                content) is appended to `skipped` with its reason instead
 *                (mutates the caller's array — a Move 5 concession kept
 *                local to buildFileSet's single call site).
 */
function companionAndJiraFiles(
  state: PipelineState,
  base: string,
  skipped: SkippedFile[],
): PrdFile[] {
  const files: PrdFile[] = [];
  for (const spec of COMPANION_FILES) {
    const content = joinSections(state, spec.sectionTypes);
    if (content) {
      files.push({ path: `${base}/${spec.filename}`, content: () => content });
    } else {
      skipped.push({
        display: spec.display,
        filename: spec.filename,
        reason: reasonForSectionTypes(state, spec.sectionTypes),
      });
    }
  }

  const jira = jiraContent(state);
  if (jira) {
    files.push({ path: `${base}/${JIRA_FILENAME}`, content: () => jira });
  } else {
    skipped.push({
      display: "JIRA Tickets",
      filename: JIRA_FILENAME,
      reason: jiraSkipReason(state),
    });
  }
  return files;
}

/**
 * precondition:  none.
 * postcondition: returns the affected-symbols sidecar file whenever the
 *                technical_specification section passed with content
 *                (extraction ran), carrying whatever
 *                parseAffectedSymbolsBlock extracted — including empty
 *                `affected_symbols`/`scope_claims` arrays for a genuine
 *                zero-claims (docs-only/infra-only) PRD. Returns null only
 *                when that section never ran or failed validation (see
 *                module doc — the file's
 *                ABSENCE, not an empty payload, is the codebase-graph
 *                stage's signal to fall back to regex extraction).
 */
function affectedSymbolsFile(state: PipelineState, base: string): PrdFile | null {
  if (!technicalSpecSection(state)) return null;
  const affected = affectedSymbolsForState(state);
  return {
    path: `${base}/${AFFECTED_SYMBOLS_FILENAME}`,
    content: () => JSON.stringify(affected, null, 2),
  };
}

/**
 * precondition:  none.
 * postcondition: returns `00-run-notes.md` naming each skipped file with its
 *                reason and each withheld failed section, when either list
 *                is non-empty; null otherwise. Numbering-
 *                stable by construction: skipped filenames keep their
 *                originally-planned slot (e.g. 03-api-spec.md is simply
 *                absent, never renumbered), so run-notes lists exactly the
 *                gaps in the sequence.
 */
function runNotesFile(
  base: string,
  skipped: readonly SkippedFile[],
  withheld: readonly WithheldSection[],
): PrdFile | null {
  if (skipped.length === 0 && withheld.length === 0) return null;
  const sorted = [...skipped].sort((a, b) => a.filename.localeCompare(b.filename));
  const blocks: string[][] = [];
  if (sorted.length > 0) {
    blocks.push([
      "The following deliverable files were not generated in this run:",
      "",
      ...sorted.map(
        (s) => `- **${s.display}** (\`${s.filename}\`): ${SKIP_REASON_TEXT[s.reason]}.`,
      ),
    ]);
  }
  if (withheld.length > 0) {
    blocks.push([
      "The following sections failed validation; their drafts are not deliverables " +
        "and were withheld from the exported files:",
      "",
      ...withheld.map(
        (w) =>
          `- **${w.display}** (${w.filenames.map((f) => `\`${f}\``).join(", ")}): ` +
          `failed after ${w.attempt} attempt(s) with ${w.violations} violation(s).`,
      ),
    ]);
  }
  return {
    path: `${base}/${RUN_NOTES_FILENAME}`,
    content: () => ["# Run Notes", "", blocks.map((b) => b.join("\n")).join("\n\n")].join("\n"),
  };
}

/**
 * precondition:  none.
 * postcondition: returns the core PRD file (always written), every
 *                companion/JIRA file THAT HAS CONTENT (no placeholders —
 *                see module doc), the affected-symbols sidecar whenever
 *                technical_specification passed with content, and — iff at least one file was skipped or
 *                one failed section was withheld — `00-run-notes.md`
 *                naming each skip and each withheld section.
 */
function buildFileSet(state: PipelineState): readonly PrdFile[] {
  const slug = state.run_id.slice(0, 8);
  const base = `${OUTPUT_DIR}/${slug}`;
  const skipped: SkippedFile[] = [];

  const files: PrdFile[] = [corePrdFile(state, base)];
  files.push(...companionAndJiraFiles(state, base, skipped));

  const affected = affectedSymbolsFile(state, base);
  if (affected) files.push(affected);

  const runNotes = runNotesFile(base, skipped, withheldSections(state));
  if (runNotes) files.push(runNotes);

  return files;
}

export const handleFileExport: StepHandler = ({ state, result }) => {
  let nextState: PipelineState = state;

  // Host-protocol invariant: each `write_file` action expects a `file_written`
  // result. Other result kinds are protocol violations — log to errors and
  // re-issue the current write instead of silently advancing.
  if (result && result.kind !== "file_written") {
    nextState = appendError(
      state,
      `[file_export] unexpected result kind '${result.kind}'; re-issuing write`,
      "structural", // protocol violation — handler bug, not a section validator failure
    );
  }

  // Record a successful write.
  if (result?.kind === "file_written") {
    if (!state.written_files.includes(result.path)) {
      nextState = {
        ...state,
        written_files: [...state.written_files, result.path],
      };
    }
  }

  const files = buildFileSet(nextState);
  const done = new Set(nextState.written_files);
  const remaining = files.filter((f) => !done.has(f.path));

  if (remaining.length === 0) {
    // Record the sidecar path (when exported) so self-check can pass it to
    // `validate_prd_against_graph` as `affected_symbols_path`. Derived from
    // the file set just written rather than re-parsing — this is the same
    // list `done` was checked against, so it is exactly what landed on disk.
    const sidecar = files.find((f) => f.path.endsWith(AFFECTED_SYMBOLS_FILENAME));
    const finalState = sidecar
      ? { ...nextState, affected_symbols_path: sidecar.path }
      : nextState;
    return {
      state: { ...finalState, current_step: "self_check" },
      action: {
        kind: "emit_message",
        message: `All ${files.length} files written. Running self-check.`,
      },
    };
  }

  const next = remaining[0];
  return {
    state: nextState,
    action: {
      kind: "write_file",
      path: next.path,
      content: next.content(),
    },
  };
};

// Verification-report export (10-verification-report.md) moved to
// verification-report.ts (§4.1 500-line file cap / Move 5: it renders an
// already-fully-computed piece of state, a distinct concern from this
// file's file-WRITING protocol). `PrdFile` below is exported for that
// module to consume.
