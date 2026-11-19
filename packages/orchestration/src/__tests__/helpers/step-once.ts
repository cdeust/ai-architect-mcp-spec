import { step, type ActionResult, type PipelineState } from "../../index.js";

export function stepOnce(state: PipelineState, result?: ActionResult) {
  return step({ state, result });
}
