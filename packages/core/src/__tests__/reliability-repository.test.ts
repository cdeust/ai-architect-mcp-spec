/**
 * Reliability repository tests.
 *
 * Stakes: High — persistence layer for calibration data that drives
 * consensus confidence weights (docs/PHASE_4_PLAN.md §4.1).
 * Full coding-standards §10 enforcement applies.
 *
 * Test strategy:
 *   - Use in-memory paths (:memory: is not supported by better-sqlite3 via
 *     file path, so we use tmp files under os.tmpdir() with per-test unique
 *     names, cleaned up in afterEach). This gives us true file-based isolation
 *     without touching ~/.prd-gen.
 *   - Each test constructs its own repository instance to avoid shared state.
 *
 * source: coding-standards §3.2 (reliability), §8 (source discipline).
 */

import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import {
  SqliteReliabilityRepository,
  RELIABILITY_SCHEMA_VERSION,
  DEFAULT_RELIABILITY_PRIOR,
} from "../index.js";
import type { AgentIdentity, Claim } from "../index.js";
import type { ReliabilityObservation } from "../index.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const judgeA: AgentIdentity = { kind: "genius", name: "laplace" };
const judgeB: AgentIdentity = { kind: "genius", name: "fisher" };
const claimType: Claim["claim_type"] = "architecture";

