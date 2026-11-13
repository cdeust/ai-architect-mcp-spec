/**
 * The tables and indexes of the evidence database, as a database created
 * today has them. Moved out of evidence-repository.ts, statement for
 * statement, when that file reached the 500-line limit (#121); the one
 * change a database created earlier needs is in quality-score-migration.ts.
 */

/**
 * precondition:  `db` is an open evidence database, new or existing.
 * postcondition: every table and index below exists; what already existed
 *                is left as it is (`IF NOT EXISTS`).
 */
export function createEvidenceSchema(db: { exec(sql: string): void }): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategy_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL DEFAULT '',
      strategy TEXT NOT NULL,
      claim_characteristics TEXT NOT NULL,
      complexity_tier TEXT NOT NULL,
      expected_improvement REAL NOT NULL,
      actual_confidence_gain REAL NOT NULL,
      was_compliant INTEGER NOT NULL DEFAULT 1,
      retry_count INTEGER NOT NULL DEFAULT 0,
      prd_context TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS prd_quality_scores (
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

    CREATE TABLE IF NOT EXISTS adaptive_thresholds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric_name TEXT NOT NULL UNIQUE,
      current_value REAL NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_strategy_executions_strategy
      ON strategy_executions(strategy);
    CREATE INDEX IF NOT EXISTS idx_strategy_executions_context
      ON strategy_executions(prd_context);
    CREATE INDEX IF NOT EXISTS idx_prd_quality_scores_context
      ON prd_quality_scores(prd_context);
    CREATE INDEX IF NOT EXISTS idx_prd_quality_scores_prd_id
      ON prd_quality_scores(prd_id);
  `);
}
