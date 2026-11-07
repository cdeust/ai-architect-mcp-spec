/**
 * Issue #118: "A fabricated symbol passes" — no deterministic tool compared
 * the code symbols a PRD names with the codebase. These tests pin the
 * comparison against a host-supplied symbol list.
 */

import { describe, expect, it } from "vitest";
import { checkSymbolExistence, symbolFromSpan } from "../index.js";

const GRAPH = ["UserService.create", "UserService.findById", "parseConfig", "Billing::Invoice"];

describe("checkSymbolExistence — fabricated symbol (issue #118)", () => {
  it("reports a fabricated method and resolves the real ones", () => {
    const prd = [
      "FR-001: `UserService.create(email)` persists the user.",
      "FR-002: `UserService.archiveAll()` removes stale users.",
      "FR-003: startup calls `parseConfig()`; `Billing::Invoice` stays unchanged.",
    ].join("\n");
    const report = checkSymbolExistence(prd, GRAPH);
    expect(report.unresolvedSymbols).toEqual([
      { symbol: "UserService.archiveAll", occurrences: 1 },
    ]);
    expect(report.checkedSymbols).toBe(4);
    expect(report.knownSymbols).toBe(4);
  });

  it("counts every occurrence of an unresolved symbol", () => {
    const prd = "`loadUsers()` then `loadUsers()` again, and `Ghost.run()`.";
    expect(checkSymbolExistence(prd, GRAPH).unresolvedSymbols).toEqual([
      { symbol: "Ghost.run", occurrences: 1 },
      { symbol: "loadUsers", occurrences: 2 },
    ]);
  });

  it("resolves by path suffix in either direction, not by last name alone", () => {
    const prd = "`create()` and `findById()` exist; `Order.create()` does not.";
    expect(checkSymbolExistence(prd, GRAPH).unresolvedSymbols.map((u) => u.symbol))
      .toEqual(["Order.create"]);
    expect(checkSymbolExistence("`Config.parseConfig()`", GRAPH).unresolvedSymbols)
      .toEqual([]);
  });

  it("treats ::, # and . as the same separator on both sides", () => {
    expect(checkSymbolExistence("`Billing.Invoice` and `UserService#create`", GRAPH)
      .unresolvedSymbols).toEqual([]);
  });

  it("skips fenced code blocks, which show proposed code", () => {
    const prd = ["Calls `parseConfig()`.", "```ts", "const x = `newHelper()`;", "```"].join("\n");
    const report = checkSymbolExistence(prd, GRAPH);
    expect(report.checkedSymbols).toBe(1);
    expect(report.unresolvedSymbols).toEqual([]);
  });

  it("reads spans after a closed fence and ignores everything after an unclosed one", () => {
    const closed = ["```", "`inside()`", "```", "`after()`"].join("\n");
    expect(checkSymbolExistence(closed, GRAPH).unresolvedSymbols.map((u) => u.symbol))
      .toEqual(["after"]);
    const unclosed = ["`before()`", "~~~", "`inside()`"].join("\n");
    expect(checkSymbolExistence(unclosed, GRAPH).unresolvedSymbols.map((u) => u.symbol))
      .toEqual(["before"]);
  });

  it("pairs backtick runs by length, so a literal backtick cannot hide a later span (Codex r4501799706)", () => {
    const report = checkSymbolExistence("Uses `` `literal` `` and `Ghost.run()`.", []);
    expect(report.unresolvedSymbols).toEqual([{ symbol: "Ghost.run", occurrences: 1 }]);
    expect(checkSymbolExistence("`` Ghost.run() `` and ``a()`", []).unresolvedSymbols
      .map((u) => u.symbol)).toEqual(["Ghost.run"]);
  });

  it("treats an unmatched backtick as literal text", () => {
    expect(checkSymbolExistence("a ` stray, then `Ghost.run()`", []).unresolvedSymbols)
      .toEqual([]);
    expect(checkSymbolExistence("a `` stray, then `Ghost.run()`", []).unresolvedSymbols
      .map((u) => u.symbol)).toEqual(["Ghost.run"]);
  });

  it("reports every reference as unresolved when the graph is empty", () => {
    const report = checkSymbolExistence("`parseConfig()`", []);
    expect(report.knownSymbols).toBe(0);
    expect(report.unresolvedSymbols).toEqual([{ symbol: "parseConfig", occurrences: 1 }]);
  });
});

