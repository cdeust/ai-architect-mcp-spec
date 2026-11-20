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
import { isHtmlComment, opaqueHtmlBlock } from "./requirement-html.js";
import { parseWithoutHtmlQuotes } from "./define-html-quotes.js";

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
  readonly source?: string;
}

/**
 * CommonMark blocks with GFM tables; inline content is left as source text.
 * An HTML block other than a comment is parsed again as markdown with
 * `htmlAsText` (`leavesOf`): as an opaque block, `<div>` / `- FR-001: …` or
 * `**FR-001** …` with no blank line between them hid the definition, which
 * the line scanner read (PR #299 review, note 2; PR #301 review, Codex P2).
 * An HTML comment is not document text, so a definition inside one is not
 * read (PR #300 review, note 1).
 */
const parser = new MarkdownIt("commonmark").enable("table").disable("inline");

/**
 * The same, for an HTML block's source: HTML lines are read as text, save a
 * comment or a raw-text block, which `opaqueHtmlBlock` opens in place of the
 * `html_block` rule. So the parser orders them against fences and code
 * blocks, and keeps them in their containers (PR #305 review).
 */
const htmlAsText = new MarkdownIt("commonmark").enable("table").disable("inline");
htmlAsText.block.ruler.at("html_block", opaqueHtmlBlock, { alt: ["paragraph", "reference", "blockquote"] });

/**
 * The identifiers a reader of definitions looks for, as three patterns over
 * one alternation of prefixes (`FR|NFR`): a line of a block that opens with
 * an identifier, optionally bold or code, with the rest of the line in group
 * 2; a bold line, one that opens with a bold identifier; and a table cell
 * that is one identifier, optionally code. Requirements (`FR`, `NFR`) are
 * the default; the Testable Acceptance Criteria rule reads `AC` definitions
 * with the same block tree (testable-acceptance-criteria-rules.ts).
 */
interface DefinitionIds {
  readonly definingLine: RegExp;
  readonly boldLine: RegExp;
  readonly cell: RegExp;
}

const idsCache = new Map<string, DefinitionIds>();

/** The patterns for identifiers with one of `prefixes` (upper-case letters only). */
function definitionIds(prefixes: readonly string[]): DefinitionIds {
  const key = prefixes.join("|");
  const cached = idsCache.get(key);
  if (cached !== undefined) return cached;
  if (!prefixes.every((prefix) => /^[A-Z]{1,10}$/.test(prefix))) throw new Error(`invalid identifier prefixes: ${key}`);
  const id = String.raw`(?:${key})-\d{1,9}`;
  const made: DefinitionIds = {
    definingLine: new RegExp(String.raw`^(?:\*\*|\x60)?(${id})(?![\w-])(?:\*\*|\x60)?(.*)$`),
    boldLine: new RegExp(String.raw`^\*\*${id}(?![\w-])`),
    cell: new RegExp(String.raw`^\x60?(${id})\x60?$`),
  };
  idsCache.set(key, made);
  return made;
}

/** Requirement identifiers: the default of `requirementDefinitions`. */
const REQUIREMENT_PREFIXES = ["FR", "NFR"] as const;

// Final parenthesized list after whitespace, shared with the Define v1 projection.
export const ACCEPTANCE_REFERENCES = /[ \t]\(((?:FR|NFR)-\d{1,9}(?:[ \t]*,[ \t]*(?:FR|NFR)-\d{1,9})*)\)\.?$/;

export const DEFINE_REQUIREMENT_OPTIONS = {
  readSource: true,
  excludeBlockQuotes: true,
};

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
 * markdown-it's token stream. Code, HTML comments and thematic breaks hold
 * none; another HTML block holds the leaves of its source read with
 * `htmlAsText` (`addHtmlBlock`), each line mapped back to the section by
 * `lineAt` and its blocks inside the container that ends at `rootEnd`. No tree is
 * built, and the open containers are kept as parallel arrays of
 * primitives: on a long section of nested lists, an object per token made
 * the growth allocation-bound, near the perf ceiling.
 */
