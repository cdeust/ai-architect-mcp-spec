// Requirement definitions of a section, for the Measurable Requirements rule
// (measurable-requirement-rules.ts), read from the CommonMark 0.31.2 block
// tree of the section, with GFM tables (`markdown-it`, CommonMark preset plus
// its table rule), instead of a hand-written line scanner.
//
// The scanner this replaces (measurable-list-items.ts, PRs #276 to #298)
// rebuilt list items, block quotes, headings, tables, fenced blocks, tab
// stops and lazy continuation lines in several passes that did not share
// their state, and each local fix put another pass out of step (issue #118,
// comment of 2026-11-15, "boucle de suivis"). The parser gives one tree in
// which a list marker is never text: the numbers of a list are not in the
// text this module returns, so they cannot bound a requirement, while a
// number that wraps into a paragraph is text and does.
//
// Only the block structure is parsed: the inline rule of markdown-it is off,
// and a block's text is its raw inline source, as the line scanner read it
// (the rule removes code spans and quotes from it with its own patterns).
// Inline tokens for every table cell made a long table allocation-bound, its
// growth near the perf ceiling of 3.
//
// markdown-it, not micromark: on a section of many short lists split by
// paragraphs (`openListStack` in regex-hardening.perf.ts), micromark 4.0.3
// took 0.35, 1.1 and 4.2 s at 16k, 32k and 64k characters, a quadratic
// growth; markdown-it 14 parses the same inputs in linear time (21, 31 and
// 59 ms at 32k, 64k and 128k).
//
// source: issue #118.

import MarkdownIt from "markdown-it";

/** An ordered list marker that opens a statement right after its identifier. */
const NUMBERED_STATEMENT = /^[ \t]*\d{1,9}[.)](?=[ \t]+\S)/;

/**
 * A table column whose cells are metadata of the requirement, never its
 * statement: identifier, dependency, priority, status, estimate and owner
 * columns (EN + FR). A number in one of them (`P1`, `3` story points) does
 * not bound the statement. source: PR #275 review, note 1.
 */
const METADATA_HEADER =
  /^(?:(?:[\p{L}]+[ \t]+)?ids?|depends[ \t]+on|dependenc(?:y|ies)|blocked[ \t]+by|dépend[ \t]+de|dépendances?|priority|priorité|prio|moscow|status|statut|state|état|story[ \t]+points?|points?|sps?|estimate|estimation|effort|owner|responsable)$/iu;

/** A requirement definition: its identifier and the text a bound is looked for in. */
export interface RequirementDefinition {
  readonly id: string;
  /**
   * The text of the definition, as inline source: `unboundedTermIn` removes
   * its code spans and quotes. Its first line is what follows the identifier
   * on the defining block; list markers are absent, the parser having read
   * them as structure.
   */
  readonly text: string;
}

/**
 * CommonMark blocks with GFM tables; inline content is left as source text.
 * HTML blocks are not parsed: as one, `<div>` / `**FR-001** …` with no blank
 * line between them hid the definition, which the line scanner read (PR
 * #299 review, note 2); as paragraph text it is read again.
 */
const parser = new MarkdownIt("commonmark").enable("table").disable(["inline", "html_block"]);

/** A line of a block that opens with a requirement identifier, optionally bold or code; the rest of the line in group 2. */
const DEFINING_LINE = /^(?:\*\*|\x60)?((?:FR|NFR)-\d{1,9}\b)(?:\*\*|\x60)?(.*)$/;
/** A bold line: one that opens with a bold requirement identifier. */
const BOLD_LINE = /^\*\*(?:FR|NFR)-\d{1,9}\b/;

/** A leaf block a definition's text is read from: a paragraph, a heading or a table. */
interface Leaf {
  readonly type: "paragraph" | "heading" | "table";
  /** Source lines of the block, 0-based, end exclusive. */
  readonly map: readonly [number, number];
  /** The raw inline source of a paragraph or heading; empty for a table. */
  readonly inline: string;
  /** The rows of a table, each the raw inline source of its cells, the header row first. */
  readonly rows: string[][];
  /** The last line (exclusive) of the block the leaf sits in; Infinity at the section's top level. */
  readonly containerEnd: number;
  /** The paragraph is the first block of a list item. */
  readonly opensItem: boolean;
}