describe("symbolFromSpan — only code-shaped spans are references", () => {
  it.each([
    ["parseConfig()", "parseConfig"],
    ["UserService.create(id, email)", "UserService.create"],
    ["Billing::Invoice", "Billing::Invoice"],
    ["User#save", "User#save"],
    ["UserService.create", "UserService.create"],
    ["Ghost.run(normalize(email))", "Ghost.run"],
    ["f(g(h(x)), y)", "f"],
  ])("reads %s as %s", (span, symbol) => {
    expect(symbolFromSpan(span)).toBe(symbol);
  });

  it.each([
    "user_id",
    "README.md",
    "package.json",
    "Config.yaml",
    "config.timeout",
    "GET /users",
    "p95 < 200ms",
    "f(a))",
    "f((a)",
    "f(a) + g(b)",
    "",
    `${"a".repeat(201)}()`,
  ])("does not read %s as a symbol", (span) => {
    expect(symbolFromSpan(span)).toBeNull();
  });
});

describe("checkSymbolExistence — document sections", () => {
  it("scans each section on its own, so an unclosed fence does not hide the next", () => {
    const sections = ["Proposed:\n```ts\nconst a = 1;", "FR-001 calls `Ghost.run()`."];
    expect(checkSymbolExistence(sections, GRAPH).unresolvedSymbols).toEqual([
      { symbol: "Ghost.run", occurrences: 1 },
    ]);
    // The same text joined into one string: the open fence swallows the rest.
    expect(checkSymbolExistence(sections.join("\n\n"), GRAPH).checkedSymbols).toBe(0);
  });

  it("adds occurrences across sections", () => {
    expect(checkSymbolExistence(["`Ghost.run()`", "`Ghost.run()`"], GRAPH).unresolvedSymbols)
      .toEqual([{ symbol: "Ghost.run", occurrences: 2 }]);
  });
});

describe("checkSymbolExistence — PR #174 review fixes", () => {
  it("strips a signature from graph entries (r4501804140)", () => {
    const prd = "`parseConfig()` and `UserService.create(email)`.";
    expect(checkSymbolExistence(prd, ["parseConfig()", "UserService.create(email:)"])
      .unresolvedSymbols).toEqual([]);
  });

  it("does not read lower-case receivers or language built-ins (r4501804248)", () => {
    const prd = "`user.save()`, `this.handle()`, `console.log()`, `JSON.parse(s)`, "
      + "`Promise.all(xs)`, `fetch(url)`, then `Ghost.run()`.";
    const report = checkSymbolExistence(prd, []);
    expect(report.unresolvedSymbols).toEqual([{ symbol: "Ghost.run", occurrences: 1 }]);
    expect(report.checkedSymbols).toBe(1);
  });

  it("a bare graph entry does not resolve an unlisted owner once a qualified entry exists (r4501804340)", () => {
    const graph = ["UserService.create", "create"];
    expect(checkSymbolExistence("`PaymentGateway.create()`", graph).unresolvedSymbols)
      .toEqual([{ symbol: "PaymentGateway.create", occurrences: 1 }]);
    expect(checkSymbolExistence("`UserService.create()` and `create()`", graph)
      .unresolvedSymbols).toEqual([]);
    // With only a bare entry, the graph names no owner: the reference resolves.
    expect(checkSymbolExistence("`PaymentGateway.create()`", ["create"]).unresolvedSymbols)
      .toEqual([]);
  });

  it("does not open a fence on a line whose triple-backtick run is inline code (r4501804419)", () => {
    const prd = ["```Ghost.run()``` is new", "and `Other.go()` too"].join("\n");
    expect(checkSymbolExistence(prd, []).unresolvedSymbols.map((u) => u.symbol))
      .toEqual(["Ghost.run", "Other.go"]);
  });

  it.each([
    ["a longer closing fence closes", ["```", "`in()`", "`````", "`out()`"]],
    ["a tilde fence closes only on tildes", ["~~~", "```", "`in()`", "~~~", "`out()`"]],
    ["a shorter run does not close", ["````", "```", "", "`in()`", "````", "`out()`"]],
    ["a run with trailing text does not close", ["```", "``` x", "`in()`", "```", "`out()`"]],
    ["an indented fence of up to 3 spaces counts", ["   ```", "", "`in()`", "   ```", "`out()`"]],
    ["a fence nested in a list item counts (r4501809320)", ["- Proposed code:", "    ```ts", "", "    `in()`", "    ```", "`out()`"]],
    ["a fence on a list-marker line counts", ["1. ```ts", "", "   `in()`", "   ```", "`out()`"]],
  ])("fence rules: %s", (_name, lines) => {
    expect(checkSymbolExistence(lines.join("\n"), []).unresolvedSymbols.map((u) => u.symbol))
      .toEqual(["out"]);
  });
});

