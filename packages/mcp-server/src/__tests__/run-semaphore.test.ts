/**
 * Bounded-I/O global run semaphore tests (Phase 3).
 *
 * Proves:
 *   - start_pipeline admits up to MAX_CONCURRENT_RUNS in-flight runs, then
 *     rejects further calls with a structured, retryable error (not a hang).
 *   - the rejection envelope carries error:"run_capacity_exceeded",
 *     retryable:true, and the in_flight / max_concurrent_runs counters
 *     (observable degradation — never silent).
 *
 * Strategy: a minimal capturing McpServer records each (name → handler) the
 * production registerPipelineTools wires, then we invoke start_pipeline N+1
 * times. The semaphore counts NON-complete runs; start_pipeline's first step is
 * "banner" (in flight), so each successful call consumes one slot. The cap is
 * set via PRD_MAX_CONCURRENT_RUNS so the test is deterministic and small.
 *
 * The module reads PRD_MAX_CONCURRENT_RUNS at import time, so we set it before
 * importing pipeline-tools.
 */
import { describe, it, expect, beforeAll } from "vitest";

const CAP = 3;

// Tool handler signature captured from the production server.tool() calls.
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface CapturingServer {
  // Production server.tool() calls pass an optional annotations object
  // (e.g. { destructiveHint: true }) between the schema and the handler, so the
  // handler is not at a fixed positional index. Capture the LAST argument as the
  // handler so this shim stays correct whether or not a tool passes annotations.
  tool(name: string, ...rest: unknown[]): void;
}

let handlers: Map<string, ToolHandler>;

beforeAll(async () => {
  process.env.PRD_MAX_CONCURRENT_RUNS = String(CAP);
  // Import AFTER setting the env var — the cap is read at module init.
  const { registerPipelineTools } = await import("../pipeline-tools.js");
  handlers = new Map();
  const server: CapturingServer = {
    tool(name, ...rest) {
      const handler = rest[rest.length - 1] as ToolHandler;
      handlers.set(name, handler);
    },
  };
  // The production type is McpServer; the capturing shape is structurally
  // compatible for the .tool() surface registerPipelineTools uses.
  registerPipelineTools(server as unknown as Parameters<typeof registerPipelineTools>[0]);
});

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text);
}

describe("global run semaphore — start_pipeline", () => {
  it("admits up to the cap, then rejects with a structured retryable error", async () => {
    const start = handlers.get("start_pipeline")!;

    // Fill the semaphore: CAP successful starts, each an in-flight run.
    for (let i = 0; i < CAP; i += 1) {
      const res = await start({
        feature_description: `feature ${i}`,
        skip_preflight: true,
      });
      expect(res.isError).toBeFalsy();
      const body = parse(res);
      expect(body.run_id).toBeDefined();
      expect(body.current_step).not.toBe("complete"); // in flight → holds a slot
    }

    // CAP+1: rejected, not hung, with the observable counters.
    const rejected = await start({
      feature_description: "overflow",
      skip_preflight: true,
    });
    expect(rejected.isError).toBe(true);
    const body = parse(rejected);
    expect(body.error).toBe("run_capacity_exceeded");
    expect(body.retryable).toBe(true);
    expect(body.in_flight).toBe(CAP);
    expect(body.max_concurrent_runs).toBe(CAP);
    expect(typeof body.message).toBe("string");
    expect(body.message).toBe(
      `pipeline run capacity reached: ${CAP}/${CAP} runs in flight. ` +
        "Retry after an in-flight run completes (current_step:'complete'), " +
        "or raise PRD_MAX_CONCURRENT_RUNS.",
    );
  });
});
