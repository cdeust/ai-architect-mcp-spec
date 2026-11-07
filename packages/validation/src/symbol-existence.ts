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
 *    (`JSON.parse()`, `fetch()`) and `std::` paths are not read; a Rust
 *    relative root (`crate::`, `self::`, `super::`, `Self::`) is dropped; a
 *    non-call left with one name (`Self::CONST`) is not read.
 *  - A call's parentheses must balance, reading quotes either as string
 *    delimiters or not at all (see balancedParens).
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
  /**
   * The reference as first written, call arguments and leading Rust relative
   * roots removed (`UserService.create`; `crate::config::load()` →
   * `config::load`).
   */
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
 * `'` read as text rather than a string delimiter: inside a word (`don't`,
 * `user's`, `rock'n'roll`), or a Rust lifetime right after `&` or `<`
 * (`&'a str`, `Cow<'a, str>`). A JS string directly after `<` with no space
 * (`x <'m'`) is rare enough to give up; reading `<'a` as a string instead
 * let two lifetimes pair up and hide a second call
 * (`Parser::new(Cow<'a, str>) and Lexer::new(Cow<'a, str>)`, PR #174 review
 * r4501971277). Every other `'` is ambiguous (a JS string or a lifetime
 * after `+`, `,`), which balancedParens settles when a string is left open.
 */
function isTextApostrophe(text: string, i: number): boolean {
  if (/\w/.test(text[i - 1] ?? "") && /\w/.test(text[i + 1] ?? "")) return true;
  return (text[i - 1] === "&" || text[i - 1] === "<") && /[A-Za-z_]/.test(text[i + 1] ?? "");
}

/** Whether parentheses balance when every quote is ignored. */
function balancedIgnoringQuotes(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * How parentheses fare when `"` and `'` delimit strings (except the
 * apostrophes isTextApostrophe reads as text), with escapes inside strings:
 * "ok" when they balance and every string closes, "open" when a string is
 * still open at the end, "unbalanced" otherwise.
 */
function balanceWithStrings(text: string): "ok" | "open" | "unbalanced" {
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
    else if (ch === ")" && --depth < 0) return "unbalanced";
  }
  if (quote !== null) return "open";
  return depth === 0 ? "ok" : "unbalanced";
}

/**
 * Whether an argument list's parentheses balance. Quotes are read as string
 * delimiters first. A quote in prose is ambiguous, though — `'a` after `<`
 * or `+` is a Rust lifetime, not a string — and a lifetime read as a string
 * swallows the rest of the text, so it ends with a string still open. Only
 * then is the quote-blind reading tried. Guessing the apostrophe has
 * regressed both ways in review (PR #174 reviews r4501894817, r4501919701,
 * r4501937076), and accepting the quote-blind reading unconditionally let a
 * string's parenthesis close another call's (`Parser.open('(') +
 * Ghost.run(')')`, review r4501956987). So `notify(")")`, `run('(')` and
 * `prefix + 'b'` balance as strings; `Cow<'a, str>` and `x: &'a T + 'static`
 * balance only quote-blind, after the string reading is left open; and
 * `f(a) + g(b)`, `Parser.open('(') + Ghost.run(')')` and
 * `Bus.emit("(") + Ghost.run(")")` are unbalanced.
 */
function balancedParens(text: string): boolean {
  const withStrings = balanceWithStrings(text);
  return withStrings === "ok" || (withStrings === "open" && balancedIgnoringQuotes(text));
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
 * `my_crate::config::load`; `Self::new()` → `new`). All leading roots go
 * (`super::super::Config::load()` → `Config::load`), the rest is reported
 * joined with `::`, and a non-call left with one name (`Self::CONST`,
 * `crate::Foo`) or a path ending in a root (`super::super()`) is not read.
 */
const RELATIVE_ROOTS: ReadonlySet<string> = new Set(["Self", "self", "super", "crate"]);

/**
 * The owner of a `#` path: one PascalCase name — an upper-case first letter
 * and at least one lower-case letter, no `.` (`User#save`, `URLParser#parse`).
 * An all-caps word (`README#install`), a lower-case word (`docs#setup`), a
 * dotted path or file name (`CONTRIBUTING.md#setup`) before `#` is read as a
 * markdown anchor, not a method.
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
    let roots = 0;
    while (roots < parts.length - 1 && RELATIVE_ROOTS.has(parts[roots])) roots += 1;
    if (roots === 0) return path;
    // `super::super::Config::load` → `Config::load`. A single name left by a
    // non-call (`Self::CONST`, `crate::Foo`) is as ambiguous as a bare word
    // in backticks and is not read (PR #174 review r4501895577).
    const rest = parts.slice(roots);
    // A path ending in a root (`super::super()`, `crate::config::self`)
    // names no symbol.
    if (RELATIVE_ROOTS.has(rest[rest.length - 1])) return null;
    return rest.length === 1 && !isCall ? null : rest.join("::");
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
 * A graph entry's path: generic arguments removed and the text cut at the
 * signature's `(`, in one pass with a depth counter, so nesting does not
 * multiply the cost (PR #174 review r4501850098). A `(` inside generic
 * arguments (`Repo<(User, Error)>.find`, `Repo<() => User>.find`) is not the
 * signature, and the `>` of an arrow (`=>`, `->`) closes nothing (PR #174
 * review r4501917318). A depth-0 `->` is a member access and reads as `.`
 * (`Foo->bar` → `Foo.bar`), except after `operator`, so C++ `operator->`
 * cannot match `operator()` (review r4501962748). Every `>` is dropped; an
 * unmatched `<` drops the rest of the entry.
 */