describe("checkSymbolExistence — second review round", () => {
  it("ignores parentheses inside quoted arguments (r4501809310)", () => {
    expect(checkSymbolExistence('Calls `Ghost.run(")")` and `Other.go(\'(\')`.', []).unresolvedSymbols
      .map((u) => u.symbol)).toEqual(["Ghost.run", "Other.go"]);
    expect(checkSymbolExistence('`Ghost.run("a\\"(")`', []).checkedSymbols).toBe(1);
  });

  it("rejects an argument list with an unterminated string", () => {
    expect(symbolFromSpan('Ghost.run(")')).toBeNull();
  });

  it("counts `User#save` and `User.save` as one symbol, under the first spelling", () => {
    const report = checkSymbolExistence("`User#save()` then `User.save()`", []);
    expect(report.checkedSymbols).toBe(1);
    expect(report.unresolvedSymbols).toEqual([{ symbol: "User#save", occurrences: 2 }]);
  });

  it("counts distinct known symbols", () => {
    expect(checkSymbolExistence("", ["A.b", "A::b", "A.b()", "c"]).knownSymbols).toBe(2);
  });
});

describe("checkSymbolExistence — third review round", () => {
  const syms = (prd: string, graph: string[] = []) =>
    checkSymbolExistence(prd, graph).unresolvedSymbols.map((u) => u.symbol);

  it("pairs a span hard-wrapped onto the next line (r4501818930, r4501822751)", () => {
    expect(syms("See `foo\nbar` and `Ghost.run()`.")).toEqual(["Ghost.run"]);
    expect(syms("Call `Ghost.run(\nemail)`.")).toEqual(["Ghost.run"]);
    expect(syms("Call `Ghost.run(\r\nemail)`.")).toEqual(["Ghost.run"]);
  });

  it("does not pair spans across a blank line", () => {
    expect(syms("a `stray\n\nthen `Ghost.run()`")).toEqual(["Ghost.run"]);
  });

  it("an escaped backtick cannot open a span (r4501822759)", () => {
    expect(syms("A \\` literal then `Ghost.run()`.")).toEqual(["Ghost.run"]);
    // A double backslash escapes itself: the backtick opens a span.
    expect(syms("A \\\\`Ghost.run()` here")).toEqual(["Ghost.run"]);
    // Inside a span a backslash is literal and does not stop the closer.
    expect(syms("`Ghost.run(\\)` and `Other.go()`")).toEqual(["Ghost.run", "Other.go"]);
  });

  it.each([
    "README#install", "docs#setup", "CONTRIBUTING.md#setup", "config#options",
    "std::fs::read()", "A::b(x))", "Foo::bar(x) && baz(y)",
    "Info.plist", "Program.cs", "Web.config", "App.vue", "Package.resolved",
  ])("does not read %s as a symbol (r4501819269, r4501822252)", (span) => {
    expect(symbolFromSpan(span)).toBeNull();
  });

  it.each([
    ["URLParser#parse", "URLParser#parse"],
    ["Error::NotFound", "Error::NotFound"],
    ["String#to_slug", "String#to_slug"],
    ["billing::charge()", "billing::charge"],
  ])("still reads %s: built-ins only cover `.` paths and bare calls (r4501822515)", (span, symbol) => {
    expect(symbolFromSpan(span)).toBe(symbol);
  });

  it("strips generics and optional markers from graph entries (r4501822704)", () => {
    expect(syms("`decode()`, `Parser.init()`, `Repo.find()`",
      ["decode<T>(from:)", "Parser.init?(data:)", "Repo<User>.find", "Store<K, Set<V>>.get"])).toEqual([]);
    expect(checkSymbolExistence("`Store.get()`", ["Store<K, Set<V>>.get"]).checkedSymbols).toBe(1);
    expect(syms("`Store.get()`", ["Store<K, Set<V>>.get"])).toEqual([]);
  });

  it("checks a reference against every graph entry sharing its last segment (r4501819785)", () => {
    expect(syms("`Invoice.create()` and `UserService.create()`", ["Order.create", "UserService.create"]))
      .toEqual(["Invoice.create"]);
  });

  it("resolves through a qualified suffix deeper than one segment", () => {
    expect(syms("`App.Service.create()`", ["Service.create", "Other.create"])).toEqual([]);
    expect(syms("`App.Billing.create()`", ["Service.create", "Other.create"])).toEqual(["App.Billing.create"]);
  });

});

