/**
 * Tests for codeOracle (E2.C).
 *
 * Contract under test:
 *   - truth = (tsc exits 0 === expected_compiles)
 *   - oracle_evidence is always non-empty
 *
 * Hermetic-test contract (Wave-C no-skip rule):
 *   Tests do NOT skip when tsc is unavailable. When tsc is absent:
 *     - isTscAvailable() returns false
 *     - codeOracle() returns stub result with truth=false and a stub-mode evidence string
 *     - Tests check for the stub-mode behaviour so CI always gets a verdict
 *   When tsc is present:
 *     - Tests check for real compilation verdicts
 *
 * Stakes: Medium — calibration infrastructure.
 */

import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { codeOracle, isTscAvailable, tscCandidates } from "../code-oracle.js";
import { OracleUnavailableError } from "../oracle-errors.js";

// Real-tsc subprocess tests measure 0.3–3.9s solo (2026-07-22, darwin arm64);
// under full-suite parallel load they exceeded vitest's 5000ms default and
// failed as timeouts, not as code failures. 30s keeps the same order of
// magnitude of headroom CI enjoys without masking a hung compiler.
vi.setConfig({ testTimeout: 30_000 });

const SIMPLE_VALID_SNIPPET = `
const x: number = 42;
const greeting: string = "hello";
export { x, greeting };
`;

const TYPE_ERROR_SNIPPET = `
const x: number = "this is not a number";
export { x };
`;

const INTERFACE_SNIPPET = `
interface User {
  id: number;
  name: string;
}
const u: User = { id: 1, name: "Alice" };
export { u };
`;

describe("codeOracle", () => {
  it("oracle_evidence is non-empty when tsc is available", async () => {
    // B3: when tsc is absent codeOracle throws OracleUnavailableError; this test
    // only verifies the non-empty evidence invariant for the real-tsc path.
    if (!isTscAvailable()) return;

    const result = await codeOracle({
      snippet: SIMPLE_VALID_SNIPPET,
      expected_compiles: true,
    });

    expect(result.oracle_evidence).toBeTruthy();
    expect(result.oracle_evidence.length).toBeGreaterThan(0);
  });

  it("when tsc unavailable: throws OracleUnavailableError (B3)", async () => {
    // B3 remediation: stub mode no longer returns truth=false. It throws so callers
    // can exclude the claim from the calibrated arm instead of corrupting labels.
    // source: Popper AP-4, Wave E.
    if (isTscAvailable()) return;

    await expect(
      codeOracle({ snippet: SIMPLE_VALID_SNIPPET, expected_compiles: true }),
    ).rejects.toThrow(OracleUnavailableError);

    await expect(
      codeOracle({ snippet: SIMPLE_VALID_SNIPPET, expected_compiles: true }),
    ).rejects.toThrow(/OracleUnavailableError\[code\]/);
  });

  it("OracleUnavailableError carries oracleType='code'", async () => {
    if (isTscAvailable()) return;

    try {
      await codeOracle({ snippet: SIMPLE_VALID_SNIPPET, expected_compiles: true });
      throw new Error("expected OracleUnavailableError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OracleUnavailableError);
      expect((err as OracleUnavailableError).oracleType).toBe("code");
    }
  });

  it("valid snippet + claim compiles → truth=true (real tsc)", async () => {
    if (!isTscAvailable()) return;

    const result = await codeOracle({
      snippet: SIMPLE_VALID_SNIPPET,
      expected_compiles: true,
    });

    expect(result.truth).toBe(true);
    expect(result.oracle_evidence).toContain("compiles_cleanly=true");
    expect(result.oracle_evidence).toContain("truth=true");
  });

  it("type-error snippet + claim compiles → truth=false (real tsc)", async () => {
    if (!isTscAvailable()) return;

    const result = await codeOracle({
      snippet: TYPE_ERROR_SNIPPET,
      expected_compiles: true,
    });

    expect(result.truth).toBe(false);
    expect(result.oracle_evidence).toContain("compiles_cleanly=false");
    expect(result.oracle_evidence).toContain("truth=false");
  });

  it("type-error snippet + claim does not compile → truth=true (real tsc)", async () => {
    if (!isTscAvailable()) return;

    const result = await codeOracle({
      snippet: TYPE_ERROR_SNIPPET,
      expected_compiles: false,
    });

    expect(result.truth).toBe(true);
    expect(result.oracle_evidence).toContain("compiles_cleanly=false");
    expect(result.oracle_evidence).toContain("expected_compiles=false");
    expect(result.oracle_evidence).toContain("truth=true");
  });

  it("valid interface snippet + claim compiles → truth=true (real tsc)", async () => {
    if (!isTscAvailable()) return;

    const result = await codeOracle({
      snippet: INTERFACE_SNIPPET,
      expected_compiles: true,
    });

    expect(result.truth).toBe(true);
    expect(result.oracle_evidence).toContain("truth=true");
  });

  it("evidence includes tsc version when tsc is available", async () => {
    if (!isTscAvailable()) return;

    const result = await codeOracle({
      snippet: SIMPLE_VALID_SNIPPET,
      expected_compiles: true,
    });

    expect(result.oracle_evidence).toMatch(/tsc="Version \d+\.\d+/);
  });
});

// #126: tsc was looked up as `node_modules/.bin/tsc` (a shell script; `tsc.cmd`
// on Windows, which node does not spawn without a shell), through
// `URL.pathname` (`/C:/…` on Windows). Every test above that needs tsc then
// returned early there, and every code claim was unverifiable.
describe("tsc lookup needs no shell shim", () => {
  it("runs the typescript package's own entry with this node", () => {
    const [first, ...rest] = tscCandidates();
    expect(first.command).toBe(process.execPath);
    expect(first.prefixArgs).toHaveLength(1);
    expect(first.prefixArgs[0]).toMatch(/typescript[\\/]bin[\\/]tsc$/);
    expect(first.prefixArgs[0]).not.toMatch(/\.bin/);
    expect(existsSync(first.prefixArgs[0])).toBe(true);
    expect(rest).toEqual([{ command: "tsc", prefixArgs: [] }]);
  });

  it("falls back to tsc on PATH when typescript cannot be resolved", () => {
    const candidates = tscCandidates(() => {
      throw new Error("Cannot find module 'typescript/package.json'");
    });
    expect(candidates).toEqual([{ command: "tsc", prefixArgs: [] }]);
  });

  it("finds tsc in this workspace, so the real-tsc tests above cannot pass by returning early", () => {
    expect(isTscAvailable()).toBe(true);
  });
});
