import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";

// Document-Level Rule: Dependency Targets Defined
//
// Every identifier a requirement or story names as a dependency must be
// defined somewhere in the document. A dependency on an identifier the
// document never defines is either a typo or a fabricated item, and nothing
// else in the structural pass reads it: `no_self_referencing_deps` only
// compares an identifier with itself, and `fr_to_ac_coverage` reads the
// opposite direction (defined FRs that nothing covers).
//
// source: issue #118, seeded defect `hallucinated_dependency` ("STORY-2
// depends on STORY-7, which the document does not define"), which the
// document check did not diagnose.

/** Identifier families a dependency may name. */
const DEP_ID_SOURCE = String.raw`\b(?:FR|NFR|STORY|US|EPIC)-\d+\b`;

/**
 * An identifier is defined where it opens a table row, a list item or a
 * heading, optionally in bold (`| FR-001 |`, `- STORY-1:`, `1. **US-2**`,
 * `### EPIC-3`). A mention anywhere else is a reference.
 */
const DEFINITION_PATTERN = new RegExp(
  String.raw`^[ \t]*(?:\|[ \t]*|[-*+][ \t]+|\d+[.)][ \t]+|#{1,6}[ \t]+)(?:\*\*)?(${DEP_ID_SOURCE})`,
  "gm",
);

/**
 * A prose dependency clause: `depends on` / `blocked by`, read up to the end
 * of the clause (a pipe, a newline, a period or a semicolon). Bounded, so the
 * scan is linear in the line length.
 */
const PROSE_DEPENDENCY_PATTERN = /\b(?:depends[ \t]+on|blocked[ \t]+by)\b([^|\n.;]{0,200})/gi;

/** A table header cell that names a dependency column. */
const DEPENDENCY_HEADER = /^(?:depends[ \t]+on|dependencies|dependency|blocked[ \t]+by)$/i;

const FENCE = /^[ \t]*(?:```|~~~)/;

/** The document without its fenced blocks, which show proposed code. */
function withoutFencedBlocks(content: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of content.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join("\n");
}

function idsIn(text: string): string[] {
  return text.match(new RegExp(DEP_ID_SOURCE, "g")) ?? [];
}

function cellsOf(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.replace(/\*\*/g, "").trim());
}

function isSeparatorRow(row: string): boolean {
  return /^[ \t]*\|[ \t:|-]*$/.test(row) && row.includes("-");
}

/** Identifiers read from the dependency column of every markdown table. */
function tableDependencyIds(content: string): string[] {
  const out: string[] = [];
  let depColumns: number[] | null = null;
  let previous: string | null = null;
  for (const line of content.split("\n")) {
    if (!line.trimStart().startsWith("|")) {
      depColumns = null;
      previous = null;
      continue;
    }
    if (isSeparatorRow(line)) {
      // The row above a separator is the header of a new table.
      depColumns = previous === null
        ? null
        : cellsOf(previous)
            .map((cell, i) => (DEPENDENCY_HEADER.test(cell) ? i : -1))
            .filter((i) => i >= 0);
    } else if (depColumns !== null && depColumns.length > 0) {
      const cells = cellsOf(line);
      for (const i of depColumns) out.push(...idsIn(cells[i] ?? ""));
    }
    previous = line;
  }
  return out;
}

function proseDependencyIds(content: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(PROSE_DEPENDENCY_PATTERN.source, PROSE_DEPENDENCY_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) out.push(...idsIn(match[1] ?? ""));
  return out;
}

export function checkDocumentDependencyTargetsDefined(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const content = withoutFencedBlocks(sections.map((s) => s.content).join("\n\n"));

  const defined = new Set<string>();
  const definitionPattern = new RegExp(DEFINITION_PATTERN.source, DEFINITION_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = definitionPattern.exec(content)) !== null) defined.add(match[1]!);

  const undefinedTargets = [
    ...new Set([...tableDependencyIds(content), ...proseDependencyIds(content)]),
  ]
    .filter((id) => !defined.has(id))
    .sort();

  if (undefinedTargets.length === 0) return [];
  return [
    makeViolation(
      "dependency_targets_defined",
      null,
      `${undefinedTargets.length} dependency target(s) are defined nowhere in the document: ${undefinedTargets.join(", ")}`,
      `Undefined: ${undefinedTargets.join(", ")}`,
    ),
  ];
}
