/**
 * Preflight — verify required MCP servers are reachable BEFORE the pipeline
 * begins to depend on them.
 *
 * The pipeline relies on two ecosystem MCPs and one plugin at runtime:
 *   - cortex            (call_cortex_tool: per-section memory recall)
 *   - ai-architect      (call_pipeline_tool: analyze_codebase, when a
 *                        codebase path is supplied)
 *   - zetetic-team-subagents (spawn_subagents: every subagent type of the
 *                        generation and verification steps)
 *
 * Without preflight, a missing Cortex meant the host returned
 * `success: false` for every section's recall step — silent per-section
 * degradation that surfaced only as an unexplained drop in section
 * quality. With preflight, the same condition surfaces ONCE at startup as
 * a single `failed` action with actionable setup instructions.
 *
 * The check uses the lightest available probe per MCP — Cortex's
 * `memory_stats` (a read-only diagnostic that returns immediately on a
 * healthy server) and ai-architect's `health_check`. When the host
 * returns `success: false`, we treat that as "MCP not registered or
 * unreachable" and emit a `failed` action.
 *
 * The plugin is checked last by starting one subagent of it: a single
 * `zetetic-team-subagents:engineer` invocation (the first type a run needs,
 * for clarification) with a one-line prompt, under the cheapest model and
 * effort the action can ask for. A response with an `error`, or with no
 * text, stops the run here with the host's own answer and the install
 * commands; there is no degraded mode for this plugin. `spawn_subagents` is
 * an action every host already executes, so the probe adds no action kind.
 * source: #123 (decision of 2026-11-13). It does not tell a missing plugin
 * from a host that failed to start a subagent for another reason: the
 * message carries the host's text either way.
 *
 * Callers that intentionally run without Cortex can pass
 * `skip_preflight: true` to `newPipelineState` (or `start_pipeline`),
 * which marks `preflight_status = "skipped"` at construction and lets
 * this handler short-circuit on the first call.
 *
 * source: missing-Cortex bug found 2026-04-26 during the wiki-grooming
 * PRD run on the Cortex repo. Cortex was disabled in user settings; the
 * pipeline silently dropped recall context for every section, and
 * Technical Specification quality cratered without anyone noticing the
 * load-bearing dependency had vanished.
 */

import type { StepHandler } from "../runner.js";
import type { SubagentBatchResult } from "../types/actions.js";
import { appendError, type PipelineState } from "../types/state.js";
import { PREFLIGHT_SUBAGENT_PROBE_ID } from "./protocol-ids.js";

type StepHandlerOutput = ReturnType<StepHandler>;

const CORTEX_PROBE_CORRELATION = "preflight_cortex_probe";
const AI_ARCHITECT_PROBE_CORRELATION = "preflight_ai_architect_probe";

/** The subagent type the probe starts: the first one a run needs (clarification). */
export const PREFLIGHT_SUBAGENT_PROBE_TYPE = "zetetic-team-subagents:engineer";

function adviseCortexInstall(): string {
  return [
    "Cortex MCP not reachable.",
    "",
    "The pipeline relies on Cortex for per-section memory recall during",
    "section generation. Without it, every section is drafted without",
    "prior-decision context — generation quality degrades silently.",
    "",
    "To install:",
    "  /plugin marketplace add cdeust/Cortex",
    "  /plugin install hypermnesia-mcp@cortex-plugins",
    "  /reload-plugins",
    "",
    "If you genuinely want to run without Cortex, re-invoke",
    "start_pipeline with skip_preflight: true (degraded mode).",
  ].join("\n");
}

function adviseAiArchitectInstall(): string {
  return [
    "ai-architect-mcp-codebase (ai-architect) MCP not reachable.",
    "",
    "A codebase_path was supplied, which requires the ai-architect-mcp-codebase",
    "MCP for analyze_codebase + downstream graph queries.",
    "",
    "To install:",
    "  /plugin marketplace add cdeust/ai-architect-mcp-codebase",
    "  /plugin install ai-architect-mcp-codebase@ai-architect-mcp-codebase-marketplace",
    "  /reload-plugins",
    "",
    "If you only need PRD generation without codebase analysis, omit",
    "codebase_path on the next start_pipeline call.",
  ].join("\n");
}

function adviseSubagentsInstall(hostAnswer: string): string {
  return [
    "zetetic-team-subagents could not start a subagent.",
    "",
    `The host answered the ${PREFLIGHT_SUBAGENT_PROBE_TYPE} probe with: ${hostAnswer}`,
    "",
    "zetetic-team-subagents provides every subagent type of the pipeline:",
    "the engineer for clarification, section drafts and JIRA tickets, the",
    "genius and team judges for verification, and the git-historian when a",
    "codebase is given. There is no degraded mode without it.",
    "",
    "To install:",
    "  /plugin marketplace add cdeust/zetetic-team-subagents",
    "  /plugin install zetetic-team-subagents@zetetic-marketplace",
    "  /reload-plugins",
  ].join("\n");
}

/**
 * postcondition: the one-invocation spawn_subagents action of the
 *                zetetic-team-subagents probe; state unchanged.
 */
