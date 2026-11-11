import { type EvidenceRepository } from "@prd-gen/core";
export declare const EVIDENCE_DB_ENV = "PRD_GEN_EVIDENCE_DB";
export declare function resolveEvidenceDbPath(env?: Readonly<Record<string, string | undefined>>, warn?: (message: string) => void): string | undefined;
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
export declare function getEvidenceRepo(): EvidenceRepository | null;
//# sourceMappingURL=evidence-db-path.d.ts.map