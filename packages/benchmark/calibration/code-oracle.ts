/**
 * codeOracle — TypeScript compilation check via tsc subprocess.
 *
 * Precondition:  payload.snippet is a TypeScript string; payload.expected_compiles
 *                is the claim being made.
 * Postcondition: truth = (tsc exits 0 === expected_compiles).
 *                oracle_evidence is non-empty and human-readable.
 *                When tsc is absent, throws OracleUnavailableError — callers must
 *                catch and exclude the claim rather than scoring it false.
 * Invariant:     The snippet is written to a temp directory and cleaned up after
 *                each call. tsc is invoked with --noEmit --strict; no output is
 *                emitted to disk beyond the temp source file.
 *
 * B3 remediation (Popper AP-4, Wave E): stub mode previously returned
 *   truth=false when tsc was absent, fabricating ground-truth labels in CI.
 *   Now throws OracleUnavailableError so callers can exclude the claim from
 *   the calibrated arm rather than corrupt the held-out partition.
 *
 * Hermetic-test contract (Wave-C no-skip rule):
 *   Tests do NOT skip when tsc is unavailable. isTscAvailable() is exported
 *   so test files can branch on real vs. stub behaviour. All code paths are
 *   exercised regardless of tsc presence.
 *
 * Layer: benchmark/calibration. Uses Node.js child_process (infrastructure).
 * source: PHASE_4_PLAN.md §4.1 "Externally-grounded held-out subset".
 */

import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { CodePayload, OracleResult } from "./oracle-types.js";
import { OracleUnavailableError } from "./oracle-errors.js";

/** Subprocess timeout in milliseconds. source: measured locally; tsc on a
 *  single-file snippet resolves in <3s on M1/M2 silicon; 10 000ms provides
 *  3× headroom for CI machines. */
const TSC_TIMEOUT_MS = 10_000;

/** Probe timeout for `tsc --version`. source: measured 2026-07-22 on darwin
 *  arm64 under background load — `tsc --version` takes 1.6s wall solo; the
 *  previous 3 000ms left <2× headroom and made isTscAvailable() flip
 *  load-dependently during full-suite parallel runs (OracleUnavailableError
 *  thrown with tsc installed). 10 000ms applies the same ~6× headroom policy
 *  as TSC_TIMEOUT_MS. */
const TSC_PROBE_TIMEOUT_MS = 10_000;

