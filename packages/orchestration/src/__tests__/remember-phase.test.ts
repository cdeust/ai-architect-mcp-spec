/**
 * finalize — Cortex `remember`, run once per pipeline immediately before the
 * terminal `done` action. Relocated (PR 3b, design-phases-3-5.md §2.2) from
 * self-check.ts's Phase C to handlers/finalize.ts — self_check's finalize()
 * now only sets `pending_completion` and advances to `implementation_gate`;
 * `finalize` (this module) performs the remember round trip once the
 * implementation-gate/pre-impl-grounding path converges back to it.
 *
 * Proves:
 *   1. Answering implementation_gate with "PRD only" advances straight to
 *      `finalize`, which emits call_cortex_tool[remember] BEFORE `done`,
 *      with a self-contained content string (feature, PRD context, section
 *      counts, the self-check/judge summary, and every exported file path
 *      as a verifiable reference) plus tags + source.
 *   2. A successful result sets run_remembered and returns the EXACT `done`
 *      action that self_check's finalize() computed (same
 *      summary/artifacts/verification).
 *   3. A failed result (Cortex unreachable) records an upstream_failure
 *      error but still returns `done` — remember is best-effort and must
 *      never block completion.
 *   4. An empty-but-successful result (data: {}) behaves like any other
 *      success — run_remembered set, `done` returned.
 *
 * source: Phase 1b (2026-07-14) — Cortex memory-loop closure (original Phase
 * C). source: design-phases-3-5.md §2.2 — relocation (PR 3b).
 */

import { describe, expect, it } from "vitest";
import { newPipelineState, step, type PipelineState } from "../index.js";
import { resolveImplementationGatePrdOnly } from "./helpers/resolve-completion.js";

/** Must match handlers/finalize.ts:REMEMBER_CORRELATION_ID. */
const REMEMBER_CORRELATION_ID = "self_check_remember";

function stateAtSelfCheck(): PipelineState {
  const s = newPipelineState({
    run_id: "remember_001",
    feature_description: "OAuth login for the mobile app",
  });
  return {
    ...s,
    current_step: "self_check",
    prd_context: "feature",
    // Empty sections → judge phase short-circuits to finalize immediately,
    // isolating Phase C from Phase A/B behaviour.
    sections: [],
    written_files: [
      "prd-output/remember_001/01-prd.md",
      "prd-output/remember_001/02-data-model.md",
    ],
  };
}

/**
 * Drives self_check's finalize() → implementation_gate → "PRD only" → the
 * first `finalize` step() output (the call_cortex_tool[remember] emission).
 */
function issuedRemember(): ReturnType<typeof step> {
  const afterSelfCheck = step({ state: stateAtSelfCheck() });
  return resolveImplementationGatePrdOnly(afterSelfCheck);
}

describe("finalize — remember (nominal)", () => {
  it("emits call_cortex_tool[remember] with a self-contained content string, before done", () => {
    const out = issuedRemember();

    expect(out.action.kind).toBe("call_cortex_tool");
    if (out.action.kind !== "call_cortex_tool") return;
    expect(out.action.tool_name).toBe("remember");
    expect(out.action.correlation_id).toBe(REMEMBER_CORRELATION_ID);

    const args = out.action.arguments as {
      content?: string;
      tags?: string[];
      source?: string;
    };
    expect(typeof args.content).toBe("string");
    expect(args.content).toContain("OAuth login for the mobile app");
    expect(args.content).toContain("feature");
    // Exported file paths are the verifiable references.
    expect(args.content).toContain("prd-output/remember_001/01-prd.md");
    expect(args.content).toContain("prd-output/remember_001/02-data-model.md");
    expect(args.tags).toContain("prd-gen");
    expect(args.source).toBe("prd-gen:self_check");

    // Not yet complete — waiting on the remember round trip.
    expect(out.state.run_remembered).toBe(false);
    expect(out.state.pending_completion).not.toBeNull();
    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.decision).toBe("prd_only");
  });

  it("successful remember result returns the SAME done payload finalize computed, marks run_remembered", () => {
    const issued = issuedRemember();
    const cid =
      issued.action.kind === "call_cortex_tool" ? issued.action.correlation_id : "";
    const pendingSummary = issued.state.pending_completion?.summary ?? "";
    // What a version that did not know the size kept: no line for it.
    expect(pendingSummary).not.toContain("Request size");

    const out = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: cid,
        success: true,
        data: { stored: true, memory_id: 42 },
      },
    });

    expect(out.state.run_remembered).toBe(true);
    expect(out.state.pending_completion).toBeNull();
    expect(out.state.current_step).toBe("complete");
    expect(out.action.kind).toBe("done");
    if (out.action.kind === "done") {
      // The summary of the self-check, with the size of the run on its
      // second line: written when the run finishes, from its state, so a
      // run checkpointed before the size existed says it too.
      const [headline, ...rest] = pendingSummary.split("\n");
      expect(out.action.summary).toBe([headline, "Request size: standard.", ...rest].join("\n"));
    }
    // The fact kept in Cortex carries the same summary.
    if (issued.action.kind === "call_cortex_tool") {
      expect(String(issued.action.arguments.content)).toContain("\nRequest size: standard.\nSections: ");
    }
  });

  it("replay before the remember result arrives re-issues the SAME call (idempotent)", () => {
    // pending_completion is set, run_remembered is still false (the only
    // reachable "waiting" state — emitRememberOrDone always clears
    // pending_completion in the SAME step that sets run_remembered=true, so
    // the two flags are never simultaneously true+non-null on real state).
    const issued = issuedRemember();
    const replayed = step({ state: issued.state });
    expect(replayed.action.kind).toBe("call_cortex_tool");
    if (replayed.action.kind !== "call_cortex_tool") return;
    expect(replayed.action.correlation_id).toBe(REMEMBER_CORRELATION_ID);
    expect(replayed.state.run_remembered).toBe(false);
  });
});

describe("finalize — remember (Cortex unavailable)", () => {
  it("failed remember: records upstream_failure but still returns done", () => {
    const issued = issuedRemember();
    const cid =
      issued.action.kind === "call_cortex_tool" ? issued.action.correlation_id : "";

    const out = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: cid,
        success: false,
        data: null,
        error: "cortex MCP unreachable",
      },
    });

    expect(out.state.run_remembered).toBe(true);
    expect(
      out.state.errors.some((e) => e.includes("remember failed")),
    ).toBe(true);
    expect(
      out.state.error_kinds[out.state.errors.length - 1],
    ).toBe("upstream_failure");
    // The run still completes — remember failure never blocks done.
    expect(out.action.kind).toBe("done");
    expect(out.state.current_step).toBe("complete");
  });
});

describe("finalize — remember (empty/no-op result)", () => {
  it("success with empty data ({}) behaves like any other success", () => {
    const issued = issuedRemember();
    const cid =
      issued.action.kind === "call_cortex_tool" ? issued.action.correlation_id : "";

    const out = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: cid,
        success: true,
        data: {},
      },
    });

    expect(out.state.run_remembered).toBe(true);
    expect(out.state.errors.length).toBe(0);
    expect(out.action.kind).toBe("done");
  });
});
