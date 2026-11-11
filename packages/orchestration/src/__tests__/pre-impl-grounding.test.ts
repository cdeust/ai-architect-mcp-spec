/**
 * `pre_impl_grounding` — PRE-implementation blast-radius grounding.
 *
 * Proves:
 *   1. No codebase_graph_path → skips cleanly, advances to `implementation`
 *      (emit_message, impact_queries.done = true, no call_pipeline_tool).
 *   2. No affected_symbols_path (no sidecar exported — zero claims) → same
 *      clean skip, even with a graph present.
 *   3. With a graph + a technical_specification affected-symbols block,
 *      emits ONE call_pipeline_tool[get_impact] per distinct qualified_name,
 *      cursor-driven — one round trip per symbol, in order.
 *   4. A get_impact success is recorded in
 *      post_specs.impact_queries.results and the cursor advances.
 *   5. A get_impact failure DEGRADES: appendError(upstream_failure), the
 *      failing symbol's result entry is kept (success:false), and the
 *      cursor still advances to the next symbol — no run-abort.
 *   6. More than IMPACT_QUERY_SYMBOL_CAP distinct symbols are truncated to
 *      the cap; symbols beyond the cap are never queried.
 *   7. Once every (capped) symbol has been queried, advances to
 *      `implementation` with impact_queries.done = true.
 *
 * source: design-phases-3-5.md §1, §3, §4.
 */

import { describe, expect, it } from "vitest";
import { newPipelineState, step, type PipelineState } from "../index.js";

/** Must match handlers/protocol-ids.ts:PRE_IMPL_GROUNDING_IMPACT_PREFIX. */
const IMPACT_PREFIX = "pre_impl_grounding_impact_";
/** Must match handlers/pre-impl-grounding.ts:IMPACT_QUERY_SYMBOL_CAP. */
const IMPACT_QUERY_SYMBOL_CAP = 10;

function affectedSymbolsBlock(qualifiedNames: readonly string[]): string {
  return [
    "## Technical Specification",
    "",
    "We use ports-and-adapters architecture.",
    "",
    "<!-- AFFECTED_SYMBOLS_JSON -->",
    "```json",
    JSON.stringify({
      affected_symbols: qualifiedNames.map((qn) => ({
        qualified_name: qn,
        change_kind: "modify",
      })),
    }),
    "```",
  ].join("\n");
}

function stateAtGrounding(opts: {
  graphPath?: string | null;
  sidecarPath?: string | null;
  qualifiedNames?: readonly string[];
}): PipelineState {
  const s = newPipelineState({
    run_id: "pre_impl_001",
    feature_description: "OAuth login",
  });
  const qualifiedNames = opts.qualifiedNames ?? [];
  return {
    ...s,
    current_step: "pre_impl_grounding",
    codebase_graph_path: opts.graphPath ?? null,
    affected_symbols_path: opts.sidecarPath ?? null,
    sections:
      qualifiedNames.length > 0
        ? [
            {
              section_type: "technical_specification",
              status: "passed",
              attempt: 1,
              violation_count: 0,
              last_violations: [],
              content: affectedSymbolsBlock(qualifiedNames),
            },
          ]
        : [],
  };
}

describe("pre_impl_grounding — clean skip conditions", () => {
  it("no graph_path → skips to implementation without a call_pipeline_tool", () => {
    const out = step({
      state: stateAtGrounding({
        graphPath: null,
        sidecarPath: "prd-output/x/stage-5.affected_symbols.json",
        qualifiedNames: ["src/main.rs::handle"],
      }),
    });
    expect(out.action.kind).not.toBe("call_pipeline_tool");
    expect(out.state.current_step).toBe("implementation");
    expect(out.state.post_specs?.impact_queries.done).toBe(true);
    expect(out.state.post_specs?.impact_queries.results).toEqual([]);
  });

  it("no sidecar exported (affected_symbols_path null) → skips even with a graph", () => {
    const out = step({
      state: stateAtGrounding({
        graphPath: "/g/graph",
        sidecarPath: null,
      }),
    });
    expect(out.action.kind).not.toBe("call_pipeline_tool");
    expect(out.state.current_step).toBe("implementation");
    expect(out.state.post_specs?.impact_queries.done).toBe(true);
  });
});