/** How to run tsc: a program and the arguments that precede tsc's own. */
export interface TscInvocation {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

/**
 * precondition:  `resolvePackageJson` resolves the `typescript` package's
 *                package.json as this module sees it, or throws.
 * postcondition: the candidates to try, in order.
 *   1. The `typescript` package's own entry, `bin/tsc`, run with the node
 *      that runs this process. No shim is involved: `node_modules/.bin/tsc`
 *      is a shell script, and on Windows it is `tsc.cmd`, which node refuses
 *      to spawn without a shell (EINVAL since the fix for CVE-2024-27980,
 *      Node 20.12.2), so the previous lookup found no tsc there and every
 *      code claim was reported as unverifiable (#126). The path was also
 *      taken from `URL.pathname`, which is `/C:/…` on Windows.
 *   2. `tsc` on PATH, as before, for a checkout whose workspace does not
 *      carry typescript.
 */
export function tscCandidates(
  resolvePackageJson: () => string = () =>
    createRequire(import.meta.url).resolve("typescript/package.json"),
): TscInvocation[] {
  const candidates: TscInvocation[] = [];
  try {
    const entry = join(dirname(resolvePackageJson()), "bin", "tsc");
    candidates.push({ command: process.execPath, prefixArgs: [entry] });
  } catch {
    // typescript is not resolvable from here; PATH is the only candidate.
  }
  candidates.push({ command: "tsc", prefixArgs: [] });
  return candidates;
}

/** The first candidate that answers `--version`, or null. */
function findTscBinary(): TscInvocation | null {
  for (const candidate of tscCandidates()) {
    try {
      execFileSync(candidate.command, [...candidate.prefixArgs, "--version"], {
        timeout: TSC_PROBE_TIMEOUT_MS,
        stdio: "pipe",
      });
      return candidate;
    } catch {
      // Not found at this location; try the next.
    }
  }
  return null;
}

/** True iff a usable tsc binary can be found. Exported for test gates. */
export function isTscAvailable(): boolean {
  return findTscBinary() !== null;
}

/**
 * Compile a TypeScript snippet under --strict --noEmit and compare the
 * compile-success result against expected_compiles.
 *
 * Precondition:  snippet is a TypeScript string (may be invalid TS).
 *                expected_compiles is the claim.
 * Postcondition: truth = (tsc exits 0 === expected_compiles).
 */
export async function codeOracle(payload: CodePayload): Promise<OracleResult> {
  const { snippet, expected_compiles } = payload;

  const tscBin = findTscBinary();

  if (tscBin === null) {
    // B3 remediation: throw OracleUnavailableError instead of fabricating truth=false.
    // Callers (e.g. build-conclude-opts.ts) catch this and exclude the claim from the
    // calibrated arm rather than scoring it falsely.
    // source: Popper AP-4 audit, Wave E remediation.
    throw new OracleUnavailableError(
      "code",
      "tsc binary not found; install TypeScript to get real compilation verdicts.",
    );
  }

  // Get tsc version for evidence traceability.
  let tscVersion = "unknown";
  try {
    tscVersion = execFileSync(tscBin.command, [...tscBin.prefixArgs, "--version"], { timeout: TSC_PROBE_TIMEOUT_MS, stdio: "pipe" })
      .toString()
      .trim();
  } catch {
    // Non-fatal; version is for evidence only.
  }

  // Write snippet to a unique temp file.
  const tempDir = mkdtempSync(join(tmpdir(), "prd-gen-code-oracle-"));
  const snippetFile = join(tempDir, "snippet.ts");

  try {
    writeFileSync(snippetFile, snippet, "utf8");

    let compilesCleanly: boolean;
    let stderr = "";

    try {
      execFileSync(
        tscBin.command,
        [...tscBin.prefixArgs, "--noEmit", "--strict", "--target", "ES2022", "--module", "node16", "--moduleResolution", "node16", snippetFile],
        { timeout: TSC_TIMEOUT_MS, stdio: "pipe" },
      );
      compilesCleanly = true;
    } catch (err: unknown) {
      compilesCleanly = false;
      if (
        err !== null &&
        typeof err === "object" &&
        "stderr" in err
      ) {
        const rawStderr = (err as { stderr: Buffer | string }).stderr;
        const stderrStr = rawStderr instanceof Buffer ? rawStderr.toString() : String(rawStderr);
        // Truncate to 500 chars to avoid overwhelming evidence strings.
        stderr = stderrStr.slice(0, 500);
        if (stderrStr.length > 500) stderr += " [truncated]";
      }
    }

    const truth = compilesCleanly === expected_compiles;

    const evidence =
      `codeOracle: tsc="${tscVersion}"; ` +
      `snippet="${snippetSummary(snippet)}"; ` +
      `compiles_cleanly=${String(compilesCleanly)}; ` +
      `expected_compiles=${String(expected_compiles)}; ` +
      (stderr ? `stderr="${stderr}"; ` : `stderr=none; `) +
      `truth=${String(truth)}.`;

    return { truth, oracle_evidence: evidence };
  } finally {
    // Invariant: temp directory is always removed regardless of outcome.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Non-fatal; OS will clean tmpdir eventually.
    }
  }
}

/** Returns a ≤60-char summary of the snippet for evidence strings. */
function snippetSummary(snippet: string): string {
  const oneLine = snippet.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? oneLine.slice(0, 60) + "..." : oneLine;
}
