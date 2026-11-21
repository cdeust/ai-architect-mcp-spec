/** PRD-only generation reaches completion without delegating implementation. */
import { describe, expect, it } from "vitest";
import {
  makeCannedDispatcher,
  newPipelineState,
  step,
  type ActionResult,
  type NextAction,
  type PipelineState,
} from "../index.js";

const SAFETY_CAP = 200;

function runSmoke(
  seed: Readonly<PipelineState>,
  dispatch: (action: NextAction) => ActionResult | undefined,
) {
  let state: PipelineState = seed;
  let pendingResult: ActionResult | undefined = undefined;
  const observedToolNames: string[] = [];

  for (let i = 0; i < SAFETY_CAP; i++) {
    const out = step({ state, result: pendingResult });
    state = out.state;
    if (out.action.kind === "call_pipeline_tool") {
      observedToolNames.push(out.action.tool_name);
    }
    if (out.action.kind === "done" || out.action.kind === "failed") {
      return { finalAction: out.action, finalState: state, observedToolNames };
    }
    pendingResult = dispatch(out.action);
    if (pendingResult === undefined) {
      throw new Error(`Harness produced no result for action.kind=${out.action.kind}`);
    }
  }
  throw new Error(`Smoke run exceeded safety cap (${SAFETY_CAP} iterations)`);
}

describe("implementation_gate — PRD-only smoke path (zero regression)", () => {
  it("reaches done without ever emitting get_impact", () => {
    const dispatch = makeCannedDispatcher({
      freeform_answer: "smoke-gate-answer",
      graph_path: "/tmp/smoke-gate/.prd-gen/graphs/smoke/graph",
      implementation_gate_answer: "PRD only",
    });
    const seed = newPipelineState({
      run_id: "smoke_gate_prd_only",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/smoke-gate",
    });

    const result = runSmoke(seed, dispatch);

    expect(result.finalAction.kind).toBe("done");
    expect(result.finalState.current_step).toBe("complete");
    expect(result.finalState.post_specs?.decision).toBe("prd_only");
    expect(result.observedToolNames).not.toContain("get_impact");
  });
});
