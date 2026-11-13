/**
 * #121 — the score of a run reaches `get_quality_history`.
 *
 * Until #121 nothing called `EvidenceRepository.recordQualityScore`: the
 * tool answered an empty list whatever had run (audit of 2026-10-10). This
 * plays a whole run through the built server over stdio, as a host does,
 * and reads the history before and after it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryCreateEvidenceRepository } from "@prd-gen/core";
import { makeCannedDispatcher, type NextAction } from "@prd-gen/orchestration";
import { startStdioServer, type StdioServer } from "./stdio-server.js";

// A cold start of the built server plus a whole canned run; see
// stdio-server.ts for the per-response bound.
const TEST_TIMEOUT_MS = 120_000;

interface Envelope {
  readonly run_id: string;
  readonly current_step: string;
  readonly action: { readonly kind: string };
  readonly __bounded: { readonly applied: readonly unknown[] };
}

interface Score {
  readonly prdId: string;
  readonly prdContext: string;
  readonly rulesChecked: number;
  readonly rulesPassed: number;
  readonly criticalViolations: number;
  readonly totalScore: number;
  readonly auditFlagsRaised: number | null;
}

// Skipped when better-sqlite3 cannot be loaded here: the tool then answers
// its "unavailable" error (same contract as evidence-db-path.test.ts).
const probeDir = mkdtempSync(join(tmpdir(), "quality-history-probe-"));
const probe = tryCreateEvidenceRepository(join(probeDir, "evidence.db"));
probe?.close();
rmSync(probeDir, { recursive: true, force: true });
const sqliteAvailable = probe !== null;

let server: StdioServer | undefined;

beforeAll(async () => {
  if (sqliteAvailable) server = await startStdioServer();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await server?.close();
});

async function history(): Promise<Score[]> {
  const response = await server!.call("get_quality_history", { limit: 200 });
  expect(response.isError, response.text).toBe(false);
  return JSON.parse(response.text) as Score[];
}

async function okEnvelope(tool: string, args: Record<string, unknown>): Promise<Envelope> {
  const response = await server!.call(tool, args);
  expect(response.isError, response.text).toBe(false);
  const envelope = JSON.parse(response.text) as Envelope;
  // A run of this size ships every action whole; a shed prompt would have
  // to be read back before the dispatcher sees the action.
  expect(envelope.__bounded.applied, `${envelope.current_step}/${envelope.action.kind}`).toEqual([]);
  return envelope;
}

/** Plays one canned run to its last action; returns its id and that action's kind. */
async function playRun(featureDescription: string): Promise<{ runId: string; lastKind: string }> {
  const dispatch = makeCannedDispatcher({});
  let envelope = await okEnvelope("start_pipeline", {
    feature_description: featureDescription,
    codebase_path: "/tmp/smoke",
  });
  for (let steps = 0; steps < 2_000; steps++) {
    const result = dispatch(envelope.action as unknown as NextAction);
    if (result === undefined) return { runId: envelope.run_id, lastKind: envelope.action.kind };
    envelope = await okEnvelope("submit_action_result", { run_id: envelope.run_id, result });
  }
  throw new Error("the run does not terminate");
}

describe.skipIf(!sqliteAvailable)("get_quality_history returns the score of a run (#121)", () => {
  it("is empty before a run and holds one score per run after it", async () => {
    expect(await history()).toEqual([]);

    const first = await playRun("build a feature for OAuth login");
    expect(first.lastKind).toBe("done");

    const afterFirst = await history();
    expect(afterFirst).toHaveLength(1);
    const score = afterFirst[0]!;
    expect(score.prdId).toBe(first.runId);
    // No audit-flag pass runs in the pipeline: null, not a zero that would
    // say one ran and raised nothing.
    expect(score.auditFlagsRaised).toBeNull();
    expect(score.rulesChecked).toBeGreaterThan(0);
    expect(score.rulesPassed).toBeLessThanOrEqual(score.rulesChecked);
    expect(score.totalScore).toBeGreaterThanOrEqual(0);
    expect(score.totalScore).toBeLessThanOrEqual(1);

    // A second run adds its own score and leaves the first as it was.
    const second = await playRun("build a feature for SAML login");
    expect(second.lastKind).toBe("done");
    expect(second.runId).not.toBe(first.runId);
    const afterSecond = await history();
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond.map((s) => s.prdId).sort()).toEqual([first.runId, second.runId].sort());
    expect(afterSecond.find((s) => s.prdId === first.runId)).toEqual(score);
  }, TEST_TIMEOUT_MS);
});
