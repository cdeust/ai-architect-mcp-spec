import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { listedIds } from "./listed-ids.js";
import { LINE_BREAK, linesOutsideFences } from "./fenced-blocks.js";

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

/**
 * Identifier families a dependency may name. The number is bounded to nine
 * digits so that `Number()` in idKey stays exact (below 2^53).
 */
const DEP_ID_SOURCE = String.raw`\b(?:FR|NFR|STORY|US|EPIC)-\d{1,9}\b`;

/**
 * Outside tables, an identifier is defined where it opens a list item or a
 * heading (optionally in bold or code), or opens a line in bold:
 * `- STORY-1:`, `1. **US-2**`, `### EPIC-3`, `**STORY-4**:`. A bare
 * identifier at a line start (`STORY-7 is deferred.`) is a mention, not a
 * definition. Table rows are read by readTables only.
 */
const DEFINITION_PATTERN = new RegExp(
  String.raw`^[ \t]*(?:(?:[-*+]|\d{1,9}[.)]|#{1,6})[ \t]+(?:\*\*|\x60)?|\*\*)(${DEP_ID_SOURCE})`,
  "gm",
);

/** A table header cell that names the identifier column (`ID`, `Story ID`). */
const ID_HEADER = /\bID\b/i;

/** A table cell that holds one identifier and nothing else. */
const ID_ONLY_CELL = new RegExp(String.raw`^(?:\*\*|\x60)?(${DEP_ID_SOURCE})(?:\*\*|\x60)?$`);

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

/** The columns of a table, read from its header row. */
interface TableColumns {
  /** Dependency columns: their identifiers are targets. */
  readonly dependency: ReadonlySet<number>;
  /** Defining columns: an identifier-only cell in one of them defines it. */
  readonly defining: ReadonlySet<number>;
}

const NO_HEADER: TableColumns = { dependency: new Set(), defining: new Set([0]) };

/**
 * The defining columns are every column headed `ID` (`ID`, `Epic ID`,
 * `Story ID`) outside the dependency columns, so that a story table whose
 * first `… ID` column is the epic still defines its stories. Without such a
 * column, the first column defines, unless it is a dependency column: a
 * dependency column never defines.
 */
function columnsOf(header: readonly string[]): TableColumns {
  const dependency = new Set<number>();
  header.forEach((cell, i) => {
    if (DEPENDENCY_HEADER.test(cell)) dependency.add(i);
  });
  const defining = new Set<number>();
  header.forEach((cell, i) => {
    if (!dependency.has(i) && ID_HEADER.test(cell)) defining.add(i);
  });
  if (defining.size === 0 && !dependency.has(0)) defining.add(0);
  return { dependency, defining };
}

/**
 * Reads every markdown table: adds to `targets` the identifiers of its
 * dependency columns, and to `defined` the identifier of each defining cell
 * of a row that holds an identifier and nothing else.
 */
function readTables(content: string, defined: Set<string>, targets: Map<string, string>): void {
  let columns = NO_HEADER;
  let previous: string | null = null;
  for (const line of content.split(LINE_BREAK)) {
    if (!line.trimStart().startsWith("|")) {
      columns = NO_HEADER;
      previous = null;
      continue;
    }
    if (isSeparatorRow(line)) {
      // The row above a separator is the header of a new table.
      columns = previous === null ? NO_HEADER : columnsOf(cellsOf(previous));
    } else {
      const cells = cellsOf(line);
      for (const i of columns.dependency) addTargets(idsIn(cells[i] ?? ""), targets);
      for (const i of columns.defining) {
        const owner = ID_ONLY_CELL.exec(cells[i] ?? "")?.[1];
        if (owner !== undefined) defined.add(idKey(owner));
      }
    }
    previous = line;
  }
}

/** Adds each identifier under its comparison key, keeping its first spelling. */
function addTargets(ids: readonly string[], targets: Map<string, string>): void {
  for (const id of ids) if (!targets.has(idKey(id))) targets.set(idKey(id), id);
}

/** Adds to `out` the identifiers named in prose dependency clauses. */
function proseDependencyIds(content: string, out: Map<string, string>): void {
  const pattern = new RegExp(PROSE_DEPENDENCY_PATTERN.source, PROSE_DEPENDENCY_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    addTargets(idsIn(match[1] ?? ""), out);
  }
}

export function checkDocumentDependencyTargetsDefined(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  // Fences are removed per section: a section ends any block it opened, so
  // an unclosed fence cannot hide the sections after it.
  const content = sections.map((s) => linesOutsideFences(s.content).join("\n")).join("\n\n");

  const defined = new Set<string>();
  const definitionPattern = new RegExp(DEFINITION_PATTERN.source, DEFINITION_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = definitionPattern.exec(content)) !== null) defined.add(idKey(match[1]!));
  const targets = new Map<string, string>();
  readTables(content, defined, targets);
  proseDependencyIds(content, targets);
  const undefinedTargets = [...targets]
    .filter(([key]) => !defined.has(key))
    .map(([, id]) => id)
    .sort();

  if (undefinedTargets.length === 0) return [];
  // The first targets are named, the rest counted (listed-ids.ts).
  const names = listedIds(undefinedTargets);
  return [
    makeViolation(
      "dependency_targets_defined",
      null,
      `${undefinedTargets.length} dependency target(s) are defined nowhere in the document: ${names}`,
      `Undefined: ${names}`,
    ),
  ];
}
