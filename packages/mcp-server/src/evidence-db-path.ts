/**
 * Resolve the evidence database path from the environment.
 *
 * `.mcp.json` and `manifest.json` set `PRD_GEN_EVIDENCE_DB` and PRIVACY.md
 * documents it as the override for `.prd-gen/evidence.db`, but until this
 * module nothing read it: both composition-root call sites called
 * `tryCreateEvidenceRepository()` with no path, so the repository always
 * fell back to `~/.prd-gen/evidence.db` (issue #121, audit 2026-10-10).
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

export const EVIDENCE_DB_ENV = "PRD_GEN_EVIDENCE_DB";

export function resolveEvidenceDbPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  warn: (message: string) => void = (m) => console.error(m),
): string | undefined {
  const raw = env[EVIDENCE_DB_ENV]?.trim();
  if (!raw) return undefined;
  if (raw.includes("${")) {
    warn(
      `[prd-gen] ${EVIDENCE_DB_ENV}=${raw} contains an unexpanded placeholder; using ~/.prd-gen/evidence.db instead.`,
    );
    return undefined;
  }
  if (!isAbsolute(raw)) {
    warn(
      `[prd-gen] ${EVIDENCE_DB_ENV}=${raw} is not an absolute path; using ~/.prd-gen/evidence.db instead.`,
    );
    return undefined;
  }
  return raw;
}
