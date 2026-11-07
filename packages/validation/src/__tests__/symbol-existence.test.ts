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
