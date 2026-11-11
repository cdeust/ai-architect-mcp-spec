#!/usr/bin/env node
/**
 * calibrate.mjs — calibration harness for a cross-vendor external judge.
 *
 * Admission rule (see README.md): a judge model is only wired into the
 * self-check jury's `diversity_models` slot after it (a) reaches
 * `--min-agreement` (default 0.7) against the 10 known-ground-truth claims
 * in fixtures/ground-truth.json, AND (b) actually returns FAIL on AC-008 —
 * the deliberate contradiction discriminator. Agreement alone is not
 * sufficient: a judge that PASSes everything can hit 90% "agreement" on
 * this fixture (9/10 ground-truth claims are PASS/SPEC-COMPLETE) while
 * being structurally useless as a second opinion.
 *
 * Precondition: fixtures/ground-truth.json exists and matches the schema
 * documented in its own `provenance` field. Every claim embeds its evidence
 * inline, AC-008 included: its excerpt is the historical pre-correction PRD
 * text, and the file that text was taken from is recorded in
 * `evidence_source` as provenance only — nothing reads it at run time. See
 * `lib/prompt-builder.mjs`'s `resolveClaimEvidence` and
 * `provenance.note_on_ac008`.
 * Postcondition: prints a report (agreement rate, confusion table, AC-008
 * catch flag, per-claim latency) to stdout. Exit code 0 iff agreement rate
 * over non-skipped claims >= --min-agreement AND at least one claim ran
 * (an all-skipped run — no credentials — exits 0 with an explicit
 * "nothing to calibrate" notice, never a false pass or false fail).
 * Exit code 1 iff any claim ran AND agreement < threshold.
 *
 * Usage:
 *   node calibrate.mjs --provider gemini
 *   node calibrate.mjs --provider mistral --min-agreement 0.8
 */

import { resolveConfig } from "./lib/config.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runJudge } from "./lib/judge-core.mjs";
import { buildClaimPrompt } from "./lib/prompt-builder.mjs";
// Imported as a MODULE, not read with `readFileSync`, and the difference is
// the point. Every claim's evidence is posted to a third-party LLM endpoint,
// so a runtime read makes the corpus substitutable at run time — point the
// harness at another path and its contents leave the machine (CodeQL
// js/file-access-to-http). A static import fixes the corpus at the one
// version-controlled artifact the module graph resolves; there is no path
// variable to redirect. Node ≥20.10 supports the `with` attribute unflagged
// (verified on 20.20.2 and 22.x, the CI matrix) — no warning on stderr,
// which judge.mjs's contract depends on staying clean.
import groundTruthFixture from "./fixtures/ground-truth.json" with { type: "json" };

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

/**
 * Validate and return the statically imported ground-truth fixture.
 *
 * Takes no path: the corpus is the imported module (see the import comment),
 * so there is nothing to point elsewhere. The shape check stays — an import
 * guarantees the file parsed, not that it still holds claims.
 *
 * Postcondition: returns the fixture; throws when it carries no claims.
 */
export function loadGroundTruth() {
  if (!Array.isArray(groundTruthFixture.claims) || groundTruthFixture.claims.length === 0) {
    throw new Error("loadGroundTruth: fixtures/ground-truth.json has no claims");
  }
  return groundTruthFixture;
}

/**
 * Run the calibration sweep. Exported for testing (mocks runJudgeFn).
 *
 * @param {{claims: any[]}} groundTruth
 * @param {import("./lib/config.mjs").Config} config
 * @param {typeof runJudge} runJudgeFn
 */
export async function runCalibration(groundTruth, config, runJudgeFn) {
  const rows = [];
  for (const claim of groundTruth.claims) {
    const prompt = buildClaimPrompt(claim);
    const result = await runJudgeFn(config, prompt);
    rows.push({ claim, result });
  }
  return rows;
}

/**
 * @param {Array<{claim: any, result: any}>} rows
 */