describe("pre_impl_grounding — failed technical_specification draft (#122)", () => {
  function withFailedTechSpec(): PipelineState {
    const s = stateAtGrounding({
      graphPath: "/g/graph",
      // A stale path must not re-open the gate: the draft itself is the source.
      sidecarPath: "prd-output/x/stage-5.affected_symbols.json",
      qualifiedNames: ["src/main.rs::handle"],
    });
    return {
      ...s,
      sections: s.sections.map((section) => ({ ...section, status: "failed" as const })),
    };
  }

  it("queries no get_impact for the symbols of a failed draft", () => {
    const out = step({ state: withFailedTechSpec() });
    expect(out.action.kind).not.toBe("call_pipeline_tool");
    expect(out.state.current_step).toBe("implementation");
    expect(out.state.post_specs?.impact_queries.done).toBe(true);
    expect(out.state.post_specs?.impact_queries.results).toEqual([]);
  });

  it("says the grounding was skipped because the section failed validation", () => {
    const out = step({ state: withFailedTechSpec() });
    expect(out.messages.map((m) => m.text).join("\n")).toContain(
      "Technical Specification section failed validation",
    );
  });
});

describe("pre_impl_grounding — cursor loop over affected symbols", () => {
  it("emits one get_impact call per distinct qualified_name, in order", () => {
    const seed = stateAtGrounding({
      graphPath: "/g/graph",
      sidecarPath: "prd-output/x/stage-5.affected_symbols.json",
      qualifiedNames: ["src/a.ts::foo", "src/b.ts::bar"],
    });
    const first = step({ state: seed });
    expect(first.action.kind).toBe("call_pipeline_tool");
    if (first.action.kind !== "call_pipeline_tool") return;
    expect(first.action.tool_name).toBe("get_impact");
    expect(first.action.arguments).toEqual({
      graph_path: "/g/graph",
      qualified_name: "src/a.ts::foo",
    });
    expect(first.action.correlation_id).toBe(`${IMPACT_PREFIX}0`);
    // Still at pre_impl_grounding, cursor not yet advanced.
    expect(first.state.current_step).toBe("pre_impl_grounding");
    expect(first.state.post_specs?.impact_queries.index).toBe(0);
  });

  it("records a successful result and advances the cursor to the next symbol", () => {
    const seed = stateAtGrounding({
      graphPath: "/g/graph",
      sidecarPath: "prd-output/x/stage-5.affected_symbols.json",
      qualifiedNames: ["src/a.ts::foo", "src/b.ts::bar"],
    });
    const issued = step({ state: seed });
    const cid = issued.action.kind === "call_pipeline_tool" ? issued.action.correlation_id : "";

    const afterFirst = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: cid,
        success: true,
        data: { callers: ["src/z.ts::caller"] },
      },
    });

    expect(afterFirst.state.post_specs?.impact_queries.index).toBe(1);
    expect(afterFirst.state.post_specs?.impact_queries.results).toEqual([
      { qualified_name: "src/a.ts::foo", success: true, data: { callers: ["src/z.ts::caller"] } },
    ]);
    // Second symbol's call is now emitted.
    expect(afterFirst.action.kind).toBe("call_pipeline_tool");
    if (afterFirst.action.kind !== "call_pipeline_tool") return;
    expect(afterFirst.action.arguments).toEqual({
      graph_path: "/g/graph",
      qualified_name: "src/b.ts::bar",
    });
    expect(afterFirst.action.correlation_id).toBe(`${IMPACT_PREFIX}1`);
  });

  it("a get_impact failure degrades: records the failure, appends upstream_failure, advances the cursor anyway", () => {
    const seed = stateAtGrounding({
      graphPath: "/g/graph",
      sidecarPath: "prd-output/x/stage-5.affected_symbols.json",
      qualifiedNames: ["src/a.ts::foo", "src/b.ts::bar"],
    });
    const issued = step({ state: seed });
    const cid = issued.action.kind === "call_pipeline_tool" ? issued.action.correlation_id : "";

    const afterFailure = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: cid,
        success: false,
        data: null,
        error: "graph not found",
      },
    });

    expect(afterFailure.state.post_specs?.impact_queries.index).toBe(1);
    expect(afterFailure.state.post_specs?.impact_queries.results).toEqual([
      { qualified_name: "src/a.ts::foo", success: false, error: "graph not found" },
    ]);
    expect(
      afterFailure.state.errors.some((e) => e.includes("get_impact failed for 'src/a.ts::foo'")),
    ).toBe(true);
    expect(afterFailure.state.error_kinds[afterFailure.state.errors.length - 1]).toBe(
      "upstream_failure",
    );
    // The loop continues — the run is never aborted by a get_impact failure.
    expect(afterFailure.action.kind).toBe("call_pipeline_tool");
  });

  it("once every symbol is queried, advances to implementation with impact_queries.done", () => {
    const seed = stateAtGrounding({
      graphPath: "/g/graph",
      sidecarPath: "prd-output/x/stage-5.affected_symbols.json",
      qualifiedNames: ["src/a.ts::foo"],
    });
    const issued = step({ state: seed });
    const cid = issued.action.kind === "call_pipeline_tool" ? issued.action.correlation_id : "";

    const out = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: cid,
        success: true,
        data: {},
      },
    });

    expect(out.state.current_step).toBe("implementation");
    expect(out.state.post_specs?.impact_queries.done).toBe(true);
    expect(out.state.post_specs?.impact_queries.results.length).toBe(1);
    expect(out.action.kind).not.toBe("call_pipeline_tool");
  });
});