/**
 * The leaf blocks of a section in document order, read in one pass over
 * markdown-it's token stream. Code, HTML and thematic breaks hold none. No
 * tree is built, and the open containers are kept as parallel arrays of
 * primitives: on a long section of nested lists, an object per token made
 * the growth allocation-bound, near the perf ceiling.
 */
function leavesOf(content: string): Leaf[] {
  const tokens = parser.parse(content, {});
  const leaves: Leaf[] = [];
  /** The type, last line (exclusive) and filled state of each open container, the section itself first. */
  const openType: string[] = ["root"];
  const openEnd: number[] = [Infinity];
  const openFilled: boolean[] = [false];
  let table: { map: [number, number]; rows: string[][]; containerEnd: number } | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const top = openType.length - 1;
    if (table !== null) {
      if (token.type === "tr_open") table.rows.push([]);
      else if (token.type === "inline") table.rows[table.rows.length - 1]?.push(token.content);
      else if (token.type === "table_close") {
        leaves.push({ type: "table", map: table.map, inline: "", rows: table.rows, containerEnd: table.containerEnd, opensItem: false });
        table = null;
      }
      continue;
    }
    if (token.type === "table_open") {
      table = { map: token.map as [number, number], rows: [], containerEnd: openEnd[top]! };
    } else if (token.type === "paragraph_open" || token.type === "heading_open") {
      leaves.push({
        type: token.type === "paragraph_open" ? "paragraph" : "heading",
        map: token.map as [number, number],
        inline: tokens[i + 1]?.content ?? "",
        rows: NO_ROWS,
        containerEnd: openEnd[top]!,
        opensItem: token.type === "paragraph_open" && openType[top] === "list_item_open" && !openFilled[top],
      });
      i += 2;
    } else if (token.nesting === 1) {
      openFilled[top] = true;
      openType.push(token.type);
      openEnd.push(token.map?.[1] ?? Infinity);
      openFilled.push(false);
      continue;
    } else if (token.nesting === -1) {
      if (openType.length > 1) {
        openType.pop();
        openEnd.pop();
        openFilled.pop();
      }
      continue;
    }
    openFilled[top] = true;
  }
  return leaves;
}

/** The rows of a leaf that is no table. */
const NO_ROWS: string[][] = [];

/** The cells of a row as text, bold markers removed. */
const cellTexts = (row: readonly string[]): string[] => row.map((cell) => cell.replace(/\*\*/g, "").trim());

/** The indexes of the metadata columns of a table, read from its header row. */
function metadataColumns(header: readonly string[]): ReadonlySet<number> {
  const out = new Set<number>();
  header.forEach((cell, i) => {
    if (METADATA_HEADER.test(cell)) out.add(i);
  });
  return out;
}

/**
 * The header of a key-value table: two columns, the second naming the value
 * (`| Field | Value |`, `| Champ | Valeur |`). Its rows are one field each,
 * named by their first cell. Another header (`| Attribute | Detail |`, or a
 * third `Notes` column) is not read as one, so a metadata row under it still
 * bounds the statement: a missed finding, chosen over a false positive on a
 * table whose first column is not a field name (PR #279 review, note 2).
 */
function isKeyValueHeader(header: readonly string[]): boolean {
  return header.length === 2 && /^(?:values?|valeurs?)$/iu.test(header[1]!);
}

/**
 * A table in the body of a heading definition, read as a requirement row
 * is: the metadata columns named by the header are removed from every row,
 * the header included, and in a key-value table a row whose first cell names
 * a metadata field is dropped whole (PR #276 review, note 2; PR #277 review,
 * note 2). In any other table the first cell is a value of its column, not a
 * field name: under `| Metric | Target |`, `| State | restored within 2 s |`
 * states a bound and is kept (PR #278 review, note 2).
 */
