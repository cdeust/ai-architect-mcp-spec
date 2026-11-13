#!/usr/bin/env node
/**
 * measure-quality-history-order.mjs [rows]: the measurement behind
 * `ORDER BY id DESC` in EvidenceRepository.getQualityHistory (#121, review
 * of #239).
 *
 * Fills an evidence database with `rows` quality scores recorded in one
 * second (default 100000), then, for the order the query had
 * (`created_at DESC`) and the one it has (`id DESC`), prints the query
 * plan, the first three scores returned and the median time of 15 runs
 * with LIMIT 1, which is what `check_health` asks for at each call.
 *
 * Needs `pnpm build` first (it opens the database through @prd-gen/core, so
 * the schema is the repository's). Not a test: a time is not asserted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(ROOT, "packages", "core");
const { tryCreateEvidenceRepository } = await import(pathToFileURL(join(CORE, "dist", "index.js")).href);
const Database = createRequire(join(CORE, "package.json"))("better-sqlite3");

const rows = Number(process.argv[2] ?? 100_000);
const RUNS = 15;
const dir = mkdtempSync(join(tmpdir(), "quality-history-order-"));
const path = join(dir, "evidence.db");
try {
  const repo = tryCreateEvidenceRepository(path);
  if (repo === null) throw new Error("the evidence database could not be opened (see stderr)");
  repo.close();

  const db = new Database(path);
  const insert = db.prepare(
    `INSERT INTO prd_quality_scores
       (prd_id, prd_context, rules_checked, rules_passed, critical_violations, total_score, audit_flags_raised, created_at)
     VALUES (?, 'feature', 65, 60, 1, 0.875, NULL, '2026-11-13 05:00:00')`,
  );
  db.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(`run_${String(i).padStart(7, "0")}`);
  })();

  for (const order of ["created_at DESC", "id DESC"]) {
    const sql = `SELECT prd_id FROM prd_quality_scores ORDER BY ${order} LIMIT ?`;
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1).map((step) => step.detail).join(" | ");
    const first = db.prepare(sql).all(3).map((row) => row.prd_id).join(", ");
    const query = db.prepare(sql);
    const times = [];
    for (let run = 0; run < RUNS; run++) {
      const start = process.hrtime.bigint();
      query.all(1);
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(RUNS / 2)].toFixed(3);
    console.log(`${rows} rows, ORDER BY ${order}: plan = ${plan}; first three = ${first}; LIMIT 1, median of ${RUNS} = ${median} ms`);
  }
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
