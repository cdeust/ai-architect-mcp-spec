/**
 * PRD_GEN_EVIDENCE_DB is honoured as a user override (issue #121):
 * PRIVACY.md documents it, but the server ignored it and always wrote
 * `~/.prd-gen/evidence.db`. The shipped configs do not set it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// Private temp directories (mkdtempSync, mode 0700) throughout: no file is
// created at a predictable name in the shared OS temp dir.
const probeDir = mkdtempSync(join(tmpdir(), "evidence-probe-"));
const probe = tryCreateEvidenceRepository(join(probeDir, "evidence.db"));
probe?.close();
rmSync(probeDir, { recursive: true, force: true });
const sqliteAvailable = probe !== null;

describe.skipIf(!sqliteAvailable)("evidence repository at the configured path", () => {
  it("reports on stderr, not stdout, an explicit path it cannot open", () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-blocked-"));
    dirs.push(dir);
    const blocker = join(dir, "file");
    writeFileSync(blocker, "");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // The parent is a regular file, not a directory: opening the database fails.
      expect(tryCreateEvidenceRepository(join(blocker, "evidence.db"))).toBeNull();
      expect(err).toHaveBeenCalledOnce();
      expect(String(err.mock.calls[0][0])).toContain("evidence storage is off");
      expect(log).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "reports a default-path failure on stderr too (the tools say \"see stderr\")",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "evidence-home-"));
      dirs.push(dir);
      const homeFile = join(dir, "home");
      writeFileSync(homeFile, ""); // HOME is a regular file: ~/.prd-gen cannot exist
      const savedHome = process.env.HOME;
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        process.env.HOME = homeFile;
        // Guard: under a thread pool homedir() may not see the new HOME, and
        // the call below would then open the real ~/.prd-gen.
        expect(homedir()).toBe(homeFile);
        expect(tryCreateEvidenceRepository()).toBeNull();
        expect(err).toHaveBeenCalledOnce();
        expect(String(err.mock.calls[0][0])).toContain(join(homeFile, ".prd-gen", "evidence.db"));
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
        err.mockRestore();
      }
    },
  );

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
    const dir = mkdtempSync(join(tmpdir(), "evidence-env-"));
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
// sites. These pin the wiring: reverting either composition root to its
// own repository (factory or `new EvidenceRepository`) must fail a test.

const SRC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SERVER_ENTRY = join(SRC_DIR, "..", "dist", "index.js");

describe("evidence repository wiring", () => {
  it("only evidence-db-path.ts opens the evidence repository", () => {
    // Either way of opening the repository bypasses PRD_GEN_EVIDENCE_DB if it
    // is not getEvidenceRepo(): the factory, or the class it wraps.
    const opener = /tryCreateEvidenceRepository|new\s+EvidenceRepository\s*\(/;
    const offenders = (readdirSync(SRC_DIR, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && !f.includes("__tests__"))
      .filter((f) => f !== "evidence-db-path.ts")
      .filter((f) => opener.test(readFileSync(join(SRC_DIR, f), "utf-8")));
    expect(offenders).toEqual([]);
  });

  it("both composition roots take the repository from getEvidenceRepo()", () => {
    // Exact call counts: one remaining call must not hide a removed one
    // (index.ts: check_health, get_quality_history, get_strategy_effectiveness;
    // pipeline-tools.ts: eviction prune, strategy-execution tracker).
    const expected: Record<string, number> = { "index.ts": 3, "pipeline-tools.ts": 2 };
    for (const f of Object.keys(expected)) {
      // Comments stripped first: a comment naming getEvidenceRepo() must not
      // satisfy this (review r4502015550).
      const code = readFileSync(join(SRC_DIR, f), "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code.match(/getEvidenceRepo\(\)/g)?.length ?? 0, f).toBe(expected[f]);
    }
  });

  // Real server over stdio (the built entry point, as `pnpm build && pnpm
  // test` runs in CI): a tool backed by the evidence repository creates the
  // database at PRD_GEN_EVIDENCE_DB.
  it.skipIf(!sqliteAvailable)(
    "the running server creates the database at PRD_GEN_EVIDENCE_DB",
    async () => {
      expect(existsSync(SERVER_ENTRY), `build first: ${SERVER_ENTRY}`).toBe(true);
      const dir = mkdtempSync(join(tmpdir(), "evidence-stdio-"));
      dirs.push(dir);
      const dbPath = join(dir, "evidence.db");
      // Isolated from the developer's environment: HOME points at the temp
      // dir (so a regression that ignores the variable writes there, not to
      // the real ~/.prd-gen), and the tool profile is forced to full (an
      // inherited PRD_GEN_PROFILE=agent would hide get_quality_history).
      const fakeHome = join(dir, "home");
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      delete env.PRD_GEN_PROFILE;
      env.HOME = fakeHome;
      env.USERPROFILE = fakeHome;
      env[EVIDENCE_DB_ENV] = dbPath;
      const client = new Client({ name: "evidence-db-path-test", version: "0" });
      await client.connect(
        new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY, "--profile", "full"], env, stderr: "ignore" }),
      );
      try {
        const res = await client.callTool({ name: "get_quality_history", arguments: {} });
        expect(res.isError).toBeFalsy();
      } finally {
        await client.close();
      }
      expect(existsSync(dbPath)).toBe(true);
      expect(existsSync(join(fakeHome, ".prd-gen", "evidence.db"))).toBe(false);
    },
    30_000,
  );
});
