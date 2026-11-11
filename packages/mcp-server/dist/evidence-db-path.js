/**
 * Resolve the evidence database path from the environment.
 *
 * `PRD_GEN_EVIDENCE_DB` is a user override documented in PRIVACY.md. Until
 * this module nothing read it: both composition-root call sites called
 * `tryCreateEvidenceRepository()` with no path (issue #121, audit
 * 2026-10-10). The shipped `.mcp.json` and `manifest.json` deliberately do
 * not set it, so the database stays at `~/.prd-gen/evidence.db` (beside
 * `reliability.db`) instead of the install directory an update replaces.
 *
 * The composition root reads the environment, not `@prd-gen/core`: the
 * repository keeps taking an explicit path, and its own `~/.prd-gen`
 * default stays the fallback.
 *
 * precondition:  none.
 * postcondition: returns the trimmed `PRD_GEN_EVIDENCE_DB` value when it is
 *   a usable absolute path; returns `undefined` (repository default) when it
 *   is unset or blank; for a value the host left unexpanded (contains `${`,
 *   e.g. `${CLAUDE_PLUGIN_ROOT}/...`) or a relative path, returns `undefined`
 *   and reports the ignored value through `warn`, so the database is never
 *   created under a literal `${...}` directory or relative to whatever the
 *   server's working directory happens to be.
 */
import { isAbsolute } from "node:path";
import { tryCreateEvidenceRepository } from "@prd-gen/core";
export const EVIDENCE_DB_ENV = "PRD_GEN_EVIDENCE_DB";
export function resolveEvidenceDbPath(env = process.env, warn = (m) => console.error(m)) {
    const raw = env[EVIDENCE_DB_ENV]?.trim();
    if (!raw)
        return undefined;
    if (raw.includes("${")) {
        warn(`[prd-gen] ${EVIDENCE_DB_ENV}=${raw} contains an unexpanded placeholder; using ~/.prd-gen/evidence.db instead.`);
        return undefined;
    }
    if (!isAbsolute(raw)) {
        warn(`[prd-gen] ${EVIDENCE_DB_ENV}=${raw} is not an absolute path; using ~/.prd-gen/evidence.db instead.`);
        return undefined;
    }
    return raw;
}
let _evidenceRepo = undefined;
/**
 * The server's single evidence repository, opened lazily at the path
 * `resolveEvidenceDbPath()` gives. `index.ts` (check_health, quality-history
 * and strategy-effectiveness tools) and `pipeline-tools.ts` (strategy-execution
 * drain, run-eviction cleanup) both use this handle, so they share one
 * SQLite connection to one file instead of each opening its own with its
 * own path resolution.
 *
 * precondition:  none.
 * postcondition: returns the same instance on every call; `null` when
 *   better-sqlite3 is unavailable or the database cannot be opened.
 */
export function getEvidenceRepo() {
    if (_evidenceRepo === undefined) {
        _evidenceRepo = tryCreateEvidenceRepository(resolveEvidenceDbPath());
    }
    return _evidenceRepo;
}
//# sourceMappingURL=evidence-db-path.js.map