describe("checkSymbolExistence — fourth review round", () => {
  const syms = (prd: string) => checkSymbolExistence(prd, []).unresolvedSymbols.map((u) => u.symbol);

  it("skips a fence inside a blockquote (r4501828721)", () => {
    expect(syms("> ```ts\n>\n> const x = `newHelper()`;\n> ```\n`Ghost.run()`")).toEqual(["Ghost.run"]);
    expect(syms("> - ~~~\n>   `inside()`\n>   ~~~\n`out()`")).toEqual(["out"]);
  });

  it("keeps single backticks inside a multi-line double-backtick span literal (r4501828724)", () => {
    expect(syms("Use `` multiline\n`Ghost.run()`\ntext `` here.")).toEqual([]);
  });

  it.each([
    ["UserService.notify(user's email)", "UserService.notify"],
    ["Foo.run(don't)", "Foo.run"],
    ["Parser.parse(&'a str)", "Parser.parse"],
    ["Foo.run('(')", "Foo.run"],
  ])("reads %s: an apostrophe after a word character is text (r4501836587)", (span, symbol) => {
    expect(symbolFromSpan(span)).toBe(symbol);
  });

  it("does not let two apostrophes hide an unbalanced span", () => {
    expect(symbolFromSpan("Foo.run(it's) or Bar.go(isn't)")).toBeNull();
  });
});

describe("checkSymbolExistence — fifth review round", () => {
  const syms = (prd: string, graph: string[] = []) =>
    checkSymbolExistence(prd, graph).unresolvedSymbols.map((u) => u.symbol);

  it.each([
    ["list items", "- Uses `Foo.run()\n- Then `Bar.go()`"],
    ["numbered items", "1. Uses `Foo.run()\n2. Then `Bar.go()`"],
    ["a heading", "Uses `Foo.run()\n## Then `Bar.go()`"],
    ["table rows", "| a | `Foo.run() |\n| b | `Bar.go()` |"],
    ["quote lines", "Uses `Foo.run()\n> Then `Bar.go()`"],
  ])("does not pair a stray backtick across %s (r4501850253)", (_name, prd) => {
    expect(syms(prd)).toEqual(["Bar.go"]);
  });

  it("still pairs a span wrapped inside one list item", () => {
    expect(syms("- Calls `Ghost.run(\n  email)` here")).toEqual(["Ghost.run"]);
  });

  it("normalizes pathological graph entries without losing real ones (r4501850098)", () => {
    const graph = [
      "<".repeat(256) + ">".repeat(256),
      "?".repeat(255) + "a",
      "a" + "?".repeat(255),
      "a.".repeat(250) + "Deep.run",
      "Real<T<U>>.find?!",
    ];
    const report = checkSymbolExistence("`Deep.run()` and `Real.find()` and `a()`", graph);
    expect(report.unresolvedSymbols).toEqual([]);
    // The all-generics entry normalizes to nothing; the other four remain.
    expect(report.knownSymbols).toBe(4);
  });
});

