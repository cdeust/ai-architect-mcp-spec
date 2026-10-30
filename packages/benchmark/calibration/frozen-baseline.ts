/**
 * Frozen-baseline reproducibility helpers (Wave D / D3.1).
 *
 * Two read-only helpers consumed by `calibrate-gates.ts`:
 *
 *   1. `computePipelineKpisContentHash` — SHA-256 of `pipeline-kpis.ts` as
 *      committed at the running tree. Recorded in the runner output JSON so
 *      a future re-run detects drift in the source-of-truth pipeline module
 *      from the calibration's frozen baseline (Popper AP-1 ratchet protection).
 *
 *   2. `resolveFrozenBaselineCommit` — returns the current `git rev-parse HEAD`
 *      so the runner records it as provenance (nothing is refused because of
 *      it). Falls back to "unknown" when not
 *      in a git tree (e.g., installed-package context).
 *
 * source: docs/PHASE_4_PLAN.md §4.5 — Frozen-baseline definition.
 *
 * Layer contract (§2.2): Node stdlib only.
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Walk upward from this module's directory looking for the canonical
 * `pipeline-kpis.ts` (source) or `pipeline-kpis.js` (dist). Both layouts
 * share the package-root anchor at `packages/benchmark/`. The walk stops
 * at the first directory that contains a `package.json` whose `name` is
 * `@prd-gen/benchmark` (the package root).
 *
 * source: D3.1 brief — runner must be invokable from both source (vitest)
 *   and dist (production CI). The two layouts differ:
 *   - source: this file is at .../packages/benchmark/calibration/frozen-baseline.ts
 *             pipeline-kpis.ts is at .../packages/benchmark/src/pipeline-kpis.ts
 *   - dist:   this file is at .../packages/benchmark/dist/calibration/calibration/frozen-baseline.js
 *             pipeline-kpis.js is at .../packages/benchmark/dist/calibration/src/pipeline-kpis.js
 */
function pipelineKpisPath(): string {
  const here = fileURLToPath(import.meta.url);
  let dir = dirname(here);
  for (let i = 0; i < 8; i++) {
    const sourceCandidate = resolve(dir, "src", "pipeline-kpis.ts");
    if (existsSync(sourceCandidate)) return sourceCandidate;
    const distCandidate = resolve(dir, "src", "pipeline-kpis.js");
    if (existsSync(distCandidate)) return distCandidate;
    // dist (post-compile) places the runner under dist/calibration/calibration/
    // and pipeline-kpis under dist/calibration/src/. Anchor at the package
    // root by checking for `tsconfig.calibration.json`.
    const anchored = resolve(dir, "tsconfig.calibration.json");
    if (existsSync(anchored)) {
      // Package root reached without finding pipeline-kpis — return the
      // source path so the caller's readFileSync raises a clear ENOENT.
      return resolve(dir, "src", "pipeline-kpis.ts");
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Last-resort: assume source layout.
  return resolve(dirname(here), "..", "src", "pipeline-kpis.ts");
}

/**
 * Compute the SHA-256 hex digest of `pipeline-kpis.ts` content.
 *
 * Precondition: the file is reachable from the runner's filesystem location.
 * Postcondition: returns a 64-char lowercase hex digest.
 * Throws Error when the file cannot be read.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 frozen-baseline content-hash assertion.
 */
export function computePipelineKpisContentHash(): string {
  const path = pipelineKpisPath();
  const content = readFileSync(path, "utf8");
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Resolve the current git HEAD commit.
 *
 * Precondition: none.
 * Postcondition: returns either a 40-char hex commit hash (in a git tree) or
 *   the literal string "unknown" (outside a git tree).
 *
 * source: docs/PHASE_4_PLAN.md §4.5 — frozen-baseline commit.
 */
export function resolveFrozenBaselineCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
