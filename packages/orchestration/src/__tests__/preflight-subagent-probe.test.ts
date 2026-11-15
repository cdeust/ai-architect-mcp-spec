/**
 * The preflight checks that the host can start a zetetic-team-subagents
 * subagent before the run depends on one.
 *
 * Proves:
 *   1. After the Cortex probe (and the ai-architect-mcp-codebase probe when a
 *      codebase path is given), the preflight emits one `spawn_subagents`
 *      action with a single `zetetic-team-subagents:engineer` invocation,
 *      under the cheapest model and effort the action can ask for.
 *   2. A response with an error, with no text, or no response at all stops
 *      the run at `preflight` on a `failed` action that carries the host's
 *      answer, names the plugin, says there is no degraded mode and gives
 *      the install commands the README documents.
 *   3. A response with text passes the preflight and moves the run to
 *      context detection.
 *   4. `skip_preflight: true` skips this probe as it skips the others.
 *
 * source: #123 (decision of 2026-11-13: probe by starting one subagent of
 * the plugin rather than adding an action kind).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  handlePreflight,
  PREFLIGHT_SUBAGENT_PROBE_TYPE,
} from "../handlers/preflight.js";
import { PREFLIGHT_SUBAGENT_PROBE_ID } from "../handlers/protocol-ids.js";
import { newPipelineState, type PipelineState } from "../index.js";
import type { ActionResult } from "../types/actions.js";

type Input = Parameters<typeof handlePreflight>[0];

const README = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../README.md"),
  "utf8",
);

function atPreflight(codebasePath: string | null = null): PipelineState {
  const seed = newPipelineState({
    run_id: "preflight_subagent_001",
    feature_description: "build OAuth login",
    codebase_path: codebasePath,
  });
  return { ...seed, current_step: "preflight" };
}

function ok(correlation: string): ActionResult {
  return { kind: "tool_result", correlation_id: correlation, success: true, data: {} };
}

function run(state: PipelineState, result?: ActionResult) {
  return handlePreflight({ state, result } as Input);
}

/** Drive the preflight through its MCP probes; return the state and action after them. */
function throughMcpProbes(codebasePath: string | null) {
  let out = run(atPreflight(codebasePath));
  out = run(out.state, ok("preflight_cortex_probe"));
  if (codebasePath !== null) {
    out = run(out.state, ok("preflight_ai_architect_probe"));
  }
  return out;
}

function probeAnswer(
  state: PipelineState,
  response: { raw_text?: string; error?: string } | null,
) {
  return run(state, {
    kind: "subagent_batch_result",
    batch_id: PREFLIGHT_SUBAGENT_PROBE_ID,
    responses:
      response === null
        ? []
        : [{ invocation_id: PREFLIGHT_SUBAGENT_PROBE_ID, ...response }],
  });
}

describe("preflight zetetic-team-subagents probe", () => {
  it.each([
    ["without a codebase", null],
    ["with a codebase", "/tmp/repo"],
  ])("is the last probe %s: one engineer invocation, cheapest model and effort", (_label, codebase) => {
    const out = throughMcpProbes(codebase);
    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") return;
    expect(out.action.batch_id).toBe(PREFLIGHT_SUBAGENT_PROBE_ID);
    expect(out.action.purpose).toBe("probe");
    expect(out.action.invocations).toHaveLength(1);
    const [inv] = out.action.invocations;
    expect(inv?.subagent_type).toBe("zetetic-team-subagents:engineer");
    expect(inv?.subagent_type).toBe(PREFLIGHT_SUBAGENT_PROBE_TYPE);
    expect(inv?.model).toBe("haiku");
    expect(inv?.effort).toBe("low");
    expect(inv?.prompt.split("\n")).toHaveLength(1);
    expect(out.state.preflight_status).not.toBe("ok");
  });

  it.each([
    ["an error", { error: "Agent type 'zetetic-team-subagents:engineer' not found" }, "not found"],
    ["an empty text", { raw_text: "   " }, "an empty response"],
    ["no text and no error", {}, "an empty response"],
    ["no response", null, "no response for the probe invocation"],
  ])("stops the run at preflight when the host returns %s", (_label, response, expected) => {
    const out = probeAnswer(throughMcpProbes(null).state, response);
    expect(out.action.kind).toBe("failed");
    if (out.action.kind !== "failed") return;
    expect(out.action.step).toBe("preflight");
    expect(out.action.reason).toContain("zetetic-team-subagents");
    expect(out.action.reason).toContain(expected);
    expect(out.action.reason).toMatch(/no degraded mode/);
    expect(out.state.preflight_status).not.toBe("ok");
    expect(out.state.error_kinds.at(-1)).toBe("upstream_failure");
  });

  it("gives the install commands the README documents", () => {
    const out = probeAnswer(throughMcpProbes(null).state, { error: "boom" });
    if (out.action.kind !== "failed") throw new Error("expected failed");
    const commands = out.action.reason
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\/plugin (marketplace add|install) /.test(line))
      .map((line) => `claude ${line.slice(1)}`);
    expect(commands).toEqual([
      "claude plugin marketplace add cdeust/zetetic-team-subagents",
      "claude plugin install zetetic-team-subagents@zetetic-marketplace",
    ]);
    for (const command of commands) expect(README).toContain(command);
  });

  it.each([
    ["without a codebase", null],
    ["with a codebase", "/tmp/repo"],
  ])("passes the preflight %s when the subagent answers", (_label, codebase) => {
    const out = probeAnswer(throughMcpProbes(codebase).state, { raw_text: "ready" });
    expect(out.state.preflight_status).toBe("ok");
    expect(out.state.current_step).toBe("context_detection");
    expect(out.action.kind).toBe("emit_message");
  });

  it("is skipped with skip_preflight: true", () => {
    const seed = newPipelineState({
      run_id: "preflight_subagent_skip",
      feature_description: "build OAuth login",
      skip_preflight: true,
    });
    const out = run({ ...seed, current_step: "preflight" });
    expect(out.action.kind).not.toBe("spawn_subagents");
    expect(out.state.current_step).toBe("context_detection");
  });
});
