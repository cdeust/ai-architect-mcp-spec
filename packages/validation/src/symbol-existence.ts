/**
 * Deterministic symbol-existence check (issue #118, first symbol slice).
 *
 * The audit of v0.8.0 found that a PRD naming a fabricated function passed
 * every deterministic tool: nothing compared the code symbols a PRD names
 * with the symbols the codebase actually contains. The server does not read a
 * codebase itself (the host executes every action), so the host supplies the
 * symbol list it got from its code graph and this function does the
 * comparison — pure string work, zero model calls.
 *
 * Policy, deliberately narrow:
 *  - Only inline code spans are read. Fenced blocks are skipped: they show
 *    proposed code, whose local identifiers are not claims about the
 *    existing codebase.
 *  - A span counts as a symbol reference only when it is code-shaped beyond
 *    doubt: a call (`parseConfig()`, `UserService.create(id)`), a `::` or
 *    `#` qualified path (`Billing::Invoice`, `User#save`), or a dotted path
 *    starting with an upper-case segment (`UserService.create`) whose last
 *    segment is not a file extension (`README.md` is a file, not a symbol).
 *    A bare word in backticks (`user_id`) is ambiguous — a field, a config
 *    key, a column — and is not read.
 *  - A reference is resolved when its segment path is a suffix of a known
 *    symbol's path or the other way round, so `create()` resolves against a
 *    graph entry `UserService.create`, and `UserService.create` resolves
 *    against a bare `create` entry; `Order.create` does not resolve against
 *    `UserService.create`.
 *
 * An unresolved symbol is either introduced by the PRD or fabricated; this
 * check cannot tell which, so it reports and does not score. Turning it into
 * a scored Hard Output Rule is a separate decision (it would move the frozen
 * calibration baselines).
 */

/** One referenced symbol that no supplied graph symbol resolves. */
export interface UnresolvedSymbol {
  /** The reference as written, call arguments removed (`UserService.create`). */
  readonly symbol: string;
  /** Number of inline code spans that reference it. */
  readonly occurrences: number;
}

export interface SymbolExistenceReport {
  /** Distinct code-shaped symbols referenced in inline code spans. */
  readonly checkedSymbols: number;
  /** Number of known symbols the check compared against. */
  readonly knownSymbols: number;
  /** References with no match in the known symbols, sorted by name. */
  readonly unresolvedSymbols: readonly UnresolvedSymbol[];
}

/**
 * Longest inline code span read. A symbol reference is short; a longer span
 * is a code fragment, not a name, and the cap keeps the per-span regexes on
 * bounded input. source: provisional heuristic.
 */
const MAX_SPAN_LENGTH = 200;

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const BACKTICK_RUN = /`+/g;

const IDENT = "[A-Za-z_$][\\w$]*";
/**
 * `a`, `a.b`, `A::b`, `A#b`, optionally followed by an argument list. The
 * argument text may hold nested calls (`run(normalize(x))`); its parentheses
 * are checked for balance separately, so the pattern stays linear.
 */
const SYMBOL_SHAPE = new RegExp(
  `^(${IDENT}(?:(?:\\.|::|#)${IDENT})*)(\\((.*)\\))?$`,
);

function balancedParens(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * The inline code spans of one line, CommonMark style: a run of N backticks
 * opens a span that only the next run of exactly N backticks closes, so
 * `` `x` `` holds a literal backtick and cannot pair with a later span. An
 * opener with no closer is literal text. Linear: each run's closer is found
 * through a precomputed "next run of the same length" index.
 */
function inlineSpans(line: string): string[] {
  const runs = [...line.matchAll(BACKTICK_RUN)].map((m) => ({
    start: m.index,
    len: m[0].length,
  }));
  const nextSame = new Array<number>(runs.length).fill(-1);
  const lastSeen = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    nextSame[i] = lastSeen.get(runs[i].len) ?? -1;
    lastSeen.set(runs[i].len, i);
  }
  const spans: string[] = [];
  let i = 0;
  while (i < runs.length) {
    const j = nextSame[i];
    if (j === -1) {
      i += 1;
      continue;
    }
    spans.push(line.slice(runs[i].start + runs[i].len, runs[j].start));
    i = j + 1;
  }
  return spans;
}

