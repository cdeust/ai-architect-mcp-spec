/**
 * The audit flags of a quality score can be absent (#121).
 *
 * The pipeline records a quality score when its self-check concludes, and it
 * runs no audit-flag pass: the score carries `null`, not 0, which would say
 * that a pass ran and raised nothing. A database created before #121
 * declares the column NOT NULL DEFAULT 0 and is rebuilt once.
 *
 * Real better-sqlite3 against temp files; skipped if the native module is
 * unavailable (same contract as evidence-learning.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tryCreateEvidenceRepository, type PRDQualityScore } from "../index.js";
import { makeAuditFlagsNullable } from "../persistence/quality-score-migration.js";

// The other server waits up to 10 s for this one, and this one up to 10 s for
// it; better-sqlite3's busy timeout is 5 s. The default of vitest, 5 s, would
// end the test before either gave its own reason.
const TWO_PROCESS_TIMEOUT_MS = 30_000;

interface RawDatabase {
  exec(sql: string): void;
  pragma(source: string): unknown;
  prepare(sql: string): { all(): unknown[] };
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T & { immediate: T };
  close(): void;
}
type RawConstructor = new (path: string) => RawDatabase;

let Raw: RawConstructor | null = null;
try {
  Raw = (await import("better-sqlite3")).default as unknown as RawConstructor;
} catch {
  Raw = null;
}

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "evidence-nullable-"));
  dirs.push(dir);
  return join(dir, "evidence.db");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const score = (o: Partial<PRDQualityScore> = {}): PRDQualityScore => ({
  prdId: "run_a",
  prdContext: "feature",
  rulesChecked: 12,
  rulesPassed: 9,
  criticalViolations: 1,
  totalScore: 0.75,
  auditFlagsRaised: null,
  ...o,
});

/** The schema of `prd_quality_scores` as it was before #121. */
const OLD_SCHEMA = `
  CREATE TABLE prd_quality_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prd_id TEXT NOT NULL,
    prd_context TEXT NOT NULL,
    rules_checked INTEGER NOT NULL,
    rules_passed INTEGER NOT NULL,
    critical_violations INTEGER NOT NULL,
    total_score REAL NOT NULL,
    audit_flags_raised INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_prd_quality_scores_context ON prd_quality_scores(prd_context);
  CREATE INDEX idx_prd_quality_scores_prd_id ON prd_quality_scores(prd_id);
`;

function notNullOf(db: RawDatabase, column: string): number {
  const columns = db.pragma("table_info(prd_quality_scores)") as Array<{ name: string; notnull: number }>;
  return columns.find((c) => c.name === column)!.notnull;
}

/**
 * Another server opening the same database: it takes the write lock, says
 * so by creating argv[3], waits until argv[5] exists, rebuilds the table as
 * makeAuditFlagsNullable does, commits, and writes the schema version it
 * leaves to argv[4]. argv[1] is the better-sqlite3 module, argv[2] the
 * database. It gives up after 10 s without argv[5].
 */
const OTHER_SERVER = `
  const fs = require("node:fs");
  const [modulePath, dbPath, holding, versionFile, go] = process.argv.slice(1);
  const db = new (require(modulePath))(dbPath);
  db.exec("BEGIN IMMEDIATE");
  fs.writeFileSync(holding, "");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; !fs.existsSync(go); waited += 10) {
    if (waited >= 10000) process.exit(3);
    Atomics.wait(pause, 0, 0, 10);
  }
  db.exec(\`
    CREATE TABLE prd_quality_scores_nullable (
      id INTEGER PRIMARY KEY AUTOINCREMENT, prd_id TEXT NOT NULL, prd_context TEXT NOT NULL,
      rules_checked INTEGER NOT NULL, rules_passed INTEGER NOT NULL, critical_violations INTEGER NOT NULL,
      total_score REAL NOT NULL, audit_flags_raised INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO prd_quality_scores_nullable SELECT * FROM prd_quality_scores;
    DROP TABLE prd_quality_scores;
    ALTER TABLE prd_quality_scores_nullable RENAME TO prd_quality_scores;
    CREATE INDEX idx_prd_quality_scores_context ON prd_quality_scores(prd_context);
    CREATE INDEX idx_prd_quality_scores_prd_id ON prd_quality_scores(prd_id);
    COMMIT;
  \`);
  fs.writeFileSync(versionFile, String(db.pragma("schema_version", { simple: true })));
  db.close();
`;

function schemaVersionOf(path: string): number {
  const db = new Raw!(path);
  const rows = db.pragma("schema_version") as Array<{ schema_version: number }>;
  db.close();
  return rows[0]!.schema_version;
}

