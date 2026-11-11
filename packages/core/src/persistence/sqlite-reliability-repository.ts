/**
 * SQLite-backed implementation of ReliabilityRepository.
 *
 * Storage choice: SQLite via better-sqlite3, matching the EvidenceRepository
 * convention in this package. Justification:
 *   1. better-sqlite3 is already a hard dependency of @prd-gen/core.
 *   2. The per-judge reliability table is relational (primary key on
 *      4-tuple, UPSERT semantics, version row) — relational storage is
 *      strictly better than JSON-file for these access patterns.
 *   3. WAL mode + SQLite file lock serializes concurrent writes, matching
 *      the concurrency story in docs/PHASE_4_PLAN.md §Persistence concurrency.
 *   4. A plain JSON file would require read-parse-mutate-write with no
 *      built-in serialization, increasing the risk of torn writes.
 *
 * File location: ~/.prd-gen/reliability.db (separate from evidence.db to
 * allow independent backup and schema evolution).
 *
 * source: docs/PHASE_4_PLAN.md §4.1 Persistence — Laplace L6.
 */

import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import type { AgentIdentity } from "../index.js";
import type { Claim } from "../domain/agent.js";
import type {
  ReliabilityRepository,
  JudgeReliabilityRecord,
  ReliabilityObservation,
  VerdictDirection,
} from "./reliability-repository.js";
import {
  RELIABILITY_SCHEMA_VERSION,
  DEFAULT_RELIABILITY_PRIOR,
} from "./reliability-repository.js";

// ─── Structural types for better-sqlite3 (no @types/better-sqlite3 leakage) ──
// Mirrors the structural interface in evidence-repository.ts — avoids importing
// that file and entangling two independent repository implementations.

interface BetterSqlite3Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface BetterSqlite3Database {
  prepare(sql: string): BetterSqlite3Statement;
  exec(sql: string): void;
  pragma(stmt: string): unknown;
  close(): void;
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
}
type BetterSqlite3Constructor = new (path: string) => BetterSqlite3Database;

let Database: BetterSqlite3Constructor | null = null;
try {
  Database = (await import("better-sqlite3")).default as unknown as BetterSqlite3Constructor;
} catch {
  // better-sqlite3 not installed; SqliteReliabilityRepository will throw on construction.
}

// ─── Raw DB row shapes ────────────────────────────────────────────────────────

interface ReliabilityRow {
  agent_kind: string;
  agent_name: string;
  claim_type: string;
  verdict_direction: string;
  alpha: number;
  beta: number;
  n_observations: number;
  last_updated: string;
}

interface SchemaMetaRow {
  schema_version: number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class SqliteReliabilityRepository implements ReliabilityRepository {
  private readonly db: BetterSqlite3Database;
  private closed = false;

  constructor(dbPath?: string) {
    if (!Database) {
      throw new Error(
        "better-sqlite3 not available — install it with: pnpm add better-sqlite3",
      );
    }

    const resolvedPath = dbPath ?? defaultDbPath();
    // dirname, not a search for "/": a Windows path separates with "\\", so
    // the search found nothing, the directory came out empty and mkdir
    // failed, leaving the reliability store unavailable there (#126; the
    // evidence store was fixed the same way in #175).
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // busy_timeout is required for multi-writer WAL; 5000 ms covers typical
    // UPSERT contention without unbounded blocking.
    // source: SQLite docs, busy_timeout — https://www.sqlite.org/pragma.html#pragma_busy_timeout
    // source: B-Curie-5 cross-audit finding.
    this.db.pragma("busy_timeout = 5000");

    this.migrate();
    this.verifySchemaVersion();
  }

  // ─── Schema lifecycle ───────────────────────────────────────────────────

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        schema_version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_reliability (
        agent_kind        TEXT NOT NULL,
        agent_name        TEXT NOT NULL,
        claim_type        TEXT NOT NULL,
        verdict_direction TEXT NOT NULL CHECK (verdict_direction IN ('sensitivity_arm', 'specificity_arm')),
        alpha             REAL NOT NULL,
        beta              REAL NOT NULL,
        n_observations    INTEGER NOT NULL DEFAULT 0,
        last_updated      TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_kind, agent_name, claim_type, verdict_direction)
      );

      CREATE INDEX IF NOT EXISTS idx_ar_agent
        ON agent_reliability (agent_kind, agent_name);

