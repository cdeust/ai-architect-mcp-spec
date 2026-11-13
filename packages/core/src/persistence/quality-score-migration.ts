/**
 * One-time rebuild of `prd_quality_scores` for databases created before
 * #121, whose `audit_flags_raised` column is `INTEGER NOT NULL DEFAULT 0`.
 *
 * The pipeline records a quality score without running an audit-flag pass,
 * so the column must accept NULL. SQLite cannot drop NOT NULL in place: the
 * table is rebuilt with the rows it holds, the procedure of
 * https://www.sqlite.org/lang_altertable.html, section 7. The two indexes go
 * with the old table and are created again. No table of this schema has a
 * foreign key to `prd_quality_scores`, so the steps of that procedure about
 * foreign keys do not apply.
 *
 * The rebuild runs in one better-sqlite3 transaction: a statement that
 * fails rolls it back, and the database is left as it was, with no write
 * lock held by the connection that failed.
 */

/** The part of a better-sqlite3 database the rebuild uses. */
interface QualityScoreDatabase {
  exec(sql: string): void;
  pragma(stmt: string): unknown;
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T & { immediate: T };
}

/** True when `audit_flags_raised` is still declared NOT NULL. */
function auditFlagsAreRequired(db: QualityScoreDatabase): boolean {
  const columns = db.pragma("table_info(prd_quality_scores)") as Array<{
    name: string;
    notnull: number;
  }>;
  return columns.some((c) => c.name === "audit_flags_raised" && c.notnull === 1);
}

/**
 * precondition:  `prd_quality_scores` exists in `db`.
 * postcondition: its `audit_flags_raised` column accepts NULL, and every
 *                row it held is still there, unchanged. A table that
 *                already accepts NULL is left as it is. Throws, with the
 *                database unchanged, when a statement of the rebuild fails.
 *
 * The transaction is IMMEDIATE: it takes the write lock before it reads. Two
 * servers can open the same database at once; the second waits for the lock
 * (better-sqlite3's busy timeout), then finds the column rebuilt and leaves.
 * Deferred, it read the schema first, and the write that followed failed
 * with "database is locked" while the first server was rebuilding: the
 * evidence store of the second was off until it restarted. Measured
 * 2026-11-13 by running the two-process test of
 * evidence-quality-score-nullable.test.ts with `rebuild()` in place of
 * `rebuild.immediate()`: `SqliteError: database is locked`, and no second
 * rebuild (review of #239).
 */
export function makeAuditFlagsNullable(db: QualityScoreDatabase): void {
  if (!auditFlagsAreRequired(db)) return;
  const rebuild = db.transaction(() => {
    if (!auditFlagsAreRequired(db)) return;
    db.exec(`
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
    `);
  });
  rebuild.immediate();
}
