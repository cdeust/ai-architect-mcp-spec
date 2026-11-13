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
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryCreateEvidenceRepository, type PRDQualityScore } from "../index.js";

interface RawDatabase {
  exec(sql: string): void;
  pragma(source: string): unknown;
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
