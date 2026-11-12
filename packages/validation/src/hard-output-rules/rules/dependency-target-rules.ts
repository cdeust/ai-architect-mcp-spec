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
 * An identifier is defined where it opens a line, a table row, a list item or
 * a heading, optionally in bold or code (`| FR-001 |`, `- STORY-1:`,
 * `1. **US-2**`, `### EPIC-3`, `**STORY-4**:`, `` | `FR-005` | ``). A table
 * row whose first cells are not identifiers (`| 1 | FR-001 |`) defines the
 * identifier that fills its first identifier-only cell (readTables).
 * A mention anywhere else is a reference.
 */
const DEFINITION_PATTERN = new RegExp(
  String.raw`^[ \t]*(?:\|[ \t]*|[-*+][ \t]+|\d+[.)][ \t]+|#{1,6}[ \t]+)?(?:\*\*|\x60)?(${DEP_ID_SOURCE})`,
  "gm",
);

/** A table cell that holds one identifier and nothing else. */
const ID_ONLY_CELL = new RegExp(String.raw`^(?:\*\*|\x60)?(${DEP_ID_SOURCE})(?:\*\*|\x60)?$`);

/**
 * Undefined targets named in the finding; the rest are counted. Bounds the
 * message on a document with many dangling references.
 */
const MAX_LISTED_TARGETS = 20;

/**
 * The comparison key of an identifier: its family and its number, so that
 * `STORY-001` and `STORY-1` name the same item.
 */
function idKey(id: string): string {
  const dash = id.lastIndexOf("-");
  return `${id.slice(0, dash)}-${Number(id.slice(dash + 1))}`;
}

/**
 * A prose dependency clause: `depends on` / `blocked by`, read up to the end
 * of the clause (a pipe, a newline, a period or a semicolon). Bounded, so the
 * scan is linear in the line length.
 */
const PROSE_DEPENDENCY_PATTERN = /\b(?:depends[ \t]+on|blocked[ \t]+by)\b([^|\n.;]{0,200})/gi;

/** A table header cell that names a dependency column. */
const DEPENDENCY_HEADER = /^(?:depends[ \t]+on|dependencies|dependency|blocked[ \t]+by)$/i;

/** A fence line: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The document without its fenced blocks, which show proposed code. As in
 * CommonMark, a block closes only on a fence of the same character, at least
 * as long as the opening one and with nothing after it, so a shorter or other
 * fence inside the block (a nested example) stays inside it.
 */
function withoutFencedBlocks(content: string): string {
  const kept: string[] = [];
  let open: string | null = null;
  for (const line of content.split("\n")) {
    const fence = FENCE.exec(line);
    if (open === null) {
      if (fence) open = fence[1]!;
      else kept.push(line);
    } else if (
      fence &&
      fence[1]![0] === open[0] &&
      fence[1]!.length >= open.length &&
      fence[2]!.trim() === ""
    ) {
      open = null;
    }
  }
  return kept.join("\n");
}

function idsIn(text: string): string[] {
  return text.match(new RegExp(DEP_ID_SOURCE, "g")) ?? [];
}

/** The cells of a table row, split on unescaped pipes only (`\|` is a literal pipe in a cell). */
function cellsOf(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((c) => c.replace(/\*\*/g, "").trim());
}

function isSeparatorRow(row: string): boolean {
  return /^[ \t]*\|[ \t:|-]*$/.test(row) && row.includes("-");
}

/**
 * Reads every markdown table: adds to `targets` the identifiers of its
 * dependency columns, and to `defined` the identifier each row defines, which
 * is its first identifier-only cell outside a dependency column.
 */
function readTables(content: string, defined: Set<string>, targets: Set<string>): void {
  let depColumns: number[] = [];
  let previous: string | null = null;
  for (const line of content.split("\n")) {
    if (!line.trimStart().startsWith("|")) {
      depColumns = [];
      previous = null;
      continue;
    }
    if (isSeparatorRow(line)) {
      // The row above a separator is the header of a new table.
      depColumns = (previous === null ? [] : cellsOf(previous))
        .map((cell, i) => (DEPENDENCY_HEADER.test(cell) ? i : -1))
        .filter((i) => i >= 0);
    } else {
      const cells = cellsOf(line);
      for (const i of depColumns) for (const id of idsIn(cells[i] ?? "")) targets.add(id);
      const owner = cells.find((cell, i) => !depColumns.includes(i) && ID_ONLY_CELL.test(cell));
      if (owner !== undefined) defined.add(idKey(ID_ONLY_CELL.exec(owner)![1]!));
    }
    previous = line;
  }
}

/** Adds to `out` the identifiers named in prose dependency clauses. */
function proseDependencyIds(content: string, out: Set<string>): void {
  const pattern = new RegExp(PROSE_DEPENDENCY_PATTERN.source, PROSE_DEPENDENCY_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    for (const id of idsIn(match[1] ?? "")) out.add(id);
  }
}

export function checkDocumentDependencyTargetsDefined(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  // Fences are removed per section: a section ends any block it opened, so
  // an unclosed fence cannot hide the sections after it.
  const content = sections.map((s) => withoutFencedBlocks(s.content)).join("\n\n");

  const defined = new Set<string>();
  const definitionPattern = new RegExp(DEFINITION_PATTERN.source, DEFINITION_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = definitionPattern.exec(content)) !== null) defined.add(idKey(match[1]!));
  const targets = new Set<string>();
  readTables(content, defined, targets);
  proseDependencyIds(content, targets);
  const undefinedTargets = [...targets].filter((id) => !defined.has(idKey(id))).sort();

  if (undefinedTargets.length === 0) return [];
  const listed = undefinedTargets.slice(0, MAX_LISTED_TARGETS).join(", ");
  const more = undefinedTargets.length - MAX_LISTED_TARGETS;
  const names = more > 0 ? `${listed} and ${more} more` : listed;
  return [
    makeViolation(
      "dependency_targets_defined",
      null,
      `${undefinedTargets.length} dependency target(s) are defined nowhere in the document: ${names}`,
      `Undefined: ${names}`,
    ),
  ];
}
