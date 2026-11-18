/**
 * A PRD context the host declares at start_pipeline (#119, slice 3).
 *
 * The host sizes the run from the verification the request needs (it may
 * ask its advisor model) and passes the context; the server keeps it, reads
 * no trigger word and asks no context question. The rounds and sections are
 * the calibrated ones of PRD_CONTEXT_CONFIGS: the host picks a size, it sets
 * no number.
 *
 * source: #119, owner comment of 2026-11-18: "/workflow is supposed to be
 * sized based on the verification needed and /advisor can already give the
 * information needed".
 */

import { describe, expect, it } from "vitest";
import { PRD_CONTEXT_CONFIGS } from "@prd-gen/core";
import { newPipelineState, step } from "../index.js";
import type { PipelineState } from "../index.js";

function atContextDetection(
  feature_description: string,
  prd_context?: PipelineState["prd_context"],
): PipelineState {
  return {
    ...newPipelineState({ run_id: "host_ctx", feature_description, prd_context }),
    current_step: "context_detection",
  };
}

describe("host-declared PRD context (#119)", () => {
  it("keeps the declared context over the trigger words of the description", () => {
    // "build" and "feature" would detect `feature` (8 to 10 rounds).
    const out = step({ state: atContextDetection("build a feature: copy button", "tiny") });
    expect(out.state.prd_context).toBe("tiny");
    expect(out.state.current_step).not.toBe("context_detection");
  });

  it("asks no context question for a description that names no trigger", () => {
    const out = step({ state: atContextDetection("something unclassifiable", "incident") });
    expect(out.state.prd_context).toBe("incident");
    // context_detection keeps the declared context and announces it; the
    // runner coalesces that message and steps past, so no ask_user follows.
    expect(out.messages.map((m) => m.text)).toContain(
      `PRD context: ${PRD_CONTEXT_CONFIGS.incident.displayName}`,
    );
    expect(out.action.kind).not.toBe("ask_user");
  });

  it("detects from the description when the host declares nothing", () => {
    expect(step({ state: atContextDetection("build a feature: copy button") }).state.prd_context).toBe("feature");
    expect(step({ state: atContextDetection("build a feature: copy button", null) }).state.prd_context).toBe("feature");
  });
});