      CREATE INDEX IF NOT EXISTS idx_ar_claim_type
        ON agent_reliability (claim_type);
    `);

    // Insert schema_version row on first run; no-op if already present.
    const existing = this.db
      .prepare("SELECT schema_version FROM schema_meta LIMIT 1")
      .get() as SchemaMetaRow | undefined;

    if (!existing) {
      this.db
        .prepare("INSERT INTO schema_meta (schema_version) VALUES (?)")
        .run(RELIABILITY_SCHEMA_VERSION);
    }
  }

  /**
   * Read the persisted schema_version and refuse to continue if it does not
   * match RELIABILITY_SCHEMA_VERSION.
   *
   * Auto-migration is out of scope for Wave B. A version mismatch means the DB
   * was written by a different schema and must be migrated manually or deleted
   * before this implementation can use it.
   *
   * source: Laplace L6 / docs/PHASE_4_PLAN.md §4.1 Persistence.
   */
  private verifySchemaVersion(): void {
    const row = this.db
      .prepare("SELECT schema_version FROM schema_meta LIMIT 1")
      .get() as SchemaMetaRow | undefined;

    if (!row) {
      throw new Error(
        "SqliteReliabilityRepository: schema_meta table is empty after migration — " +
          "this should not happen; the DB may be corrupt.",
      );
    }

    if (row.schema_version !== RELIABILITY_SCHEMA_VERSION) {
      throw new Error(
        `SqliteReliabilityRepository: schema version mismatch — ` +
          `DB has version ${row.schema_version}, ` +
          `implementation expects version ${RELIABILITY_SCHEMA_VERSION}. ` +
          `Delete the DB or run a manual migration before proceeding.`,
      );
    }
  }

  // ─── ReliabilityRepository port ─────────────────────────────────────────

  getSchemaVersion(): number {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT schema_version FROM schema_meta LIMIT 1")
      .get() as SchemaMetaRow | undefined;
    return row?.schema_version ?? RELIABILITY_SCHEMA_VERSION;
  }

  getReliability(
    judge: AgentIdentity,
    claimType: Claim["claim_type"],
    verdictDirection: VerdictDirection,
  ): JudgeReliabilityRecord | null {
    this.assertOpen();
    const row = this.db
      .prepare(
        `SELECT agent_kind, agent_name, claim_type, verdict_direction,
                alpha, beta, n_observations, last_updated
         FROM agent_reliability
         WHERE agent_kind = ? AND agent_name = ? AND claim_type = ? AND verdict_direction = ?`,
      )
      .get(judge.kind, judge.name, claimType, verdictDirection) as ReliabilityRow | undefined;

    if (!row) return null;
    return rowToRecord(row);
  }

  /**
   * Record one ground-truth-matched observation.
   *
   * Uses an UPSERT (INSERT ... ON CONFLICT DO UPDATE) so the first call for
   * a new cell initialises from the Beta(7,3) prior, and subsequent calls
   * accumulate.
   *
   * Concurrency: SQLite WAL + file lock serialises concurrent writes.
   * Two callers racing on the same cell will execute their UPSERTs sequentially
   * (last writer wins at the OS file lock level). Because each UPSERT is an
   * atomic read-modify-write on the server side (no separate SELECT), the
   * result matches sequential application — there is no lost-update anomaly.
   *
   * source: SQLite documentation — "WAL mode allows concurrent readers;
   * writers serialise at the WAL lock" (https://www.sqlite.org/wal.html).
   * source: docs/PHASE_4_PLAN.md §Persistence concurrency — "writes serialize
   * at the SQLite file lock."
   */
  recordObservation(
    judge: AgentIdentity,
    claimType: Claim["claim_type"],
    observation: ReliabilityObservation,
  ): void {
    this.assertOpen();

    const verdictDirection: VerdictDirection = observation.groundTruthIsFail
      ? "sensitivity_arm"
      : "specificity_arm";
    const alphaDelta = observation.judgeWasCorrect ? 1 : 0;
    const betaDelta = observation.judgeWasCorrect ? 0 : 1;

    this.db
      .prepare(
        `INSERT INTO agent_reliability
           (agent_kind, agent_name, claim_type, verdict_direction,
            alpha, beta, n_observations, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))
         ON CONFLICT(agent_kind, agent_name, claim_type, verdict_direction) DO UPDATE SET
           alpha          = alpha + ?,
           beta           = beta  + ?,
           n_observations = n_observations + 1,
           last_updated   = datetime('now')`,
      )
      .run(
        judge.kind,
        judge.name,
        claimType,
        verdictDirection,
        // INSERT values (first-run cell): prior + this observation
        // source: DEFAULT_RELIABILITY_PRIOR = Beta(7,3); docs/PHASE_4_PLAN.md §4.1
        DEFAULT_RELIABILITY_PRIOR.alpha + alphaDelta,
        DEFAULT_RELIABILITY_PRIOR.beta + betaDelta,
        // UPDATE deltas
        alphaDelta,
        betaDelta,
      );
  }

  getAllRecords(): ReadonlyArray<JudgeReliabilityRecord> {
    this.assertOpen();
    const rows = this.db
      .prepare(
        `SELECT agent_kind, agent_name, claim_type, verdict_direction,
                alpha, beta, n_observations, last_updated
         FROM agent_reliability
         ORDER BY agent_kind, agent_name, claim_type, verdict_direction`,
      )
      .all() as ReliabilityRow[];
    return rows.map(rowToRecord);
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SqliteReliabilityRepository: cannot call methods after close()");
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultDbPath(): string {
  return join(homedir(), ".prd-gen", "reliability.db");
}

function rowToRecord(row: ReliabilityRow): JudgeReliabilityRecord {
  return {
    agentKind: row.agent_kind as AgentIdentity["kind"],
    agentName: row.agent_name,
    claimType: row.claim_type as Claim["claim_type"],
    verdictDirection: row.verdict_direction as VerdictDirection,
    alpha: row.alpha,
    beta: row.beta,
    nObservations: row.n_observations,
    lastUpdated: row.last_updated,
    schemaVersion: RELIABILITY_SCHEMA_VERSION,
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Try to construct a SqliteReliabilityRepository. Returns null if
 * better-sqlite3 is not available (optional native dependency).
 *
 * Composition roots should use this factory rather than constructing directly,
 * following the same pattern as tryCreateEvidenceRepository in evidence-repository.ts.
 *
 * source: code-reviewer M7 pattern (Phase 3+4 cross-audit, 2026-04).
 */
export function tryCreateReliabilityRepository(
  dbPath?: string,
): SqliteReliabilityRepository | null {
  if (!Database) return null;
  try {
    return new SqliteReliabilityRepository(dbPath);
  } catch {
    return null;
  }
}
