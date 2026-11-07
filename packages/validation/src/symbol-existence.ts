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
 *  - Only inline code spans are read (see `inline-code-spans.ts`). Fenced
 *    blocks are skipped: they show proposed code, whose local identifiers
 *    are not claims about the existing codebase.
 *  - A span counts as a symbol reference only when it is code-shaped beyond
 *    doubt: a call (`parseConfig()`, `UserService.create(id)`), a `::` or
 *    `#` qualified path (`Billing::Invoice`, `User#save` — a `#` owner must be
 *    PascalCase, so `README#install` is an anchor), or a dotted path
 *    starting with an upper-case segment (`UserService.create`) whose last
 *    segment is not a file extension (`README.md` is a file, not a symbol).
 *    A bare word in backticks (`user_id`) is ambiguous — a field, a config
 *    key, a column — and is not read.
 *  - A dotted reference needs an upper-case first segment: a lower-case
 *    receiver (`user.save()`) is a local or runtime object. JS built-ins
 *    (`JSON.parse()`, `fetch()`) and Rust `std::` paths are not read.
 *  - A reference is resolved when its segment path is a suffix of a known
 *    symbol's path or the other way round, so `create()` resolves against a
 *    graph entry `UserService.create`; `Order.create` does not. A bare graph
 *    entry resolves a qualified reference only when no qualified entry shares
 *    its last segment. Graph entries lose their signature, generic arguments
 *    and optional markers (`decode<T>(from:)` → `decode`).
 *
 * An unresolved symbol is either introduced by the PRD or fabricated; this
 * check cannot tell which, so it reports and does not score. Turning it into
 * a scored Hard Output Rule is a separate decision (it would move the frozen
 * calibration baselines).
 */

import { inlineCodeSpans } from "./inline-code-spans.js";

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
  /** Number of distinct known symbols the check compared against. */
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

const IDENT = "[A-Za-z_$][\\w$]*";
/**
 * `a`, `a.b`, `A::b`, `A#b`, optionally followed by an argument list. The
 * argument text may hold nested calls (`run(normalize(x))`); its parentheses
 * are checked for balance separately, so the pattern stays linear.
 */
const SYMBOL_SHAPE = new RegExp(
  `^(${IDENT}(?:(?:\\.|::|#)${IDENT})*)(\\((.*)\\))?$`,
);

/**
 * Whether the parentheses of an argument list balance, ignoring those inside
 * a quoted string (`run(")")`) and escaped quotes within it (PR #174 review
 * r4501809310). A `'` opens a string only after a non-word character, so an
 * apostrophe in prose (`notify(user's email)`, `run(don't)`) or a Rust
 * lifetime (`parse(&'a str)`) is plain text (PR #174 review r4501836587).
 * A string still open at the end is unbalanced.
 */
function balancedParens(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let prev = "";
  for (const ch of text) {
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || (ch === "'" && !/[\w&]/.test(prev))) quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")" && --depth < 0) return false;
    prev = ch;
  }
  return depth === 0 && quote === null;
}

/**
 * Language built-ins a PRD names in passing (`JSON.parse()`, `fetch()`): no
 * project graph holds them, so reporting them would bury the fabricated
 * project symbol this check exists to find. Applied to `.` paths and bare
 * calls only — any such reference whose first segment is one of these names
 * is skipped, so a project method on an owner with the same name
 * (`Date.businessDays()`) is not checked. `::` and `#` paths (Rust, Ruby,
 * C++) are not affected. JS/TS globals only.
 * source: provisional heuristic (PR #174 reviews r4501804248, r4501822515).
 */
const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  "JSON", "Math", "Object", "Array", "Promise", "Number", "String", "Date",
  "Reflect", "Symbol", "Intl", "Buffer", "Error", "Map", "Set", "URL",
  "fetch", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "parseInt", "parseFloat", "require", "structuredClone",
]);

/** Roots of a `::` path that name a language's standard library (Rust). */
const STD_ROOTS: ReadonlySet<string> = new Set(["std", "core", "alloc"]);

/**
 * The owner of a `#` path: a PascalCase class name (`User#save`). An all-caps
 * word (`README#install`), a lower-case word (`docs#setup`) or a file name
 * (`CONTRIBUTING.md#setup`) before `#` is a markdown anchor, not a method.
 */
const PASCAL_OWNER = /^[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$/;

/** Last segments that make a dotted span a file name, not a member access. */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "md", "txt", "json", "yaml", "yml", "toml", "xml", "html", "css", "csv",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java",
  "kt", "kts", "swift", "sh", "sql", "lock", "env", "cfg", "ini", "log",
  "pdf", "png", "svg", "plist", "cs", "config", "vue", "resolved",
  "storyboard", "xib", "xcconfig", "gradle", "proto", "graphql", "c", "h",
  "cpp", "hpp", "php", "dart", "scala",
]);