describe("checkSymbolExistence — sixth review round", () => {
  const syms = (prd: string) => checkSymbolExistence(prd, []).unresolvedSymbols.map((u) => u.symbol);

  it("ends an unclosed quoted fence with its blockquote (r4501862077)", () => {
    expect(syms("> ```ts\n> `in()`\n\nCalls `Ghost.run()`.")).toEqual(["Ghost.run"]);
    expect(syms("> ```ts\n> `in()`\nCalls `Ghost.run()`.")).toEqual(["Ghost.run"]);
  });

  it("ends an unclosed list-item fence with its list item", () => {
    expect(syms("- ```ts\n  `in()`\n\nCalls `Ghost.run()`.")).toEqual(["Ghost.run"]);
    expect(syms("- ```ts\n  `in()`\n\n  `Still.in()`\n  ```\n`out()`")).toEqual(["out"]);
  });

  it("keeps a top-level fence open across less-indented lines", () => {
    expect(syms("   ```\n`in()`\n\n`in2()`")).toEqual([]);
  });

  it.each([
    ["Self::new()", "new"],
    ["self::helpers::fmt()", "helpers::fmt"],
    ["super::Config::load()", "Config::load"],
    ["crate::config::load()", "config::load"],
    ["core::Engine::start()", "core::Engine::start"],
  ])("drops a Rust relative root from %s (r4501862020)", (span, symbol) => {
    expect(symbolFromSpan(span)).toBe(symbol);
  });

  it("resolves a crate-relative path against a crate-qualified graph entry", () => {
    expect(checkSymbolExistence("`crate::config::load()`", ["my_crate::config::load"]).unresolvedSymbols)
      .toEqual([]);
  });
});

describe("checkSymbolExistence — seventh review round", () => {
  const syms = (prd: string) => checkSymbolExistence(prd, []).unresolvedSymbols.map((u) => u.symbol);

  it.each([
    "> ~~~\n> `in()`\n> ~~~\n`out()`",
    "- ~~~\n  `in()`\n  ~~~\n`out()`",
    "~~~\n`in()`\n~~~\n`out()`",
  ])("fence detection is what hides the fenced span in %j (r4501863214)", (prd) => {
    expect(syms(prd)).toEqual(["out"]);
  });

  it.each([
    ["-```ts\n`a()`", ["a"]],
    ["> ```Ghost.run()``` here", ["Ghost.run"]],
    ["1234567890. ```ts\n`a()`", ["a"]],
  ])("does not read %j as a fence opener", (prd, expected) => {
    expect(syms(prd)).toEqual(expected);
  });

  it("does not close a top-level fence on a quoted or list-marker fence line (r4501863973)", () => {
    expect(syms("```md\n> ```\n- ```\n`in()`\n```\n`out()`")).toEqual(["out"]);
  });

  it("ends a heading or table-row block after its line (r4501867831)", () => {
    expect(syms("# API `stray\nCalls `Ghost.run()`.")).toEqual(["Ghost.run"]);
    expect(syms("| a `stray |\nCalls `Ghost.run()`.")).toEqual(["Ghost.run"]);
  });

  it.each([
    ["Parser::new(Cow<'a, str>)", "Parser::new"],
    ["Lexer::from(Ref<'_>)", "Lexer::from"],
    ["Lexer::push(b'(')", "Lexer::push"],
    ["Pattern.compile(r'(')", "Pattern.compile"],
    ["Foo.run('a')", "Foo.run"],
  ])("reads %s: lifetimes are text, prefixed literals are strings (r4501864237)", (span, symbol) => {
    expect(symbolFromSpan(span)).toBe(symbol);
  });
});

describe("checkSymbolExistence — eighth review round", () => {
  const syms = (prd: string) => checkSymbolExistence(prd, []).unresolvedSymbols.map((u) => u.symbol);

  it("handles a quote nested in a list item (r4501881974)", () => {
    expect(syms("- > ```ts\n  >\n  > `in()`\n  > ```\n- Calls `Ghost.run()`.")).toEqual(["Ghost.run"]);
    expect(syms("- > ```ts\n  >\n  > `in()`\n- Calls `Ghost.run()`.")).toEqual(["Ghost.run"]);
  });
});

