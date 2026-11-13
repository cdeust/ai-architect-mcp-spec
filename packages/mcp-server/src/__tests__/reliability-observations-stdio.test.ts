/**
 * #121 — a pipeline run writes its reliability observations.
 *
 * The self-check concluded without the types of its claims and without an
 * observation hook, so a run flushed nothing: 0 rows after 7 runs (audit of
 * 2026-10-10). This plays a whole run through the built server, started
 * with a home of its own, and reads what the run left in
 * `~/.prd-gen/reliability.db` and in the observation log: one observation
 * per judge of each claim the self-check sent to at least two judges. A
 * judge alone on a claim is compared with its own verdict and is not
 * observed (self-check-observations.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryCreateReliabilityRepository } from "@prd-gen/core";
import { makeCannedDispatcher, type NextAction } from "@prd-gen/orchestration";
import { startStdioServer, type StdioServer } from "./stdio-server.js";

const TEST_TIMEOUT_MS = 120_000;

interface Envelope {
  readonly run_id: string;
  readonly current_step: string;
  readonly action: {
    readonly kind: string;
    readonly batch_id?: string;
    readonly invocations?: readonly { readonly prompt: string }[];
  };
  readonly __bounded: { readonly applied: readonly unknown[] };
}

// Skipped when better-sqlite3 cannot be loaded here: the server then has no
// reliability repository and writes no observation (same contract as
// evidence-db-path.test.ts).
const probeDir = mkdtempSync(join(tmpdir(), "reliability-probe-"));
const probe = tryCreateReliabilityRepository(join(probeDir, "reliability.db"));
probe?.close();
rmSync(probeDir, { recursive: true, force: true });
const sqliteAvailable = probe !== null;

let scratch: string;
let project: string;
let home: string;
let server: StdioServer | undefined;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "prd-gen-observations-"));
  project = join(scratch, "project");
  home = join(scratch, "home");
  mkdirSync(project);
  mkdirSync(home);
  if (!sqliteAvailable) return;
  server = await startStdioServer(undefined, { cwd: project, env: { HOME: home, USERPROFILE: home } });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await server?.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function okEnvelope(tool: string, args: Record<string, unknown>): Promise<Envelope> {
  const response = await server!.call(tool, args);
  expect(response.isError, response.text).toBe(false);
  const envelope = JSON.parse(response.text) as Envelope;
  // A run of this size ships every action whole; a shed prompt would have
  // to be read back before the dispatcher sees the action.
  expect(envelope.__bounded.applied, `${envelope.current_step}/${envelope.action.kind}`).toEqual([]);
  return envelope;
}

describe.skipIf(!sqliteAvailable)("the reliability observations of a pipeline run (#121)", () => {
  it(
    "writes one observation per judge of a claim several judges ruled on, to the database and to the log",
    async () => {
      const dispatch = makeCannedDispatcher({});
      let envelope = await okEnvelope("start_pipeline", {
        feature_description: "build a feature for OAuth login",
        codebase_path: "/tmp/smoke",
      });
      // The claim of each judge invocation of the self-check, read in its prompt.
      let sent: string[] = [];
      for (let steps = 0; steps < 2_000; steps++) {
        if (envelope.action.kind === "spawn_subagents" && envelope.action.batch_id === "self_check_verify") {
          sent = envelope.action.invocations!.map((invocation) => /<claim>\s*id: (\S+)/.exec(invocation.prompt)![1]!);
        }
        const result = dispatch(envelope.action as unknown as NextAction);
        if (result === undefined) break;
        envelope = await okEnvelope("submit_action_result", { run_id: envelope.run_id, result });
      }
      expect(envelope.action.kind).toBe("done");
      const compared = sent.filter((claim) => sent.filter((other) => other === claim).length >= 2);
      expect(compared.length).toBeGreaterThan(0);
      expect(compared.length).toBeLessThan(sent.length);

      // The server is stopped first: its database is then whole on disk.
      await server!.close();
      server = undefined;

      const stored = join(home, ".prd-gen");
      const repository = tryCreateReliabilityRepository(join(stored, "reliability.db"))!;
      const records = repository.getAllRecords();
      repository.close();
      expect(records.reduce((sum, record) => sum + record.nObservations, 0)).toBe(compared.length);
      // Judges only: the rule tier is not a judge whose reliability is estimated.
      expect(records.filter((record) => record.agentKind === "rule")).toEqual([]);

      const logPath = join(stored, "judge-observation-log.jsonl");
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { run_id: string; claim_id: string });
      expect(lines.map((line) => line.claim_id).sort()).toEqual([...compared].sort());
      expect(new Set(lines.map((line) => line.run_id))).toEqual(new Set([envelope.run_id]));

      // Nothing is written where the host started the server (#243).
      expect(readdirSync(project)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
