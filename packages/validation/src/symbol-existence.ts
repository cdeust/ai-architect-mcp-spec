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
 *    mixed-case, so `README#install` is an anchor), or a dotted path
 *    starting with an upper-case segment (`UserService.create`) whose last
 *    segment is not a file extension (`README.md` is a file, not a symbol).
 *    A bare word in backticks (`user_id`) is ambiguous — a field, a config
 *    key, a column — and is not read.
 *  - A dotted reference needs an upper-case first segment: a lower-case
 *    receiver (`user.save()`) is a local or runtime object. JS built-ins
 *    (`JSON.parse()`, `fetch()`) and `std::` paths are not read; a Rust
 *    relative root (`crate::`, `self::`, `super::`, `Self::`) is dropped.
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

/** `'` used as text, not a string delimiter. */
function isTextApostrophe(text: string, i: number): boolean {
  const prev = text[i - 1] ?? "";
  const next = text[i + 1] ?? "";
  // An apostrophe inside a word: `don't`, `user's`.
  if (/\w/.test(prev) && /\w/.test(next)) return true;
  // A Rust lifetime: `'a` or `'_` followed by a non-`'`, as in `&'a str`,
  // `Cow<'a, str>`, `Ref<'_>`; a char literal `'a'` stays a string.
  const lifetime = /^'[A-Za-z_]\w*/.exec(text.slice(i));
  return lifetime !== null && text[i + lifetime[0].length] !== "'";
}

/**
 * Whether the parentheses of an argument list balance, ignoring those inside
 * a quoted string (`run(")")`, `b'('`, `r'('`) and escaped quotes within it
 * (PR #174 review r4501809310). An apostrophe inside a word or a Rust
 * lifetime is text, not a delimiter (PR #174 reviews r4501836587,
 * r4501864237). A string still open at the end is unbalanced.
 */
function balancedParens(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || (ch === "'" && !isTextApostrophe(text, i))) quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")" && --depth < 0) return false;
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

/**
 * Roots of a `::` path that name a standard library: `std` in Rust and C++.
 * Rust's `core`/`alloc` are not listed, because `core` is also a common C++
 * project namespace (`core::Engine`); a Rust `core::` path is reported
 * (PR #174 review r4501862020).
 */
const STD_ROOTS: ReadonlySet<string> = new Set(["std"]);

/**
 * Rust relative roots: they name the current module, type or crate, not a
 * symbol, so they are dropped and the rest of the path is checked
 * (`crate::config::load` → `config::load`, which resolves by suffix against
 * `my_crate::config::load`; `Self::new` → `new`).
 */
const RELATIVE_ROOTS: ReadonlySet<string> = new Set(["Self", "self", "super", "crate"]);

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
  if (path.includes("::")) {
    if (STD_ROOTS.has(parts[0])) return null;
    if (!RELATIVE_ROOTS.has(parts[0])) return path;
    const rest = path.slice(path.indexOf("::") + 2);
    return rest.length > 0 ? rest : null;
  }
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

/**
 * `T<U<V>>` → `T`: generic arguments removed in one pass with a depth
 * counter, so nesting depth does not multiply the cost (PR #174 review
 * r4501850098). An unmatched `>` is dropped.
 */
function stripGenerics(text: string): string {
  let out = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === "<") depth += 1;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/** `init?!` → `init`, by a loop from the end (no unanchored regex retries). */
function trimOptionalMarkers(segment: string): string {
  let end = segment.length;
  while (end > 0 && (segment[end - 1] === "?" || segment[end - 1] === "!")) end -= 1;
  return segment.slice(0, end);
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
    .map(trimOptionalMarkers)
    .filter((s) => s.length > 0);
}

/**
 * The graph entries a reference can reach, cut to the depth a walk can go.
 * `resolves` only enters the bucket of a reference's last segment and never
 * walks deeper than the longest reference, so an entry with another last
 * segment, or the head of a longer entry, changes no result. Keeping at least
 * 2 segments preserves the "bare entry with owners" test at depth 1. The trie
 * is thus bounded by the references (at most MAX_SPAN_LENGTH characters
 * each), not by the graph size (PR #174 reviews r4501850098, r4501882299,
 * r4501885091).
 */
function reachableEntries(
  known: readonly string[][],
  counts: ReadonlyMap<string, UnresolvedSymbol>,
): string[][] {
  const lastSegments = new Set<string>();
  let depth = 2;
  for (const key of counts.keys()) {
    const ref = key.split(".");
    lastSegments.add(ref[ref.length - 1]);
    depth = Math.max(depth, ref.length);
  }
  return known
    .filter((parts) => lastSegments.has(parts[parts.length - 1]))
    .map((parts) => parts.slice(-depth));
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
  const counts = referenceCounts(content);
  const trie = suffixTrie(reachableEntries([...distinct.values()], counts));
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