function entryPath(text: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<") depth += 1;
    else if (ch === ">") {
      if (text[i - 1] !== "-" && text[i - 1] !== "=") depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      if (ch === "(") break;
      // A depth-0 `->` is a member access (`Foo->bar`): append `.` and skip
      // the `>`, so the output is never rewritten (review r4501957183).
      // C++ `operator->` keeps its arrow, so it cannot collide with
      // `operator()`.
      if (ch === "-" && text[i + 1] === ">" && !out.endsWith("operator")) {
        out += ".";
        i += 1;
      } else out += ch;
    }
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
  return segments(entryPath(entry.trim()))
    .map(trimOptionalMarkers)
    .filter((s) => s.length > 0);
}

/** A node of the reference trie: reference segments, last segment first. */
interface RefNode {
  readonly children: Map<string, RefNode>;
  /** A reference ends here. */
  refEnd: boolean;
  /** A graph entry has this path as a suffix: the reference ending here resolves. */
  coveredByEntry: boolean;
  /** A graph entry's whole path ends here: longer references through here resolve. */
  entryEnd: boolean;
}

function newRefNode(): RefNode {
  return { children: new Map(), refEnd: false, coveredByEntry: false, entryEnd: false };
}

/** The references in a trie keyed on their segments, last segment first. */
function referenceTrie(keys: Iterable<string>): RefNode {
  const root = newRefNode();
  for (const key of keys) {
    const ref = key.split(".");
    let node = root;
    for (let k = ref.length - 1; k >= 0; k--) {
      let next = node.children.get(ref[k]);
      if (!next) {
        next = newRefNode();
        node.children.set(ref[k], next);
      }
      node = next;
    }
    node.refEnd = true;
  }
  return root;
}

/**
 * Walk one graph entry down the reference trie, last segment first. Every
 * reference ending on the walk is a suffix of the entry; if the whole entry
 * is walked, the entry is a suffix of every longer reference through its
 * end. The trie holds only the references, so its memory is bounded by the
 * PRD, not by the graph, and each entry costs O(its segments) (PR #174
 * reviews r4501885091, r4501910687). The only graph-sized state kept is the
 * set of distinct entry paths, needed for the `knownSymbols` count.
 */
function streamEntry(root: RefNode, parts: readonly string[]): void {
  let node = root;
  for (let k = parts.length - 1; k >= 0; k--) {
    const next = node.children.get(parts[k]);
    if (!next) return;
    node = next;
    // Marking only reference ends is an optimisation: `coveredByEntry` is
    // read only where a reference ends.
    if (node.refEnd) node.coveredByEntry = true;
  }
  node.entryEnd = true;
}

/**
 * Whether `ref` resolves after every graph entry was streamed: a graph entry
 * has its path as a suffix, or a graph entry's path is a suffix of it. A bare
 * graph entry (`create`) resolves a qualified reference
 * (`PaymentGateway.create`) only when no qualified entry shares its last
 * segment: once the graph says which owners have a `create`, an unlisted
 * owner is unresolved (PR #174 review r4501804340).
 */
function resolves(root: RefNode, ref: readonly string[], owned: ReadonlySet<string>): boolean {
  let node = root;
  for (let k = ref.length - 1; k >= 0; k--) {
    const next = node.children.get(ref[k]);
    if (!next) return false; // unreachable: every reference is in the trie
    node = next;
    const depth = ref.length - k;
    const bareWithOwners = depth === 1 && owned.has(ref[k]);
    // `k > 0` is an optimisation: at k = 0 the entry equals the reference,
    // which `coveredByEntry` already records.
    if (node.entryEnd && k > 0 && !bareWithOwners) return true;
  }
  return node.coveredByEntry;
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
 *   qualified with `.`, `::`, `#` or a C-style `->` (read as `.`).
 */
export function checkSymbolExistence(
  content: string | readonly string[],
  knownSymbols: readonly string[],
): SymbolExistenceReport {
  const counts = referenceCounts(content);
  const trie = referenceTrie(counts.keys());
  const distinct = new Set<string>();
  /** Last segments that some qualified graph entry ends with. */
  const owned = new Set<string>();
  for (const entry of knownSymbols) {
    const parts = knownSegments(entry);
    if (parts.length === 0) continue;
    distinct.add(parts.join("."));
    // `resolves` reads `owned` only for a reference's last segment, so only
    // those are kept: bounded by the PRD, not the graph (PR #174 review
    // r4501928836).
    const last = parts[parts.length - 1];
    if (parts.length > 1 && trie.children.has(last)) owned.add(last);
    streamEntry(trie, parts);
  }
  const unresolved: UnresolvedSymbol[] = [];
  for (const [key, entry] of counts) {
    if (!resolves(trie, key.split("."), owned)) unresolved.push(entry);
  }
  unresolved.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

  return {
    checkedSymbols: counts.size,
    knownSymbols: distinct.size,
    unresolvedSymbols: unresolved,
  };
}