describe("checkSymbolExistence — ninth review round", () => {
  const syms = (prd: string, graph: string[] = []) =>
    checkSymbolExistence(prd, graph).unresolvedSymbols.map((u) => u.symbol);

  it("pairs a span wrapped across consecutive quote lines (r4501882138, r4501884764)", () => {
    expect(syms("> FR-001 calls `UserService.archiveAll(\n> staleDays)` nightly.")).toEqual(["UserService.archiveAll"]);
    expect(syms("> Use `Ghost.run(a,\n> b)` here")).toEqual(["Ghost.run"]);
  });

  it("still splits where a quote starts, ends, or holds a list item", () => {
    expect(syms("Uses `Foo.run()\n> Then `Bar.go()`")).toEqual(["Bar.go"]);
    expect(syms("> Uses `Foo.run()\nThen `Bar.go()`")).toEqual(["Bar.go"]);
    expect(syms("> - Uses `Foo.run()\n> - Then `Bar.go()`")).toEqual(["Bar.go"]);
  });

  it("keeps every segment a reference can walk (r4501882470)", () => {
    const tail = ".a".repeat(98); // 199 characters with "()": 99 segments, under MAX_SPAN_LENGTH
    expect(syms(`\`R${tail}()\``, [`Q${tail}`])).toEqual([`R${tail}`]);
    expect(syms(`\`R${tail}()\``, [`P.R${tail}`])).toEqual([]);
  });

  it("counts every distinct graph entry, reachable or not", () => {
    const report = checkSymbolExistence("`Ghost.run()`", ["A.b", "C.d", "Other.run"]);
    expect(report.knownSymbols).toBe(3);
    expect(report.unresolvedSymbols).toEqual([{ symbol: "Ghost.run", occurrences: 1 }]);
  });
});

describe("checkSymbolExistence — tenth review round", () => {
  const syms = (prd: string) => checkSymbolExistence(prd, []).unresolvedSymbols.map((u) => u.symbol);

  it.each([
    ["UserService.notify('welcome back')", "UserService.notify"],
    ["EventBus.emit('order.created')", "EventBus.emit"],
    ["Config.get('db.host')", "Config.get"],
    ["Foo.run('a b')", "Foo.run"],
    ["Lexer::push(b'a')", "Lexer::push"],
    ["Pattern.compile(r'abc')", "Pattern.compile"],
    ["Parser.parse(x: Foo<'a, 'b>)", "Parser.parse"],
    ["Foo.run(f: impl Fn() + 'static)", "Foo.run"],
  ])("reads %s: a quote that can be closed is a string (r4501894817)", (span, symbol) => {
    expect(symbolFromSpan(span)).toBe(symbol);
  });

  it("still rejects a string that hides an unbalanced parenthesis", () => {
    expect(symbolFromSpan("Foo.run(')')")).toBe("Foo.run");
    // Reaches balancedParens and fails only because the string never closes.
    expect(symbolFromSpan("Foo.run(')")).toBeNull();
  });

  it.each([
    ["a quoted line inside a list-item fence", "- ```md\n  > See `in()`\n  ```\nText `out()`"],
    ["a nested list-marker fence line", "- ```md\n  - ```\n  `in()`\n  ```\n`out()`"],
    ["a deeper quote inside a quoted fence", "> ```md\n> > ```\n>\n> `in()`\n> ```\n`out()`"],
    ["a 4-space fence under a list item", "- Proposed:\n    ```ts\n\n    `in()`\n`out()`"],
  ])("keeps the fence boundaries right with %s (r4501895058)", (_name, prd) => {
    expect(syms(prd)).toEqual(["out"]);
  });

  it.each([
    ["super::super::Config::load()", "Config::load"],
    ["Self.x::y()", "x::y"],
    ["Self::CONST", null],
    ["crate::Foo", null],
    ["crate::billing::Invoice", "billing::Invoice"],
  ])("drops every Rust relative root from %s (r4501895577)", (span, symbol) => {
    expect(symbolFromSpan(span)).toBe(symbol);
  });
});

describe("checkSymbolExistence — eleventh review round", () => {
  const syms = (prd: string, graph: string[] = []) =>
    checkSymbolExistence(prd, graph).unresolvedSymbols.map((u) => u.symbol);

  it("lets a new list item end the previous item's fence and open its own (r4501911127)", () => {
    expect(syms("- ```ts\n\n  `in()`\n- ```\n\n  `in2()`\n  ```\n`out()`")).toEqual(["out"]);
  });

  it("resolves the same whether a graph entry is equal to, longer or shorter than the reference", () => {
    const graph = ["App.Billing.Invoice.total", "Invoice.tax", "Store.get"];
    expect(syms("`Billing.Invoice.total()` `Invoice.total()` `total()`", graph)).toEqual([]);
    expect(syms("`X.Invoice.tax()` `Invoice.tax()`", graph)).toEqual([]);
    expect(syms("`Store.get()` `Cache.Store.get()` `Other.get()`", graph)).toEqual(["Other.get"]);
  });

  it("keeps the owners rule when the bare entry comes before or after the qualified one", () => {
    for (const graph of [["create", "UserService.create"], ["UserService.create", "create"]]) {
      expect(syms("`PaymentGateway.create()` `App.UserService.create()` `create()`", graph))
        .toEqual(["PaymentGateway.create"]);
    }
  });
});

