/**
 * One-time rebuild of `prd_quality_scores` for databases created before
 * #121, whose `audit_flags_raised` column is `INTEGER NOT NULL DEFAULT 0`.
 *
 * The pipeline records a quality score without running an audit-flag pass,
 * so the column must accept NULL. SQLite cannot drop NOT NULL in place: the
 * table is rebuilt in one transaction with the rows it holds, the procedure
 * of https://www.sqlite.org/lang_altertable.html, section 7. The two indexes
 * go with the old table and are created again.
 */

/** The part of a better-sqlite3 database the rebuild uses. */
interface QualityScoreDatabase {
  exec(sql: string): void;
  pragma(stmt: string): unknown;
}

/**
 * precondition:  `prd_quality_scores` exists in `db`.
 * postcondition: its `audit_flags_raised` column accepts NULL, and every
 *                row it held is still there, unchanged. A table that
 *                already accepts NULL is left as it is.
 */
export function makeAuditFlagsNullable(db: QualityScoreDatabase): void {
  const columns = db.pragma("table_info(prd_quality_scores)") as Array<{
    name: string;
    notnull: number;
  }>;
  const column = columns.find((c) => c.name === "audit_flags_raised");
  if (column === undefined || column.notnull === 0) return;
  db.exec(`
    BEGIN;
    CREATE TABLE prd_quality_scores_nullable (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prd_id TEXT NOT NULL,
      prd_context TEXT NOT NULL,
      rules_checked INTEGER NOT NULL,
      rules_passed INTEGER NOT NULL,
      critical_violations INTEGER NOT NULL,
      total_score REAL NOT NULL,
      audit_flags_raised INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO prd_quality_scores_nullable
      (id, prd_id, prd_context, rules_checked, rules_passed,
       critical_violations, total_score, audit_flags_raised, created_at)
      SELECT id, prd_id, prd_context, rules_checked, rules_passed,
             critical_violations, total_score, audit_flags_raised, created_at
      FROM prd_quality_scores;
    DROP TABLE prd_quality_scores;
    ALTER TABLE prd_quality_scores_nullable RENAME TO prd_quality_scores;
    CREATE INDEX idx_prd_quality_scores_context
      ON prd_quality_scores(prd_context);
    CREATE INDEX idx_prd_quality_scores_prd_id
      ON prd_quality_scores(prd_id);
    COMMIT;
  `);
}