const correctOnFail: ReliabilityObservation = {
  groundTruthIsFail: true,
  judgeWasCorrect: true,
};
const incorrectOnFail: ReliabilityObservation = {
  groundTruthIsFail: true,
  judgeWasCorrect: false,
};
const correctOnPass: ReliabilityObservation = {
  groundTruthIsFail: false,
  judgeWasCorrect: true,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tempPaths: string[] = [];

function tempDb(label: string): string {
  const p = join(tmpdir(), `reliability-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tempPaths.push(p);
  return p;
}

afterEach(() => {
  for (const p of tempPaths) {
    if (existsSync(p)) rmSync(p);
  }
  tempPaths = [];
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SqliteReliabilityRepository — construction", () => {
  it("opens a database whose path holds no forward slash", () => {
    // #126: the parent directory was cut at the last "/". A Windows path
    // (C:\\Users\\…\\reliability.db) has none, so the directory came out
    // empty and mkdir failed. A bare file name has none on any platform.
    const name = `reliability-test-bare-${process.pid}-${Math.random().toString(36).slice(2)}.db`;
    tempPaths.push(name, `${name}-wal`, `${name}-shm`);
    expect(name).not.toContain("/");
    const repo = new SqliteReliabilityRepository(name);
    expect(existsSync(name)).toBe(true);
    repo.close();
  });

  it("creates the DB file and sets schema_version to RELIABILITY_SCHEMA_VERSION", () => {
    const path = tempDb("construction");
    const repo = new SqliteReliabilityRepository(path);
    expect(existsSync(path)).toBe(true);
    expect(repo.getSchemaVersion()).toBe(RELIABILITY_SCHEMA_VERSION);
    repo.close();
  });

  it("is idempotent — opening the same DB twice does not corrupt schema_version", () => {
    const path = tempDb("idempotent");
    const r1 = new SqliteReliabilityRepository(path);
    r1.close();
    const r2 = new SqliteReliabilityRepository(path);
    expect(r2.getSchemaVersion()).toBe(RELIABILITY_SCHEMA_VERSION);
    r2.close();
  });
});

describe("SqliteReliabilityRepository — empty-DB / prior contract", () => {
  it("getReliability returns null for an unseen (judge, claim_type, direction) cell", () => {
    const repo = new SqliteReliabilityRepository(tempDb("empty"));
    const result = repo.getReliability(judgeA, claimType, "sensitivity_arm");
    expect(result).toBeNull();
    repo.close();
  });

  it("getAllRecords returns an empty array on a fresh DB", () => {
    const repo = new SqliteReliabilityRepository(tempDb("empty-all"));
    expect(repo.getAllRecords()).toHaveLength(0);
    repo.close();
  });

  it("null return from getReliability signals 'use Beta prior' — DEFAULT_RELIABILITY_PRIOR is accessible", () => {
    // This test documents the empty-DB-returns-prior contract:
    // callers receive null and must fall back to DEFAULT_RELIABILITY_PRIOR.
    // source: docs/PHASE_4_PLAN.md §4.1 — "For agents with insufficient global
    // data, fall back to Beta(7, 3) prior."
    // B-Shannon-7: single source of truth in @prd-gen/core.
    expect(DEFAULT_RELIABILITY_PRIOR.alpha).toBe(7);
    expect(DEFAULT_RELIABILITY_PRIOR.beta).toBe(3);

    const repo = new SqliteReliabilityRepository(tempDb("prior-contract"));
    const result = repo.getReliability(judgeA, claimType, "sensitivity_arm");
    // null signals "apply prior"; the prior values come from DEFAULT_RELIABILITY_PRIOR.
    expect(result).toBeNull();
    repo.close();
  });
});

describe("SqliteReliabilityRepository — round-trip", () => {
  it("write → read returns the same record", () => {
    const repo = new SqliteReliabilityRepository(tempDb("roundtrip"));

    repo.recordObservation(judgeA, claimType, correctOnFail);
    const record = repo.getReliability(judgeA, claimType, "sensitivity_arm");

    expect(record).not.toBeNull();
    expect(record!.agentKind).toBe("genius");
    expect(record!.agentName).toBe("laplace");
    expect(record!.claimType).toBe("architecture");
    expect(record!.verdictDirection).toBe("sensitivity_arm");
    // First correct observation: alpha = 7 + 1 = 8, beta = 3 + 0 = 3
    expect(record!.alpha).toBe(DEFAULT_RELIABILITY_PRIOR.alpha + 1);
    expect(record!.beta).toBe(DEFAULT_RELIABILITY_PRIOR.beta);
    expect(record!.nObservations).toBe(1);
    expect(record!.schemaVersion).toBe(RELIABILITY_SCHEMA_VERSION);
    expect(typeof record!.lastUpdated).toBe("string");
    expect(record!.lastUpdated.length).toBeGreaterThan(0);

    repo.close();
  });

  it("incorrect observation increments beta, not alpha", () => {
    const repo = new SqliteReliabilityRepository(tempDb("incorrect"));

    repo.recordObservation(judgeA, claimType, incorrectOnFail);
    const record = repo.getReliability(judgeA, claimType, "sensitivity_arm");

    expect(record!.alpha).toBe(DEFAULT_RELIABILITY_PRIOR.alpha);
    expect(record!.beta).toBe(DEFAULT_RELIABILITY_PRIOR.beta + 1);
    expect(record!.nObservations).toBe(1);

    repo.close();
  });

  it("pass observation writes to the 'specificity_arm' direction cell, not the 'sensitivity_arm' cell", () => {
    const repo = new SqliteReliabilityRepository(tempDb("direction"));

    repo.recordObservation(judgeA, claimType, correctOnPass);

    expect(repo.getReliability(judgeA, claimType, "specificity_arm")).not.toBeNull();
    // The sensitivity_arm cell must remain untouched.
    expect(repo.getReliability(judgeA, claimType, "sensitivity_arm")).toBeNull();

    repo.close();
  });

  it("multiple observations accumulate correctly on the same cell", () => {
    const repo = new SqliteReliabilityRepository(tempDb("accumulate"));

    // 3 correct, 1 incorrect on the sensitivity_arm track
    repo.recordObservation(judgeA, claimType, correctOnFail);
    repo.recordObservation(judgeA, claimType, correctOnFail);
    repo.recordObservation(judgeA, claimType, incorrectOnFail);
    repo.recordObservation(judgeA, claimType, correctOnFail);

    const record = repo.getReliability(judgeA, claimType, "sensitivity_arm");
    // alpha = 7 + 3 = 10, beta = 3 + 1 = 4, n = 4
    expect(record!.alpha).toBe(DEFAULT_RELIABILITY_PRIOR.alpha + 3);
    expect(record!.beta).toBe(DEFAULT_RELIABILITY_PRIOR.beta + 1);
    expect(record!.nObservations).toBe(4);

    repo.close();
  });
});

describe("SqliteReliabilityRepository — getAllRecords", () => {
  it("returns all written cells", () => {
    const repo = new SqliteReliabilityRepository(tempDb("getall"));

    repo.recordObservation(judgeA, "architecture", correctOnFail);
    repo.recordObservation(judgeA, "performance", correctOnPass);
    repo.recordObservation(judgeB, "security", correctOnFail);

    const all = repo.getAllRecords();
    expect(all).toHaveLength(3);

    const kinds = all.map((r) => `${r.agentName}:${r.claimType}:${r.verdictDirection}`).sort();
    expect(kinds).toEqual([
      "fisher:security:sensitivity_arm",
      "laplace:architecture:sensitivity_arm",
      "laplace:performance:specificity_arm",
    ]);

    repo.close();
  });

  it("returns a ReadonlyArray — TypeScript enforcement is compile-time only; runtime returns array", () => {
    const repo = new SqliteReliabilityRepository(tempDb("readonly"));
    repo.recordObservation(judgeA, claimType, correctOnFail);
    const all = repo.getAllRecords();
    expect(Array.isArray(all)).toBe(true);
    repo.close();
  });
});

describe("SqliteReliabilityRepository — schema-version mismatch", () => {
  it("refuses to open a DB with a different schema_version", async () => {
    // Write a DB with schema_version = 999 by hand.
    const path = tempDb("mismatch");

    // Create a valid DB first, then corrupt the schema_version.
    const r = new SqliteReliabilityRepository(path);
    r.close();

    // Inject a bad schema_meta row using a companion better-sqlite3 instance.
    // Dynamic import is acceptable here: the test layer is infrastructure.
    try {
      const BetterSqlite3 = (await import("better-sqlite3")).default;
      const tamperedDb = new BetterSqlite3(path) as unknown as {
        exec(s: string): void;
        close(): void;
      };
      tamperedDb.exec("UPDATE schema_meta SET schema_version = 999");
      tamperedDb.close();
    } catch {
      // better-sqlite3 unavailable — skip.
      return;
    }

    expect(() => new SqliteReliabilityRepository(path)).toThrowError(/schema version mismatch/);
  });
});

describe("SqliteReliabilityRepository — concurrent-write sequential correctness", () => {
  /**
   * Concurrent-write safety (Lamport hand-off note):
   * SQLite WAL mode serialises writers at the file lock. Two recordObservation
   * calls for the same cell from different JS execution contexts will execute
   * their UPSERT statements sequentially — the final state matches sequential
   * application regardless of interleaving order.
   *
   * busy_timeout = 5000 ms (B-Curie-5): set in the constructor immediately after
   * WAL pragma. This prevents SQLITE_BUSY from silently dropping concurrent
   * writes when a second writer races the WAL lock. 5000 ms covers typical
   * UPSERT contention; unbounded blocking is avoided because busy_timeout is a
   * deadline, not a spin-wait.
   * source: SQLite docs pragma.html#pragma_busy_timeout; B-Curie-5 finding.
   *
   * This test verifies the property by simulating two "concurrent" callers on
   * the same synchronous SQLite connection (better-sqlite3 is always sync, so
   * true OS-level concurrency is not testable without Worker threads here).
   * The test demonstrates that two sequential calls on the same connection
   * produce the correct accumulated result — no lost updates, no tearing.
   *
   * B-Curie-5 note: testing two concurrent recordObservation calls from
   * *separate file descriptors* is not feasible without Worker threads in this
   * test environment. The correctness argument for that scenario rests on:
   *   1. busy_timeout = 5000 ms (contention does not silently fail), AND
   *   2. SQLite WAL serialization at the file lock (writes are ordered), AND
   *   3. Each UPSERT is an atomic read-modify-write (no lost-update anomaly).
   * This is a documented Lamport hand-off: formal verification of the multi-FD
   * scenario requires Worker thread testing or a separate process-level test.
   *
   * source: docs/PHASE_4_PLAN.md §Persistence concurrency.
   * source: https://www.sqlite.org/wal.html — "WAL mode allows concurrent readers;
   * writers serialise at the WAL lock."
   *
   * Hand-off: Lamport should review the multi-process scenario if >1 benchmark
   * process writes to the same reliability.db simultaneously.
   */
  it("two recordObservation calls for the same cell produce correct accumulated state", () => {
    const repo = new SqliteReliabilityRepository(tempDb("concurrent"));

    // Simulate two "concurrent" writers for the same (judgeA, architecture, sensitivity_arm) cell.
    repo.recordObservation(judgeA, "architecture", correctOnFail);   // caller 1
    repo.recordObservation(judgeA, "architecture", incorrectOnFail); // caller 2

    const record = repo.getReliability(judgeA, "architecture", "sensitivity_arm");

    // Sequential application: alpha = 7+1+0=8, beta = 3+0+1=4, n = 2
    expect(record!.alpha).toBe(DEFAULT_RELIABILITY_PRIOR.alpha + 1);
    expect(record!.beta).toBe(DEFAULT_RELIABILITY_PRIOR.beta + 1);
    expect(record!.nObservations).toBe(2);

    repo.close();
  });

  it("concurrent calls on different cells do not interfere", () => {
    const repo = new SqliteReliabilityRepository(tempDb("concurrent-cells"));

    repo.recordObservation(judgeA, "architecture", correctOnFail);
    repo.recordObservation(judgeB, "architecture", incorrectOnFail);

    const ra = repo.getReliability(judgeA, "architecture", "sensitivity_arm");
    const rb = repo.getReliability(judgeB, "architecture", "sensitivity_arm");

    expect(ra!.alpha).toBe(DEFAULT_RELIABILITY_PRIOR.alpha + 1);
    expect(ra!.beta).toBe(DEFAULT_RELIABILITY_PRIOR.beta);

    expect(rb!.alpha).toBe(DEFAULT_RELIABILITY_PRIOR.alpha);
    expect(rb!.beta).toBe(DEFAULT_RELIABILITY_PRIOR.beta + 1);

    repo.close();
  });
});

describe("SqliteReliabilityRepository — lifecycle", () => {
  it("close() is idempotent — calling twice does not throw", () => {
    const repo = new SqliteReliabilityRepository(tempDb("close-idempotent"));
    repo.close();
    expect(() => repo.close()).not.toThrow();
  });

  it("methods throw after close()", () => {
    const repo = new SqliteReliabilityRepository(tempDb("closed-methods"));
    repo.close();
    expect(() => repo.getReliability(judgeA, claimType, "sensitivity_arm")).toThrow(/after close/);
    expect(() => repo.recordObservation(judgeA, claimType, correctOnFail)).toThrow(/after close/);
    expect(() => repo.getAllRecords()).toThrow(/after close/);
    expect(() => repo.getSchemaVersion()).toThrow(/after close/);
  });
});

describe("SqliteReliabilityRepository — all claim_types accepted", () => {
  const allClaimTypes: Array<Claim["claim_type"]> = [
    "architecture",
    "performance",
    "correctness",
    "security",
    "data_model",
    "test_coverage",
    "story_point_arithmetic",
    "fr_traceability",
    "risk",
    "acceptance_criteria_completeness",
    "cross_file_consistency",
  ];

  it("accepts and round-trips all 11 claim types from ClaimSchema", () => {
    const repo = new SqliteReliabilityRepository(tempDb("all-claim-types"));

    for (const ct of allClaimTypes) {
      repo.recordObservation(judgeA, ct, correctOnFail);
    }

    const all = repo.getAllRecords();
    // 11 claim types × 1 direction × 1 judge = 11 records
    expect(all).toHaveLength(allClaimTypes.length);

    for (const ct of allClaimTypes) {
      const r = repo.getReliability(judgeA, ct, "sensitivity_arm");
      expect(r).not.toBeNull();
      expect(r!.claimType).toBe(ct);
    }

    repo.close();
  });
});