export function summarize(rows) {
  const scored = rows.filter((r) => r.result.status === "ok");
  const skipped = rows.filter((r) => r.result.status === "skipped");
  const errored = rows.filter((r) => r.result.status === "error");

  const agreements = scored.filter((r) => r.result.verdict.verdict === r.claim.expected_verdict);
  const agreementRate = scored.length > 0 ? agreements.length / scored.length : null;

  /** @type {Record<string, Record<string, number>>} */
  const confusion = {};
  for (const { claim, result } of scored) {
    const expected = claim.expected_verdict;
    const actual = result.verdict.verdict;
    confusion[expected] = confusion[expected] || {};
    confusion[expected][actual] = (confusion[expected][actual] || 0) + 1;
  }

  const ac008Row = rows.find((r) => r.claim.claim_id === "AC-008");
  const ac008Caught =
    ac008Row?.result.status === "ok" ? ac008Row.result.verdict.verdict === "FAIL" : null;

  const latencies = scored.map((r) => r.result.latency_ms);

  return {
    total: rows.length,
    scored: scored.length,
    skipped: skipped.length,
    errored: errored.length,
    agreementRate,
    confusion,
    ac008Caught,
    latencies,
    errors: errored.map((r) => ({ claim_id: r.claim.claim_id, reason: r.result.reason })),
  };
}

function formatReport(summaryObj, threshold) {
  const lines = [];
  lines.push(`External judge calibration report`);
  lines.push(`  claims total:    ${summaryObj.total}`);
  lines.push(`  scored (ok):     ${summaryObj.scored}`);
  lines.push(`  skipped:         ${summaryObj.skipped}`);
  lines.push(`  errored:         ${summaryObj.errored}`);
  lines.push(
    `  agreement rate:  ${summaryObj.agreementRate === null ? "N/A (no scored claims)" : (summaryObj.agreementRate * 100).toFixed(1) + "%"} (threshold ${(threshold * 100).toFixed(0)}%)`,
  );
  lines.push(
    `  AC-008 caught:   ${summaryObj.ac008Caught === null ? "N/A (skipped/errored)" : summaryObj.ac008Caught ? "YES (FAIL)" : "no — did not return FAIL"}`,
  );
  if (summaryObj.latencies.length) {
    const avg = summaryObj.latencies.reduce((a, b) => a + b, 0) / summaryObj.latencies.length;
    lines.push(`  avg latency:     ${avg.toFixed(0)}ms (n=${summaryObj.latencies.length})`);
  }
  lines.push(`  confusion table (expected -> {actual: count}):`);
  for (const [expected, actuals] of Object.entries(summaryObj.confusion)) {
    lines.push(`    ${expected}: ${JSON.stringify(actuals)}`);
  }
  if (summaryObj.errors.length) {
    lines.push(`  errors:`);
    for (const e of summaryObj.errors) lines.push(`    ${e.claim_id}: ${e.reason}`);
  }
  return lines.join("\n");
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const threshold = Number(flags.minAgreement ?? 0.7);
  const config = resolveConfig(flags, process.env);

  const groundTruth = loadGroundTruth();
  const rows = await runCalibration(groundTruth, config, runJudge);
  const summaryObj = summarize(rows);

  process.stdout.write(formatReport(summaryObj, threshold) + "\n");

  if (summaryObj.scored === 0) {
    process.stdout.write(
      `\nNothing to calibrate — all ${summaryObj.total} claims skipped (no credentials for provider "${config.provider}"). Exiting 0.\n`,
    );
    process.exit(0);
  }

  const admitted = summaryObj.agreementRate !== null && summaryObj.agreementRate >= threshold;
  process.stdout.write(
    `\nAdmission gate: ${admitted ? "PASS" : "FAIL"} (agreement ${summaryObj.agreementRate === null ? "N/A" : (summaryObj.agreementRate * 100).toFixed(1) + "%"} vs threshold ${(threshold * 100).toFixed(0)}%)\n`,
  );
  process.exit(admitted ? 0 : 1);
}

// Only run main() when invoked directly (not when imported by tests).
// Compare real paths, not URLs: `file://${argv[1]}` never equals the module
// URL on Windows (`file:///C:/…`) or for a path with a space (`%20`), and
// Node resolves symlinks in import.meta.url but not in argv[1] (macOS tmpdir
// is under /var -> /private/var). Either way the script exited 0 without
// doing anything (#126). Same check as isEntry() in bin/ensure-deps.mjs.
function isEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().catch((err) => {
    process.stderr.write(`calibrate.mjs: unexpected failure: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(2);
  });
}