function segments(path: string): string[] {
  return path.split(/\.|::|#/).filter((s) => s.length > 0);
}

/** The symbol a span names, or null when the span is not code-shaped. */
export function symbolFromSpan(span: string): string | null {
  const text = span.trim();
  if (text.length === 0 || text.length > MAX_SPAN_LENGTH) return null;
  const match = SYMBOL_SHAPE.exec(text);
  if (match === null) return null;
  const isCall = match[2] !== undefined;
  if (isCall && !balancedParens(match[3])) return null;
  const path = match[1];
  const parts = segments(path);
  if (path.includes("::")) return STD_ROOTS.has(parts[0]) ? null : path;
  if (path.includes("#")) {
    return PASCAL_OWNER.test(path.slice(0, path.indexOf("#"))) ? path : null;
  }
  if (BUILTIN_NAMES.has(parts[0])) return null;
  if (!path.includes(".")) return isCall ? path : null;
  // A lower-case receiver (`user.save()`, `this.handle()`, `console.log()`)
  // is a local variable or a runtime object, not a project symbol path.
  if (!/^[A-Z]/.test(parts[0])) return null;
  return isCall || !FILE_EXTENSIONS.has(parts[parts.length - 1].toLowerCase())
    ? path
    : null;
}

/** `T<U<V>>` → `T`: generic arguments removed, innermost first. */
function stripGenerics(text: string): string {
  let out = text;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(/<[^<>]*>/g, "");
  }
  return out;
}

/**
 * A graph entry as segments, its decorations removed so it compares like a
 * reference: the signature (`parseConfig()`, Swift `create(email:)`), generic
 * arguments (`decode<T>`, `Repo<User>.find`) and optional markers
 * (`init?(data:)`) (PR #174 reviews r4501804140, r4501822704).
 */
function knownSegments(entry: string): string[] {
  const text = entry.trim();
  const paren = text.indexOf("(");
  const path = stripGenerics(paren >= 0 ? text.slice(0, paren) : text);
  return segments(path)
    .map((s) => s.replace(/[?!]+$/, ""))
    .filter((s) => s.length > 0);
}

interface TrieNode {
  readonly children: Map<string, TrieNode>;
  /** A graph entry ends here. */
  end: boolean;
}

/** Graph entries in a trie keyed on their segments, last segment first. */
function suffixTrie(known: readonly (readonly string[])[]): TrieNode {
  const root: TrieNode = { children: new Map(), end: false };
  for (const parts of known) {
    let node = root;
    for (let k = parts.length - 1; k >= 0; k--) {
      let next = node.children.get(parts[k]);
      if (!next) {
        next = { children: new Map(), end: false };
        node.children.set(parts[k], next);
      }
      node = next;
    }
    node.end = true;
  }
  return root;
}

/**
 * Whether `ref` resolves: its path is a suffix of a graph entry's path (the
 * walk consumes the whole reference), or a graph entry's path is a suffix of
 * it (an entry ends on the walk). O(segments of `ref`), whatever the graph
 * size (PR #174 review r4501819785). A bare graph entry (`create`) resolves a
 * qualified reference (`PaymentGateway.create`) only when no qualified entry
 * shares its last segment: once the graph says which owners have a `create`,
 * an unlisted owner is unresolved (PR #174 review r4501804340).
 */
function resolves(root: TrieNode, ref: readonly string[]): boolean {
  let node = root;
  for (let k = ref.length - 1; k >= 0; k--) {
    const next = node.children.get(ref[k]);
    if (!next) return false;
    node = next;
    const bareWithOwners = k === ref.length - 1 && node.children.size > 0;
    if (node.end && k > 0 && !bareWithOwners) return true;
  }
  return true;
}

/**
 * Occurrences per referenced symbol, keyed by its segment path so that
 * `User#save` and `User.save` count as one symbol, reported under the
 * spelling seen first.
 */
function referenceCounts(content: string | readonly string[]): Map<string, UnresolvedSymbol> {
  const counts = new Map<string, UnresolvedSymbol>();
  const parts = typeof content === "string" ? [content] : content;
  for (const part of parts) {
    for (const span of inlineCodeSpans(part)) {
      const symbol = symbolFromSpan(span);
      if (symbol === null) continue;
      const key = segments(symbol).join(".");
      const seen = counts.get(key);
      counts.set(key, { symbol: seen?.symbol ?? symbol, occurrences: (seen?.occurrences ?? 0) + 1 });
    }
  }
  return counts;
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
  const distinct = new Map<string, string[]>();
  for (const parts of knownSymbols.map(knownSegments)) {
    if (parts.length > 0) distinct.set(parts.join("."), parts);
  }
  const trie = suffixTrie([...distinct.values()]);

  const counts = referenceCounts(content);
  const unresolved: UnresolvedSymbol[] = [];
  for (const [key, entry] of counts) {
    const ref = key.split(".");
    if (!resolves(trie, ref)) unresolved.push(entry);
  }
  unresolved.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

  return {
    checkedSymbols: counts.size,
    knownSymbols: distinct.size,
    unresolvedSymbols: unresolved,
  };
}
