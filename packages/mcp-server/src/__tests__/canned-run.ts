/**
 * Every (state, action) pair of one canned pipeline run, for the tests of
 * what the server keeps of a run (#121). The reducer is pure: no server and
 * no file is involved.
 */
import {
  makeCannedDispatcher,
  newPipelineState,
  step,
  type ActionResult,
  type NextAction,
  type PipelineState,
} from "@prd-gen/orchestration";

export interface RunStep {
  readonly state: PipelineState;
  readonly action: NextAction;
}

/**
 * precondition:  `runId` is of the form `start_pipeline` generates.
 * postcondition: the steps of a canned run under that id, in order; the last
 *                one is the finished run (`current_step === "complete"`).
 */
export function cannedRun(runId: string): readonly RunStep[] {
  const dispatch = makeCannedDispatcher({ freeform_answer: "answer", graph_path: "/tmp/canned/graph" });
  let state = newPipelineState({
    run_id: runId,
    feature_description: "build a feature for OAuth login",
    skip_preflight: true,
  });
  let result: ActionResult | undefined = undefined;
  const steps: RunStep[] = [];
  for (let count = 0; count < 300; count++) {
    const out = step({ state, result });
    state = out.state;
    steps.push({ state, action: out.action });
    result = dispatch(out.action);
    if (result === undefined) break;
  }
  return steps;
}