describe("pre_impl_grounding — dedup + cap", () => {
  it("deduplicates repeated qualified_name claims", () => {
    const seed = stateAtGrounding({
      graphPath: "/g/graph",
      sidecarPath: "prd-output/x/stage-5.affected_symbols.json",
      qualifiedNames: ["src/a.ts::foo", "src/a.ts::foo", "src/b.ts::bar"],
    });
    const out = step({ state: seed });
    expect(out.action.kind).toBe("call_pipeline_tool");
    if (out.action.kind !== "call_pipeline_tool") return;
    expect(out.action.arguments.qualified_name).toBe("src/a.ts::foo");
  });

  it(`caps at ${IMPACT_QUERY_SYMBOL_CAP} symbols — beyond-cap symbols are never queried`, () => {
    const names = Array.from({ length: IMPACT_QUERY_SYMBOL_CAP + 5 }, (_, i) => `src/f${i}.ts::sym`);
    let state = stateAtGrounding({
      graphPath: "/g/graph",
      sidecarPath: "prd-output/x/stage-5.affected_symbols.json",
      qualifiedNames: names,
    });

    const queried: string[] = [];
    for (let i = 0; i < IMPACT_QUERY_SYMBOL_CAP + 1; i++) {
      const out = step({ state });
      if (out.action.kind !== "call_pipeline_tool") {
        state = out.state;
        break;
      }
      queried.push(out.action.arguments.qualified_name as string);
      state = step({
        state: out.state,
        result: {
          kind: "tool_result",
          correlation_id: out.action.correlation_id,
          success: true,
          data: {},
        },
      }).state;
    }

    expect(queried.length).toBe(IMPACT_QUERY_SYMBOL_CAP);
    expect(queried).toEqual(names.slice(0, IMPACT_QUERY_SYMBOL_CAP));
    expect(queried).not.toContain(names[IMPACT_QUERY_SYMBOL_CAP]);
    expect(state.current_step).toBe("implementation");
    expect(state.post_specs?.impact_queries.results.length).toBe(IMPACT_QUERY_SYMBOL_CAP);
  });
});