function tableBodyText(table: Leaf): string {
  const [header, ...rows] = table.rows;
  if (header === undefined) return "";
  const headerCells = cellTexts(header);
  const metadata = metadataColumns(headerCells);
  const keyValue = isKeyValueHeader(headerCells);
  const keep = (row: readonly string[]): string =>
    cellTexts(row)
      .filter((_, c) => !metadata.has(c))
      .join(" | ");
  return [
    keep(header),
    ...rows.map((row) => (keyValue && METADATA_HEADER.test(cellTexts(row)[0] ?? "") ? "" : keep(row))),
  ].join("\n");
}

/** The requirement rows of a table: a row whose first cell is one identifier; its statement is the other cells less the metadata columns. */
function tableDefinitions(table: Leaf): RequirementDefinition[] {
  const rows = table.rows;
  const [header] = rows;
  if (header === undefined) return [];
  const metadata = metadataColumns(cellTexts(header));
  const out: RequirementDefinition[] = [];
  rows.forEach((row, r) => {
    const cells = cellTexts(row);
    const id = /^\x60?((?:FR|NFR)-\d{1,9})\x60?$/.exec(cells[0] ?? "")?.[1];
    if (id === undefined) return;
    // The header row is a definition only when its first cell is one; it
    // names no metadata column for itself.
    const skip = r === 0 ? new Set<number>() : metadata;
    const text = cells
      .slice(1)
      .filter((_, i) => !skip.has(i + 1))
      .join(" | ");
    out.push({ id, text });
  });
  return out;
}

/** The text of a leaf block: its inline source, or a table read as `tableBodyText` reads it. */
const leafText = (leaf: Leaf): string => (leaf.type === "table" ? tableBodyText(leaf) : leaf.inline);

/**
 * The identifier a line of a block opens with, and the rest of the line:
 * `FR-001: …`, `` `FR-001` … `` or `**FR-001** …`, or, with `boldOnly`, a
 * bold line only: a paragraph line that opens no list item defines a
 * requirement only as a bold line.
 */
function definingId(source: string, boldOnly: boolean): { id: string; rest: string } | null {
  // A continuation line keeps its indentation in the inline source; the
  // parser has already decided it is paragraph text (PR #299 review, Codex P2).
  const line = source.replace(/^[ \t]+/, "");
  if (boldOnly && !BOLD_LINE.test(line)) return null;
  const found = DEFINING_LINE.exec(line);
  return found === null ? null : { id: found[1]!, rest: found[2]! };
}

/**
 * The index of the first line of a leaf that opens a definition, else -1:
 * the first line of a paragraph that opens a list item, a bold line, a
 * heading, or, for a table, its first line when a row defines one. Another
 * definition ends the text of the one before it, as the line scanner closed
 * it (PR #299 review, Codex P2).
 */
function firstDefiningLine(leaf: Leaf): number {
  if (leaf.type === "table") return tableDefinitions(leaf).length > 0 ? 0 : -1;
  if (leaf.type === "heading") return definingId(leaf.inline, false) === null ? -1 : 0;
  return leaf.inline.split("\n").findIndex((line, i) => definingId(line, !(leaf.opensItem && i === 0)) !== null);
}

/** The text of a leaf before its first definition, and whether one starts in it. */
function textBeforeDefinition(leaf: Leaf): { text: string; ends: boolean } {
  const at = firstDefiningLine(leaf);
  if (at < 0) return { text: leafText(leaf), ends: false };
  return { text: leaf.type === "paragraph" ? leaf.inline.split("\n").slice(0, at).join("\n") : "", ends: true };
}

/**
 * The markers removed from a statement numbered right after its
 * identifier: its first marker, then each line-leading number that is the
 * next one of that list (`1.`, ` 2.`, ` 3.`). Any other number at a line
 * start is a quantity wrapped into the statement and kept (`1. … the
 * maximum count is` / `    2000. Larger collections page.`; PR #299
 * review, Codex P2).
 */
function withoutStatementMarkers(rest: string): string {
  const first = NUMBERED_STATEMENT.exec(rest);
  if (first === null) return rest;
  let next = Number(/\d+/.exec(first[0])![0]);
  return rest
    .split("\n")
    .map((line, i) => {
      const marker = /^([ \t]*)(\d{1,9})[.)](?=[ \t]+\S)/.exec(line);
      if (marker === null || (i > 0 && Number(marker[2]) !== next + 1)) return line;
      if (i > 0) next += 1;
      return marker[1]! + " ".repeat(marker[0].length - marker[1]!.length) + line.slice(marker[0].length);
    })
    .join("\n");
}