describe("checkSymbolExistence — twelfth review round", () => {
  const syms = (prd: string, graph: string[] = []) =>
    checkSymbolExistence(prd, graph).unresolvedSymbols.map((u) => u.symbol);

  it.each([
    ["Foo.run(&'a str, 'c')", "Foo.run"],
    ["Foo.run(&'a str, \"don't\")", "Foo.run"],
    ["Foo.run(&'a str) + Bar.go(&'b str)", null],
    ["Graph.walk(B's edges)", "Graph.walk"],
    ["Lexer.scan(rb'abc')", "Lexer.scan"],
    ["Lexer.scan(br'(')", "Lexer.scan"],
    ["Fmt.show(f'{x}')", "Fmt.show"],
    ["Text.of(u'(')", "Text.of"],
    ["Song.play(rock'n'roll)", "Song.play"],
  ])("decides a lifetime from what precedes the quote: %s (r4501919701)", (span, symbol) => {
    expect(symbolFromSpan(span)).toBe(symbol);
  });

  it.each([
    ["Repo<(User, Error)>.find", "`Repo.find()`"],
    ["Repo<() => User>.find", "`Repo.find()`"],
    ["Handler<(e: Event) => void>.dispatch", "`Handler.dispatch()`"],
    ["Repo<T>.find(id: Id<T>) -> Option<T>", "`Repo.find()`"],
  ])("finds the signature outside generic arguments in %s (r4501917318)", (entry, prd) => {
    expect(syms(prd, [entry])).toEqual([]);
  });

  it("ends a quoted paragraph on a marker-only `>` line (r4501917315)", () => {
    expect(syms("> A `stray\n>\n> Calls `Ghost.run()`.")).toEqual(["Ghost.run"]);
  });

  it.each([
    ["an unquoted closer after a quoted fence leaves the quote", "> ```ts\n>\n> `in()`\n```\n`out()`", []],
    ["a quoted closer, then a quoted line", "> ```ts\n>\n> `in()`\n> ```\n> `out()`", ["out"]],
    ["a column-0 fence after a list-item fence opens a new fence", "1. ```ts\n\n   `in()`\n```\n`hidden()`", []],
  ])("fence boundaries: %s (r4501919898, r4501920057)", (_name, prd, expected) => {
    expect(syms(prd)).toEqual(expected);
  });

  it.each(["crate::self", "super::super()", "Self::self()"])("does not read %s: roots only", (span) => {
    expect(symbolFromSpan(span)).toBeNull();
  });
});

describe("checkSymbolExistence — thirteenth review round", () => {
  const syms = (prd: string, graph: string[] = []) =>
    checkSymbolExistence(prd, graph).unresolvedSymbols.map((u) => u.symbol);

  it.each([
    ["Lexer::new(cb: fn(&'a str), src: &'a str)", "Lexer::new"],
    ["F.f(&'a T, h(&'a U))", "F.f"],
  ])("reads %s: two lifetimes around a parenthesis (r4501928454)", (span, symbol) => {
    expect(symbolFromSpan(span)).toBe(symbol);
  });

  it("applies the owners rule only at depth 1 (r4501928652)", () => {
    // `Service` is owned (by `Other.Service`, and kept because `Foo.Service`
    // ends with it), but it sits at depth 2 of `App.Service.create`.
    expect(syms("`App.Service.create()` `Foo.Service()`", ["Service.create", "Other.Service"]))
      .toEqual(["Foo.Service"]);
  });

  it("counts a 3-segment entry as an owner", () => {
    expect(syms("`PaymentGateway.create()`", ["App.UserService.create", "create"]))
      .toEqual(["PaymentGateway.create"]);
  });
});