describe.skipIf(Raw === null)("quality scores without audit flags (#121)", () => {
  it("records and returns a score whose audit flags are absent", () => {
    const repo = tryCreateEvidenceRepository(tempDb())!;
    repo.recordQualityScore(score());
    repo.recordQualityScore(score({ prdId: "run_b", auditFlagsRaised: 4 }));
    const history = repo.getQualityHistory(10);
    repo.close();
    expect(history).toHaveLength(2);
    expect(history.find((h) => h.prdId === "run_a")).toEqual(score());
    expect(history.find((h) => h.prdId === "run_b")!.auditFlagsRaised).toBe(4);
  });

  it("rebuilds a database of the previous schema, keeping its rows and its indexes", () => {
    const path = tempDb();
    const before = new Raw!(path);
    before.exec(OLD_SCHEMA);
    before.exec(`
      INSERT INTO prd_quality_scores
        (prd_id, prd_context, rules_checked, rules_passed, critical_violations, total_score, audit_flags_raised, created_at)
      VALUES ('run_old', 'bug', 7, 5, 0, 0.5, 2, '2026-01-02 03:04:05');
    `);
    expect(notNullOf(before, "audit_flags_raised")).toBe(1);
    before.close();

    const repo = tryCreateEvidenceRepository(path)!;
    // The previous schema refused this insert: NOT NULL constraint failed.
    repo.recordQualityScore(score());
    const history = repo.getQualityHistory(10);
    repo.close();

    expect(history.find((h) => h.prdId === "run_old")).toEqual({
      prdId: "run_old",
      prdContext: "bug",
      rulesChecked: 7,
      rulesPassed: 5,
      criticalViolations: 0,
      totalScore: 0.5,
      auditFlagsRaised: 2,
    });
    expect(history.find((h) => h.prdId === "run_a")!.auditFlagsRaised).toBeNull();

    const after = new Raw!(path);
    expect(notNullOf(after, "audit_flags_raised")).toBe(0);
    // The columns that were NOT NULL and have a value in every score stay so.
    expect(notNullOf(after, "total_score")).toBe(1);
    const indexes = (after.pragma("index_list(prd_quality_scores)") as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toEqual(
      expect.arrayContaining(["idx_prd_quality_scores_context", "idx_prd_quality_scores_prd_id"]),
    );
    const kept = after.pragma("table_info(prd_quality_scores)") as Array<{ name: string }>;
    expect(kept.map((c) => c.name)).toEqual([
      "id", "prd_id", "prd_context", "rules_checked", "rules_passed",
      "critical_violations", "total_score", "audit_flags_raised", "created_at",
    ]);
    after.close();
  });

  it("leaves the database as it was, and writable, when the rebuild fails", () => {
    const path = tempDb();
    const before = new Raw!(path);
    before.exec(OLD_SCHEMA);
    // A table this schema does not have, to make the rebuild fail after its
    // first statements: the repository opens with foreign_keys ON, so
    // dropping the old table, which a note refers to, is refused.
    before.exec(`
      INSERT INTO prd_quality_scores
        (prd_id, prd_context, rules_checked, rules_passed, critical_violations, total_score, audit_flags_raised)
      VALUES ('run_old', 'bug', 7, 5, 0, 0.5, 2);
      CREATE TABLE score_notes (score_id INTEGER NOT NULL REFERENCES prd_quality_scores(id));
      INSERT INTO score_notes (score_id) VALUES (1);
    `);
    before.close();

    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(tryCreateEvidenceRepository(path)).toBeNull();
    expect(String(stderr.mock.calls[0]![0])).toContain("FOREIGN KEY constraint failed");
    stderr.mockRestore();
    // The open that failed closed its connection: SQLite removes the -wal and
    // -shm files when the last connection closes. Left open, the database
    // file cannot be deleted on Windows (EBUSY in the afterEach of this test
    // on windows-latest, review of #239).
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);

    const after = new Raw!(path);
    // Rolled back: the old table with its row, and no half-built copy.
    expect(notNullOf(after, "audit_flags_raised")).toBe(1);
    expect(after.pragma("table_info(prd_quality_scores_nullable)")).toEqual([]);
    // No write lock is left by the connection that failed: this insert
    // would wait for it, then fail with SQLITE_BUSY.
    after.exec(`
      INSERT INTO prd_quality_scores
        (prd_id, prd_context, rules_checked, rules_passed, critical_violations, total_score)
      VALUES ('run_after', 'feature', 1, 1, 0, 1);
    `);
    const ids = after.prepare("SELECT prd_id FROM prd_quality_scores ORDER BY id").all();
    after.close();
    expect(ids).toEqual([{ prd_id: "run_old" }, { prd_id: "run_after" }]);
  });

  it(
    "waits for another server that is rebuilding the table, and does not rebuild it again",
    async () => {
      const path = tempDb();
      // The database of an earlier server: every table of the schema, in WAL
      // mode, with the scores table as it was. Opening it then changes the
      // schema only if the table is rebuilt.
      tryCreateEvidenceRepository(path)!.close();
      const before = new Raw!(path);
      before.exec(`DROP TABLE prd_quality_scores; ${OLD_SCHEMA}`);
      before.exec(`
        INSERT INTO prd_quality_scores
          (prd_id, prd_context, rules_checked, rules_passed, critical_violations, total_score, audit_flags_raised)
        VALUES ('run_old', 'bug', 7, 5, 0, 0.5, 2);
      `);
      before.close();

      const files = dirname(path);
      const [holding, versionFile, go] = ["holding", "schema-version", "go"].map((name) => join(files, name));
      const sqlite = createRequire(import.meta.url).resolve("better-sqlite3");
      const other = spawn(process.execPath, ["-e", OTHER_SERVER, sqlite, path, holding, versionFile, go], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let otherStderr = "";
      other.stderr!.on("data", (chunk: Buffer) => (otherStderr += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => other.once("exit", (code) => resolve(code)));
      const mine = new Raw!(path);
      try {
        for (let waited = 0; !existsSync(holding) && waited < 10_000; waited += 20) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(existsSync(holding), `the other server did not take the lock: ${otherStderr}`).toBe(true);

        // The other server rebuilds only once this one has made its first
        // check: the race is the one of the review of #239, on every run,
        // not on the runs where the timing happens to produce it.
        const firstCheck: Array<{ name: string; notnull: number }> = [];
        const racing = {
          exec: (sql: string) => mine.exec(sql),
          transaction: mine.transaction.bind(mine),
          pragma: (statement: string) => {
            const rows = mine.pragma(statement);
            if (firstCheck.length === 0) {
              firstCheck.push(...(rows as Array<{ name: string; notnull: number }>));
              writeFileSync(go, "");
            }
            return rows;
          },
        };
        makeAuditFlagsNullable(racing);

        expect(firstCheck.find((c) => c.name === "audit_flags_raised")!.notnull).toBe(1);
        expect(await exited, otherStderr).toBe(0);
        expect(notNullOf(mine, "audit_flags_raised")).toBe(0);
        const rows = mine.prepare("SELECT prd_id FROM prd_quality_scores").all();
        expect(rows).toEqual([{ prd_id: "run_old" }]);
      } finally {
        mine.close();
        other.kill();
      }
      // The table is the one the other server left: this one did not rebuild it.
      expect(schemaVersionOf(path)).toBe(Number(readFileSync(versionFile, "utf-8")));
    },
    TWO_PROCESS_TIMEOUT_MS,
  );

  it("opens a database that needs no rebuild while another connection is writing", () => {
    const path = tempDb();
    tryCreateEvidenceRepository(path)!.close();
    const writer = new Raw!(path);
    writer.exec("BEGIN IMMEDIATE");
    // The check that the table needs no rebuild is made before any lock is
    // asked for. Made inside the transaction only, this open waited for the
    // writer's lock, then failed (better-sqlite3's busy timeout).
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const repo = tryCreateEvidenceRepository(path);
    const reported = stderr.mock.calls.map((call) => String(call[0]));
    stderr.mockRestore();
    writer.exec("ROLLBACK");
    writer.close();
    expect(reported).toEqual([]);
    expect(repo).not.toBeNull();
    repo!.close();
  });

  it("returns the scores newest first, also when they were recorded in the same second", () => {
    const repo = tryCreateEvidenceRepository(tempDb())!;
    for (const prdId of ["run_1", "run_2", "run_3"]) repo.recordQualityScore(score({ prdId }));
    const history = repo.getQualityHistory(2);
    repo.close();
    // created_at has one-second resolution: ordered by it, rows of the same
    // second came back oldest first, and the limit kept the two oldest.
    expect(history.map((h) => h.prdId)).toEqual(["run_3", "run_2"]);
  });

  it("leaves a database of the new schema as it is when it is opened again", () => {
    const path = tempDb();
    const first = tryCreateEvidenceRepository(path)!;
    first.recordQualityScore(score());
    first.close();
    const schemaBefore = schemaVersionOf(path);
    const second = tryCreateEvidenceRepository(path)!;
    second.recordQualityScore(score({ prdId: "run_b" }));
    const history = second.getQualityHistory(10);
    second.close();
    expect(history.map((h) => h.prdId).sort()).toEqual(["run_a", "run_b"]);
    // No table was rebuilt: SQLite increments schema_version at every
    // schema change (https://www.sqlite.org/pragma.html#pragma_schema_version).
    expect(schemaVersionOf(path)).toBe(schemaBefore);
  });
});
