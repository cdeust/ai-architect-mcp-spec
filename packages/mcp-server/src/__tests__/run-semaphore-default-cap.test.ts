/**
 * The default cap of concurrent runs is 8 when PRD_MAX_CONCURRENT_RUNS is not
 * set (pipeline-runs.ts). run-semaphore.test.ts pins the mechanism with an
 * explicit cap of 3; this file pins the shipped default, with no variable.
 *
 * The cap is read when pipeline-runs.ts is first imported, so the variable is
 * removed before the import and restored afterwards.
 */
import { afterAll, beforeAll, expect, it } from "vitest";

const DEFAULT_CAP = 8;

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const handlers = new Map<string, ToolHandler>();
let savedCap: string | undefined;

beforeAll(async () => {
  savedCap = process.env.PRD_MAX_CONCURRENT_RUNS;
  delete process.env.PRD_MAX_CONCURRENT_RUNS;
  const { registerPipelineTools } = await import("../pipeline-tools.js");
  const server = {
    tool(name: string, ...rest: unknown[]) {
      handlers.set(name, rest[rest.length - 1] as ToolHandler);
    },
  };
  registerPipelineTools(server as unknown as Parameters<typeof registerPipelineTools>[0]);
});

afterAll(() => {
  if (savedCap === undefined) delete process.env.PRD_MAX_CONCURRENT_RUNS;
  else process.env.PRD_MAX_CONCURRENT_RUNS = savedCap;
});

it("accepts eight runs in flight with no variable set, then refuses the ninth", async () => {
  const start = handlers.get("start_pipeline")!;
  for (let i = 0; i < DEFAULT_CAP; i += 1) {
    const res = await start({ feature_description: `feature ${i}`, skip_preflight: true });
    expect(res.isError).toBeFalsy();
  }
  const rejected = await start({ feature_description: "overflow", skip_preflight: true });
  expect(rejected.isError).toBe(true);
  expect(JSON.parse(rejected.content[0].text)).toMatchObject({
    error: "run_capacity_exceeded",
    in_flight: DEFAULT_CAP,
    max_concurrent_runs: DEFAULT_CAP,
  });
});