/**
 * The text of a list item or bold-line definition: the rest of its defining
 * line, the lines of its paragraph up to the next definition, and, when it
 * reaches the paragraph's end, the paragraphs of `following` that follow it
 * with no blank line between, nested items included, up to the first table
 * or heading (the text of an item runs to its first blank line, as before).
 * A following paragraph that opens a definition ends it. A statement
 * numbered right after its identifier (`**NFR-001** 1. Search must be
 * fast.` / ` 2. Results are listed.`) is a numbered list its author wrote in
 * one paragraph: CommonMark reads ` 2.` as text, since an ordered list may
 * interrupt a paragraph only at 1 (§5.2), but here it is the next marker of
 * that list, not a bound (`withoutStatementMarkers`; PR #284 review, note 3;
 * PR #297 review, Codex P2).
 */
function paragraphDefinitionText(rest: string, paragraph: Leaf, following: Iterable<Leaf> | null): string {
  const lines = [withoutStatementMarkers(rest)];
  let last = paragraph.map[1];
  for (const leaf of following ?? []) {
    if (leaf.type !== "paragraph" || leaf.map[0] !== last) break;
    const before = textBeforeDefinition(leaf);
    if (before.text !== "") lines.push(before.text);
    if (before.ends) break;
    last = leaf.map[1];
  }
  return lines.join("\n");
}

/**
 * The definitions a paragraph opens: its first line when it opens a list
 * item (`- FR-001: …`) or is a bold line, and every later line that is a
 * bold line (`Intro` / `**NFR-001** …`). Each one's text runs to the next
 * one in the paragraph; the last one's goes on with `following`.
 */
function paragraphDefinitions(paragraph: Leaf, following: () => Iterable<Leaf>): RequirementDefinition[] {
  const lines = paragraph.inline.split("\n");
  const starts: { line: number; id: string; rest: string }[] = [];
  lines.forEach((line, i) => {
    const found = definingId(line, !(paragraph.opensItem && i === 0));
    if (found !== null) starts.push({ line: i, ...found });
  });
  return starts.map((start, k) => {
    const next = starts[k + 1];
    const body = lines.slice(start.line + 1, next?.line ?? lines.length);
    const rest = [start.rest, ...body].join("\n");
    return { id: start.id, text: paragraphDefinitionText(rest, paragraph, next === undefined ? following() : null) };
  });
}

/**
 * A heading's body: the leaf blocks after it, in document order, up to the
 * next heading at any depth or level, or the next definition (a list item,
 * bold line or table row that defines a requirement; PR #299 review, Codex P2).
 */
function headingBody(leaves: readonly Leaf[], at: number): string {
  const lines: string[] = [];
  for (let k = at + 1; k < leaves.length && leaves[k]!.type !== "heading"; k++) {
    const before = textBeforeDefinition(leaves[k]!);
    if (before.text !== "") lines.push(before.text);
    if (before.ends) break;
  }
  return lines.join("\n");
}

/** The requirement definitions of a section, in document order: table rows, list items, headings and bold lines. */
export function requirementDefinitions(content: string): RequirementDefinition[] {
  const leaves = leavesOf(content);
  const out: RequirementDefinition[] = [];
  leaves.forEach((leaf, at) => {
    if (leaf.type === "table") {
      out.push(...tableDefinitions(leaf));
      return;
    }
    if (leaf.type === "heading") {
      const found = definingId(leaf.inline, false);
      if (found !== null) out.push({ id: found.id, text: [found.rest, headingBody(leaves, at)].join("\n") });
      return;
    }
    // The blocks that may go on with the paragraph are the later leaves of
    // its container (its list item, or the block it sits in), a run of
    // `leaves` read lazily up to the container's last line: listing the
    // container's leaves for each paragraph was quadratic in a long section.
    function* following(): Generator<Leaf> {
      for (let k = at + 1; k < leaves.length && leaves[k]!.map[0] < leaf.containerEnd; k++) yield leaves[k]!;
    }
    out.push(...paragraphDefinitions(leaf, following));
  });
  return out;
}
