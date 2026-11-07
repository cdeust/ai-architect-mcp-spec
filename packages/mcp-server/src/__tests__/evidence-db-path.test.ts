/**
 * PRD_GEN_EVIDENCE_DB is honoured (issue #121): `.mcp.json` and
 * `manifest.json` set it and PRIVACY.md documents it, but the server ignored
 * it and always wrote `~/.prd-gen/evidence.db`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { tryCreateEvidenceRepository } from "@prd-gen/core";
import { resolveEvidenceDbPath, EVIDENCE_DB_ENV } from "../evidence-db-path.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveEvidenceDbPath", () => {
  it("returns the absolute path the environment sets", () => {
    const warn = vi.fn();
    const p = join(tmpdir(), "x", "evidence.db");
    expect(resolveEvidenceDbPath({ [EVIDENCE_DB_ENV]: p }, warn)).toBe(p);
    expect(warn).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace", () => {
    const p = join(tmpdir(), "evidence.db");
    expect(resolveEvidenceDbPath({ [EVIDENCE_DB_ENV]: `  ${p}\n` }, vi.fn())).toBe(p);
  });

  it("falls back to the repository default when unset or blank, without warning", () => {
    const warn = vi.fn();
    expect(resolveEvidenceDbPath({}, warn)).toBeUndefined();
    expect(resolveEvidenceDbPath({ [EVIDENCE_DB_ENV]: "   " }, warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores a placeholder the host did not expand, and says so", () => {
    const warn = vi.fn();
    expect(
      resolveEvidenceDbPath(
        { [EVIDENCE_DB_ENV]: "${CLAUDE_PLUGIN_ROOT}/.prd-gen/evidence.db" },
        warn,
      ),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("unexpanded placeholder");
  });

  it("ignores a relative path, and says so", () => {
    const warn = vi.fn();
    expect(
      resolveEvidenceDbPath({ [EVIDENCE_DB_ENV]: ".prd-gen/evidence.db" }, warn),
    ).toBeUndefined();
    expect(warn.mock.calls[0][0]).toContain("not an absolute path");
  });
});

// Real better-sqlite3 end to end: the resolved path is where the database is
// created. Skipped when the native module is unavailable (same contract as
// packages/core evidence tests).
const probePath = join(tmpdir(), `evidence-probe-${process.pid}-${Date.now()}.db`);
const probe = tryCreateEvidenceRepository(probePath);
probe?.close();
for (const s of ["", "-wal", "-shm"]) rmSync(probePath + s, { force: true });
const sqliteAvailable = probe !== null;

describe.skipIf(!sqliteAvailable)("evidence repository at the configured path", () => {
  it("creates the database file at PRD_GEN_EVIDENCE_DB, not under ~/.prd-gen", () => {
    const dir = join(tmpdir(), `evidence-env-${process.pid}-${Date.now()}`);
    dirs.push(dir);
    const dbPath = join(dir, "nested", "evidence.db");
    const repo = tryCreateEvidenceRepository(
      resolveEvidenceDbPath({ [EVIDENCE_DB_ENV]: dbPath }, vi.fn()),
    );
    expect(repo).not.toBeNull();
    expect(existsSync(dbPath)).toBe(true);
    repo?.close();
  });
});
