/**
 * Integration test for `get_pipeline_state(format:"action")` — the recovery
 * path a host follows when a `start_pipeline`/`submit_action_result`
 * envelope carries a `__bounded` marker on its `spawn_subagents` action
 * (bound-envelope-action.ts). Proves the wiring end-to-end through the real
 * `registerPipelineTools` handlers (not just the pure bounding function unit
 * tests in bound-envelope-action.test.ts): the mcp-server composition root
 * caches the UNBOUNDED action on every start_pipeline/submit_action_result
 * call and serves it back via the new format selector.
 *
 * source: e2e run_mrlqa0aj_u2rh15 (2026-07-15).
 */
import { describe, expect, it, beforeAll } from "vitest";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface CapturingServer {
  tool(name: string, ...rest: unknown[]): void;
}

let handlers: Map<string, ToolHandler>;

beforeAll(async () => {
  const { registerPipelineTools } = await import("../pipeline-tools.js");
  handlers = new Map();
  const server: CapturingServer = {
    tool(name, ...rest) {
      const handler = rest[rest.length - 1] as ToolHandler;
      handlers.set(name, handler);
    },
  };
  registerPipelineTools(server as unknown as Parameters<typeof registerPipelineTools>[0]);
});

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text);
}

describe("get_pipeline_state format:'action'", () => {
  it("every start_pipeline/submit_action_result envelope carries a __bounded marker (empty applied when under budget)", async () => {
    const start = handlers.get("start_pipeline")!;
    const res = await start({
      feature_description: "OAuth login for the mobile app",
      skip_preflight: true,
    });
    const body = parse(res);
    expect(body.__bounded).toBeDefined();
    const bounded = body.__bounded as { applied: unknown[]; budget_chars: number };
    expect(Array.isArray(bounded.applied)).toBe(true);
    expect(bounded.budget_chars).toBe(100_000);
  });

  it("returns the exact last action (including full content) for a known run_id", async () => {
    const start = handlers.get("start_pipeline")!;
    const getState = handlers.get("get_pipeline_state")!;

    const startRes = parse(await start({
      feature_description: "OAuth login for the mobile app",
      skip_preflight: true,
    }));
    const runId = startRes.run_id as string;

    const actionRes = parse(
      await getState({ run_id: runId, format: "action" }),
    );
    expect(actionRes.run_id).toBe(runId);
    // The cached action matches what start_pipeline itself returned.
    expect(actionRes.action).toEqual(startRes.action);
    // A single-step action fits on one page; the page marker says so.
    expect(actionRes.__page).toMatchObject({ offset: 0, next_offset: null, budget_chars: 100_000 });
  });

  it("format:'action' with an invocation_offset past the last action returns a structured error", async () => {
    const start = handlers.get("start_pipeline")!;
    const getState = handlers.get("get_pipeline_state")!;
    const runId = parse(await start({
      feature_description: "OAuth login for the mobile app",
      skip_preflight: true,
    })).run_id as string;
    const res = await getState({ run_id: runId, format: "action", invocation_offset: 10_000 });
    expect(res.isError).toBe(true);
    expect(parse(res).error).toContain("out of range");
  });

  it("format:'action' on an unknown run_id returns a structured error, not a crash", async () => {
    const getState = handlers.get("get_pipeline_state")!;
    const res = await getState({ run_id: "run_never_started", format: "action" });
    expect(res.isError).toBe(true);
    const body = parse(res);
    expect(body.error).toContain("unknown run_id");
  });
});