function subagentProbe(state: PipelineState): StepHandlerOutput {
  return {
    state,
    action: {
      kind: "spawn_subagents",
      purpose: "probe",
      batch_id: PREFLIGHT_SUBAGENT_PROBE_ID,
      invocations: [
        {
          invocation_id: PREFLIGHT_SUBAGENT_PROBE_ID,
          subagent_type: PREFLIGHT_SUBAGENT_PROBE_TYPE,
          description: "Preflight: check zetetic-team-subagents is installed",
          prompt: "Preflight check of the PRD pipeline. Reply with the single word: ready",
          isolation: "none",
          model: "haiku",
          effort: "low",
        },
      ],
    },
  };
}

/**
 * The host's answer when the probe failed, or null when it returned text.
 * A missing response counts as a failure: the host did not run the probe.
 */
function subagentProbeFailure(result: SubagentBatchResult): string | null {
  const response = result.responses.find(
    (r) => r.invocation_id === PREFLIGHT_SUBAGENT_PROBE_ID,
  );
  if (response === undefined) return "no response for the probe invocation";
  if (response.error !== undefined && response.error.trim() !== "") {
    return response.error;
  }
  if (response.raw_text === undefined || response.raw_text.trim() === "") {
    return "an empty response";
  }
  return null;
}

/**
 * postcondition: a failed action at `preflight` naming the plugin when the
 *                probe failed; otherwise preflight_status "ok" and the run
 *                moves to context_detection.
 */
function concludeSubagentProbe(
  state: PipelineState,
  result: SubagentBatchResult,
): StepHandlerOutput {
  const failure = subagentProbeFailure(result);
  if (failure !== null) {
    return {
      state: appendError(
        state,
        `preflight: zetetic-team-subagents probe failed (${failure})`,
        "upstream_failure",
      ),
      action: {
        kind: "failed",
        reason: adviseSubagentsInstall(failure),
        step: "preflight",
      },
    };
  }
  const companions = state.codebase_path
    ? "Cortex + ai-architect reachable"
    : "Cortex reachable (no codebase → ai-architect probe skipped)";
  return {
    state: {
      ...state,
      preflight_status: "ok",
      current_step: "context_detection",
    },
    action: {
      kind: "emit_message",
      message: `Preflight passed: ${companions}; zetetic-team-subagents started a subagent.`,
    },
  };
}

export const handlePreflight: StepHandler = ({ state, result }) => {
  // Skipped at construction time → fall through with a one-line message.
  if (state.preflight_status === "skipped") {
    return {
      state: { ...state, current_step: "context_detection" },
      action: {
        kind: "emit_message",
        message:
          "Preflight skipped (skip_preflight=true). Section generation will proceed without Cortex recall context if Cortex is unavailable.",
        level: "warn",
      },
    };
  }

  // Already passed preflight on a prior step (replay safety).
  if (state.preflight_status === "ok") {
    return {
      state: { ...state, current_step: "context_detection" },
      action: {
        kind: "emit_message",
        message: "Preflight already passed. Proceeding to context detection.",
      },
    };
  }

  // Stage 1: Cortex probe result.
  if (
    result?.kind === "tool_result" &&
    result.correlation_id === CORTEX_PROBE_CORRELATION
  ) {
    if (!result.success) {
      return {
        state: appendError(
          state,
          `preflight: cortex unreachable (${result.error ?? "unknown error"})`,
          "upstream_failure",
        ),
        action: {
          kind: "failed",
          reason: adviseCortexInstall(),
          step: "preflight",
        },
      };
    }
    // Cortex passed. If a codebase was supplied, probe ai-architect next.
    if (state.codebase_path) {
      return {
        state,
        action: {
          kind: "call_pipeline_tool",
          tool_name: "health_check",
          arguments: {},
          correlation_id: AI_ARCHITECT_PROBE_CORRELATION,
        },
      };
    }
    // No codebase → no ai-architect needed; probe the subagent plugin.
    return subagentProbe(state);
  }

  // Stage 2: ai-architect probe result.
  if (
    result?.kind === "tool_result" &&
    result.correlation_id === AI_ARCHITECT_PROBE_CORRELATION
  ) {
    if (!result.success) {
      return {
        state: appendError(
          state,
          `preflight: ai-architect unreachable (${result.error ?? "unknown error"})`,
          "upstream_failure",
        ),
        action: {
          kind: "failed",
          reason: adviseAiArchitectInstall(),
          step: "preflight",
        },
      };
    }
    return subagentProbe(state);
  }

  // Stage 3: zetetic-team-subagents probe result.
  if (
    result?.kind === "subagent_batch_result" &&
    result.batch_id === PREFLIGHT_SUBAGENT_PROBE_ID
  ) {
    return concludeSubagentProbe(state, result);
  }

  // Stage 0: kick off the Cortex probe. Cortex is always required (its
  // recall feeds every section). We start with the cheaper of the two
  // probes; ai-architect runs only after Cortex passes AND a codebase
  // is present.
  return {
    state,
    action: {
      kind: "call_cortex_tool",
      tool_name: "memory_stats",
      arguments: {},
      correlation_id: CORTEX_PROBE_CORRELATION,
    },
  };
};