/** Last segments that make a dotted span a file name, not a member access. */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "md", "txt", "json", "yaml", "yml", "toml", "xml", "html", "css", "csv",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java",
  "kt", "swift", "sh", "sql", "lock", "env", "cfg", "ini", "log", "pdf",
  "png", "svg",
]);

/**
 * `content` with every fenced code block removed, by a single line scan (no
 * backtracking regex over the whole document). A fence closes on a line that
 * starts with at least as many of the same fence characters; an unclosed
 * fence runs to the end, as in CommonMark.
 */
function stripFencedBlocks(content: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of content.split("\n")) {
    const open = FENCE_OPEN.exec(line);
    if (fence === null) {
      if (open) fence = open[1];
      else kept.push(line);
    } else if (open && open[1][0] === fence[0] && open[1].length >= fence.length
      && line.trim() === open[1]) {
      fence = null;
    }
  }
  return kept.join("\n");
}

function segments(path: string): string[] {
  return path.split(/\.|::|#/).filter((s) => s.length > 0);
}

/** The symbol a span names, or null when the span is not code-shaped. */
export function symbolFromSpan(span: string): string | null {
  const text = span.trim();
  if (text.length === 0 || text.length > MAX_SPAN_LENGTH) return null;
  const match = SYMBOL_SHAPE.exec(text);
  if (match === null) return null;
  const path = match[1];
  const isCall = match[2] !== undefined;
  if (isCall) return balancedParens(match[3]) ? path : null;
  if (path.includes("::") || path.includes("#")) return path;
  if (!path.includes(".")) return null;
  const parts = segments(path);
  const last = parts[parts.length - 1];
  if (FILE_EXTENSIONS.has(last.toLowerCase())) return null;
  return /^[A-Z]/.test(parts[0]) ? path : null;
}

function isSuffix(shorter: readonly string[], longer: readonly string[]): boolean {
  if (shorter.length > longer.length) return false;
  const offset = longer.length - shorter.length;
  return shorter.every((s, i) => s === longer[offset + i]);
}

function resolves(ref: readonly string[], known: readonly string[]): boolean {
  return isSuffix(ref, known) || isSuffix(known, ref);
}

/**
 * Compare the code symbols named in `content` with `knownSymbols`.
 * @param content PRD markdown: one section, or the document's sections as an
 *   array — each is scanned on its own, so an unclosed fence in one section
 *   cannot hide the next.
 * @param knownSymbols symbol names from the host's code graph, plain or
 *   qualified with `.`, `::` or `#`.
 */
export function checkSymbolExistence(
  content: string | readonly string[],
  knownSymbols: readonly string[],
): SymbolExistenceReport {
  const known = knownSymbols
    .map((s) => segments(s.trim()))
    .filter((parts) => parts.length > 0);
  const byLast = new Map<string, string[][]>();
  for (const parts of known) {
    const last = parts[parts.length - 1];
    const bucket = byLast.get(last);
    if (bucket) bucket.push(parts);
    else byLast.set(last, [parts]);
  }

  const counts = new Map<string, number>();
  const parts = typeof content === "string" ? [content] : content;
  for (const part of parts) {
    for (const line of stripFencedBlocks(part).split("\n")) {
      for (const span of inlineSpans(line)) {
        const symbol = symbolFromSpan(span);
        if (symbol !== null) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
      }
    }
  }

  const unresolved: UnresolvedSymbol[] = [];
  for (const [symbol, occurrences] of counts) {
    const ref = segments(symbol);
    const candidates = byLast.get(ref[ref.length - 1]) ?? [];
    if (!candidates.some((parts) => resolves(ref, parts))) {
      unresolved.push({ symbol, occurrences });
    }
  }
  unresolved.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

  return {
    checkedSymbols: counts.size,
    knownSymbols: known.length,
    unresolvedSymbols: unresolved,
  };
}
