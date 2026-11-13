/**
 * #121 — a pipeline run survives a restart of the server.
 *
 * The state of a run and its pending action were kept in the memory of the
 * server process: after a restart, or a reload of the plugin, the run id
 * named nothing (`unknown run_id`) and the run was lost (audit of
 * 2026-10-10). This plays a whole canned run through the built server and
 * stops the server twice on the way: once early, once while the judges of the
 * self-check are pending, the point at which the state carries the most.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCannedDispatcher, type NextAction } from "@prd-gen/orchestration";
import { startStdioServer, type StdioServer } from "./stdio-server.js";

const TEST_TIMEOUT_MS = 120_000;
const EARLY_RESTART_AFTER_STEPS = 5;

interface Envelope {
  readonly run_id: string;
  readonly current_step: string;
  readonly action: { readonly kind: string; readonly batch_id?: string };
}

let scratch: string;
let project: string;
let home: string;
const servers: StdioServer[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "prd-gen-resume-"));
  project = join(scratch, "project");
  home = join(scratch, "home");
  mkdirSync(project);
  mkdirSync(home);
});

afterAll(async () => {
  for (const server of servers) await server.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function start(homeDir: string): Promise<StdioServer> {
  const server = await startStdioServer(undefined, { cwd: project, env: { HOME: homeDir, USERPROFILE: homeDir } });
  servers.push(server);
  return server;
}

async function ok(server: StdioServer, tool: string, args: Record<string, unknown>): Promise<Envelope> {
  const response = await server.call(tool, args);
  expect(response.isError, `${tool}: ${response.text}`).toBe(false);
  return JSON.parse(response.text) as Envelope;
}

const trace = (envelope: Envelope) => `${envelope.current_step}/${envelope.action.kind}`;

/**
 * Plays a canned run to its end. `restartBefore` says, for the envelope the
 * run is at, whether the server is stopped and another one started before
 * the result of that envelope's action is submitted.
 */
async function play(homeDir: string, restartBefore: (envelope: Envelope, steps: number) => boolean) {
  const dispatch = makeCannedDispatcher({});
  let server = await start(homeDir);
  let envelope = await ok(server, "start_pipeline", {
    feature_description: "build a feature for OAuth login",
    codebase_path: "/tmp/smoke",
  });
  const run_id = envelope.run_id;
  const steps = [trace(envelope)];
  let restarts = 0;
  for (let count = 1; count < 2_000; count++) {
    if (restartBefore(envelope, count)) {
      await server.close();
      server = await start(homeDir);
      restarts += 1;
      // What a host that lost the pending action reads back.
      const page = await ok(server, "get_pipeline_state", { run_id, format: "action" });
      expect(page.action.kind, `pending action after restart ${restarts}`).toBe(envelope.action.kind);
      expect(page.action.batch_id).toBe(envelope.action.batch_id);
      const summary = await ok(server, "get_pipeline_state", { run_id, format: "summary" });
      expect(summary.current_step).toBe(envelope.current_step);
    }
    const result = dispatch(envelope.action as unknown as NextAction);
    if (result === undefined) break;
    envelope = await ok(server, "submit_action_result", { run_id, result });
    steps.push(trace(envelope));
  }
  await server.close();
  return { run_id, steps, restarts, last: envelope };
}

describe("a pipeline run and a restart of the server (#121)", () => {
  it(
    "goes on under its run id after each restart, to the end an uninterrupted run reaches",
    async () => {
      const control = await play(join(scratch, "home-control"), () => false);
      expect(control.last.action.kind).toBe("done");

      const resumed = await play(
        home,
        (envelope, steps) =>
          steps === EARLY_RESTART_AFTER_STEPS ||
          (envelope.action.kind === "spawn_subagents" && envelope.action.batch_id === "self_check_verify"),
      );
      expect(resumed.restarts).toBe(2);
      expect(resumed.last.action.kind).toBe("done");
      expect(resumed.steps).toEqual(control.steps);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the run in a file of its own under ~/.prd-gen/runs, and nothing where the server was started",
    async () => {
      const own = join(scratch, "home-files");
      const server = await start(own);
      const envelope = await ok(server, "start_pipeline", { feature_description: "build a feature for OAuth login" });
      await server.close();
      expect(readdirSync(join(own, ".prd-gen", "runs"))).toEqual([`${envelope.run_id}.json`]);
      expect(readdirSync(project)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "says that the state kept for a run cannot be read, and why, when its file is damaged",
    async () => {
      const own = join(scratch, "home-damaged");
      let server = await start(own);
      const envelope = await ok(server, "start_pipeline", { feature_description: "build a feature for OAuth login" });
      await server.close();
      const file = join(own, ".prd-gen", "runs", `${envelope.run_id}.json`);
      writeFileSync(file, "{");

      server = await start(own);
      const dispatch = makeCannedDispatcher({});
      const calls: Array<[string, Record<string, unknown>]> = [
        ["get_pipeline_state", { run_id: envelope.run_id, format: "summary" }],
        ["submit_action_result", { run_id: envelope.run_id, result: dispatch(envelope.action as unknown as NextAction) }],
      ];
      for (const [tool, args] of calls) {
        const response = await server.call(tool, args);
        expect(response.isError, tool).toBe(true);
        expect(response.text, tool).toContain(`the state kept for run_id ${envelope.run_id} cannot be read: not JSON`);
      }
      await server.close();
      // The file is left for whoever looks into it.
      expect(readdirSync(join(own, ".prd-gen", "runs"))).toEqual([`${envelope.run_id}.json`]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers unknown run_id for a run id no file is kept for, and refuses an id that is not a run id",
    async () => {
      const own = join(scratch, "home-unknown");
      const server = await start(own);
      const unknown = await server.call("get_pipeline_state", { run_id: "run_zzzzzzzz_zzzzzz", format: "summary" });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain("unknown run_id");
      // An id is the name of a file: one that is not of the form the server
      // gives is never turned into a path.
      const outside = join(own, "outside");
      const crafted = await server.call("get_pipeline_state", { run_id: "../../outside", format: "summary" });
      expect(crafted.isError).toBe(true);
      expect(crafted.text).toContain("unknown run_id");
      await server.close();
      expect(existsSync(outside)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