function leavesOf(content: string, md = parser, lineAt = (line: number): number => line, rootEnd = Infinity, excludeBlockQuotes?: boolean): Leaf[] {
  const tokens = excludeBlockQuotes ? parseWithoutHtmlQuotes(content, md) : md.parse(content, {});
  const leaves: Leaf[] = [];
  const at = (map: [number, number] | null): [number, number] => {
    const first = map === null ? 0 : map[0];
    const end = map === null ? 0 : map[1];
    return [lineAt(first), end > first ? lineAt(end - 1) + 1 : lineAt(first)];
  };
  /** The type, last line (exclusive) and filled state of each open container, the section itself first. */
  const openType: string[] = ["root"];
  const openEnd: number[] = [rootEnd];
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
    if (token.type === "blockquote_open" && excludeBlockQuotes) {
      // The closing token is at the same level as the opener.
      while (tokens[i + 1]!.level > token.level) i++;
      i++;
      continue;
    }
    if (token.type === "table_open") {
      table = { map: at(token.map), rows: [], containerEnd: openEnd[top]! };
    } else if (token.type === "html_block") {
      addHtmlBlock(leaves, token.content, at(token.map), openEnd[top]!, md === parser);
    } else if (token.type === "paragraph_open" || token.type === "heading_open") {
      const opensItem = token.type === "paragraph_open" && openType[top] === "list_item_open" && !openFilled[top];
      leaves.push(textLeaf(token.type, at(token.map), tokens[i + 1]?.content ?? "", openEnd[top]!, opensItem));
      i += 2;
    } else if (token.nesting === 1) {
      openFilled[top] = true;
      openType.push(token.type);
      openEnd.push(token.map === null ? Infinity : at(token.map)[1]);
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

/**
 * Extends the paragraph that ends where the comment lines `lines` start to
 * their end, when it sits in the container that ends at `containerEnd`. A
 * comment is not document text: a paragraph it interrupts, CommonMark having
 * ended it there (§4.6, start condition 2), goes on with the paragraph right
 * under it (PR #303 review, note 1).
 */
function extendOverComment(leaves: Leaf[], lines: [number, number], containerEnd: number): void {
  const last = leaves[leaves.length - 1];
  if (last?.type === "paragraph" && last.map[1] === lines[0] && last.containerEnd === containerEnd) {
    leaves[leaves.length - 1] = { ...last, map: [last.map[0], lines[1]] };
  }
}

/**
 * Adds what an HTML block at `lines` of the section holds to `leaves`. A
 * comment extends the paragraph above it (`extendOverComment`). Another
 * block of the section is parsed again with `htmlAsText`, inside the
 * container that ends at `containerEnd`, unless it is a raw-text block,
 * which defines nothing: `htmlAsText` opens one where the section's parser
 * does. An HTML block met by `htmlAsText` is a comment or a raw-text block
 * (`opaqueHtmlBlock`), so it is never parsed again.
 */
function addHtmlBlock(leaves: Leaf[], content: string, lines: [number, number], containerEnd: number, reparse: boolean): void {
  if (isHtmlComment(content)) extendOverComment(leaves, lines, containerEnd);
  else if (reparse) leaves.push(...leavesOf(content, htmlAsText, (line) => lines[0] + line, containerEnd));
}

/** The leaf of a paragraph or heading, from its opening token's type, its lines and its inline source. */
function textLeaf(openType: string, map: [number, number], inline: string, containerEnd: number, opensItem: boolean): Leaf {
  const type = openType === "paragraph_open" ? "paragraph" : "heading";
  return { type, map, inline, rows: NO_ROWS, containerEnd, opensItem };
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
function tableBodyText(table: Leaf, end = table.rows.length): string {
  const [header, ...rows] = table.rows.slice(0, end);
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

/** The identifier a table row defines (its first cell, optionally code), or undefined. */
const rowId = (cells: readonly string[], ids: DefinitionIds): string | undefined => ids.cell.exec(cells[0] ?? "")?.[1];

/** The requirement rows of a table: a row whose first cell is one identifier; its statement is the other cells less the metadata columns. */
function tableDefinitions(table: Leaf, ids: DefinitionIds, readSource?: boolean): RequirementDefinition[] {
  const rows = table.rows;
  const [header] = rows;
  if (header === undefined) return [];
  const headers = cellTexts(header);
  const metadata = metadataColumns(headers);
  const sourceIndex = readSource
    ? headers.findIndex(cell => ["source", "traceability", "source/traceability"].includes(cell.toLowerCase()))
    : -1;
  const out: RequirementDefinition[] = [];
  rows.forEach((row, r) => {
    const cells = cellTexts(row);
    const id = rowId(cells, ids);
    if (id === undefined) return;
    // The header row is a definition only when its first cell is one; it
    // names no metadata column for itself.
    const skip = r === 0 ? new Set<number>() : metadata;
    const traceColumn = r === 0 ? undefined : sourceIndex;
    const text = cells
      .slice(1)
      .filter((_, i) => !skip.has(i + 1) && i + 1 !== traceColumn)
      .join(" | ");
    const source = cells[traceColumn ?? -1];
    out.push(source === undefined ? { id, text } : { id, text, source });
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
function definingId(source: string, boldOnly: boolean, ids: DefinitionIds): { id: string; rest: string } | null {
  // A continuation line keeps its indentation in the inline source; the
  // parser has already decided it is paragraph text (PR #299 review, Codex P2).
  const line = source.replace(/^[ \t]+/, "");
  if (boldOnly && !ids.boldLine.test(line)) return null;
  const found = ids.definingLine.exec(line);
  return found === null ? null : { id: found[1]!, rest: found[2]! };
}

/**
 * Where a leaf opens a definition, else -1: for a paragraph, the index of
 * its first line that does (a list item's first line or a bold line); for a
 * heading, 0 when it defines one; for a table, the index of its first row
 * that defines one, the header row being 0 (PR #301 review, note 3). Another
 * definition ends the text of the one before it, as the line scanner closed
 * it (PR #299 review, Codex P2).
 */
function firstDefiningLine(leaf: Leaf, ids: DefinitionIds): number {
  if (leaf.type === "table") return leaf.rows.findIndex((row) => rowId(cellTexts(row), ids) !== undefined);
  if (leaf.type === "heading") return definingId(leaf.inline, false, ids) === null ? -1 : 0;
  return leaf.inline.split("\n").findIndex((line, i) => definingId(line, !(leaf.opensItem && i === 0), ids) !== null);
}

/**
 * The text of a leaf before its first definition, and whether one starts in
 * it. For a table, the rows above its first defining row are kept, read as
 * `tableBodyText` reads them, so a bound stated there still counts (PR #300
 * review, Codex P2).
 */
function textBeforeDefinition(leaf: Leaf, ids: DefinitionIds): { text: string; ends: boolean } {
  const at = firstDefiningLine(leaf, ids);
  if (at < 0) return { text: leafText(leaf), ends: false };
  if (leaf.type === "table") return { text: at === 0 ? "" : tableBodyText(leaf, at), ends: true };
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
function paragraphDefinitionText(rest: string, paragraph: Leaf, following: Iterable<Leaf> | null, ids: DefinitionIds): string {
  const lines = [withoutStatementMarkers(rest)];
  let last = paragraph.map[1];
  for (const leaf of following ?? []) {
    if (leaf.type !== "paragraph" || leaf.map[0] !== last) break;
    const before = textBeforeDefinition(leaf, ids);
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
function paragraphDefinitions(paragraph: Leaf, following: () => Iterable<Leaf>, ids: DefinitionIds): RequirementDefinition[] {
  const lines = paragraph.inline.split("\n");
  const starts: { line: number; id: string; rest: string }[] = [];
  lines.forEach((line, i) => {
    const found = definingId(line, !(paragraph.opensItem && i === 0), ids);
    if (found !== null) starts.push({ line: i, ...found });
  });
  return starts.map((start, k) => {
    const next = starts[k + 1];
    const body = lines.slice(start.line + 1, next?.line ?? lines.length);
    const rest = [start.rest, ...body].join("\n");
    return { id: start.id, text: paragraphDefinitionText(rest, paragraph, next === undefined ? following() : null, ids) };
  });
}

/**
 * A heading's body: the leaf blocks after it, in document order, up to the
 * next heading at any depth or level, or the next definition (a list item,
 * bold line or table row that defines a requirement; PR #299 review, Codex P2).
 */
function headingBody(leaves: readonly Leaf[], at: number, ids: DefinitionIds): string {
  const lines: string[] = [];
  for (let k = at + 1; k < leaves.length && leaves[k]!.type !== "heading"; k++) {
    const before = textBeforeDefinition(leaves[k]!, ids);
    if (before.text !== "") lines.push(before.text);
    if (before.ends) break;
  }
  return lines.join("\n");
}

/** Raw paragraph lines, excluding fenced and indented code blocks. */
export function* proseLines(content: string, excludeBlockQuotes?: boolean): Generator<string> {
  for (const leaf of leavesOf(content, excludeBlockQuotes ? htmlAsText : parser, undefined, undefined, excludeBlockQuotes)) {
    if (leaf.type === "paragraph") yield* leaf.inline.split("\n");
  }
}

/**
 * The requirement definitions of a section, in document order: table rows,
 * list items, headings and bold lines. `prefixes` names the identifiers read
 * (`FR` and `NFR` by default; upper-case letters only); a definition of
 * another prefix is not one, so it does not end the text of the one before.
 */
export function requirementDefinitions(
  content: string,
  prefixes: readonly string[] = REQUIREMENT_PREFIXES,
  options?: { readonly readSource?: boolean; readonly excludeBlockQuotes?: boolean },
): RequirementDefinition[] {
  const ids = definitionIds(prefixes);
  const parserForDefinitions = options?.excludeBlockQuotes ? htmlAsText : parser;
  const leaves = leavesOf(content, parserForDefinitions, undefined, undefined, options?.excludeBlockQuotes);
  const out: RequirementDefinition[] = [];
  leaves.forEach((leaf, at) => {
    if (leaf.type === "table") {
      out.push(...tableDefinitions(leaf, ids, options?.readSource));
      return;
    }
    if (leaf.type === "heading") {
      const found = definingId(leaf.inline, false, ids);
      if (found !== null) out.push({ id: found.id, text: [found.rest, headingBody(leaves, at, ids)].join("\n") });
      return;
    }
    // The blocks that may go on with the paragraph are the later leaves of
    // its container (its list item, or the block it sits in), a run of
    // `leaves` read lazily up to the container's last line: listing the
    // container's leaves for each paragraph was quadratic in a long section.
    function* following(): Generator<Leaf> {
      for (let k = at + 1; k < leaves.length && leaves[k]!.map[0] < leaf.containerEnd; k++) yield leaves[k]!;
    }
    out.push(...paragraphDefinitions(leaf, following, ids));
  });
  return out;
}
