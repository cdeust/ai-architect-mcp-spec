/**
 * PRD_GEN_EVIDENCE_DB is honoured (issue #121): `.mcp.json` and
 * `manifest.json` set it and PRIVACY.md documents it, but the server ignored
 * it and always wrote `~/.prd-gen/evidence.db`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
  it("reports on stderr, not stdout, an explicit path it cannot open", () => {
    const dir = join(tmpdir(), `evidence-blocked-${process.pid}-${Date.now()}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const blocker = join(dir, "file");
    writeFileSync(blocker, "");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // The parent "directory" is a regular file: mkdirSync throws.
      expect(tryCreateEvidenceRepository(join(blocker, "evidence.db"))).toBeNull();
      expect(err).toHaveBeenCalledOnce();
      expect(String(err.mock.calls[0][0])).toContain("evidence storage is off");
      expect(log).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });

  it("the default warn of the resolver writes to stderr, not stdout", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      resolveEvidenceDbPath({ [EVIDENCE_DB_ENV]: "relative.db" });
      expect(err).toHaveBeenCalledOnce();
      expect(log).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });

  it("creates the database file at PRD_GEN_EVIDENCE_DB, not under ~/.prd-gen", () => {
    const dir = join(tmpdir(), `evidence-env-${process.pid}-${Date.now()}`);
    dirs.push(dir);
    const dbPath = join(dir, "nested", "evidence.db");
    const repo = tryCreateEvidenceRepository(
      resolveEvidenceDbPath({ [EVIDENCE_DB_ENV]: dbPath }, vi.fn()),
    );
    try {
      expect(repo).not.toBeNull();
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      repo?.close();
    }
  });
});

// ─── Production wiring ───────────────────────────────────────────────────────
//
// The tests above exercise the resolver and the repository, not the call
// sites. These two pin the wiring: reverting either composition root to its
// own `tryCreateEvidenceRepository()` call must fail a test.

const SRC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SERVER_ENTRY = join(SRC_DIR, "..", "dist", "index.js");

describe("evidence repository wiring", () => {
  it("only evidence-db-path.ts opens the evidence repository", () => {
    const offenders = readdirSync(SRC_DIR)
      .filter((f) => f.endsWith(".ts") && f !== "evidence-db-path.ts")
      .filter((f) =>
        readFileSync(join(SRC_DIR, f), "utf-8").includes("tryCreateEvidenceRepository"),
      );
    // index.ts and pipeline-tools.ts must go through getEvidenceRepo(), which
    // resolves PRD_GEN_EVIDENCE_DB; a direct call would bypass it.
    expect(offenders).toEqual([]);
  });

  // Real server over stdio (the built entry point, as `pnpm build && pnpm
  // test` runs in CI): a tool backed by the evidence repository creates the
  // database at PRD_GEN_EVIDENCE_DB.
  it.skipIf(!sqliteAvailable)(
    "the running server creates the database at PRD_GEN_EVIDENCE_DB",
    async () => {
      expect(existsSync(SERVER_ENTRY), `build first: ${SERVER_ENTRY}`).toBe(true);
      const dir = join(tmpdir(), `evidence-stdio-${process.pid}-${Date.now()}`);
      dirs.push(dir);
      const dbPath = join(dir, "evidence.db");
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      env[EVIDENCE_DB_ENV] = dbPath;
      const client = new Client({ name: "evidence-db-path-test", version: "0" });
      await client.connect(
        new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], env, stderr: "ignore" }),
      );
      try {
        const res = await client.callTool({ name: "get_quality_history", arguments: {} });
        expect(res.isError).toBeFalsy();
      } finally {
        await client.close();
      }
      expect(existsSync(dbPath)).toBe(true);
    },
    30_000,
  );
});
