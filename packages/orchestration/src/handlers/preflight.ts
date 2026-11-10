/**
 * Preflight — verify required MCP servers are reachable BEFORE the pipeline
 * begins to depend on them.
 *
 * The pipeline relies on two ecosystem MCPs at runtime:
 *   - cortex            (call_cortex_tool: per-section memory recall)
 *   - ai-architect      (call_pipeline_tool: analyze_codebase, when a
 *                        codebase path is supplied)
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
import { appendError } from "../types/state.js";

const CORTEX_PROBE_CORRELATION = "preflight_cortex_probe";
const AI_ARCHITECT_PROBE_CORRELATION = "preflight_ai_architect_probe";

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
    // No codebase → no ai-architect needed; preflight done.
    return {
      state: {
        ...state,
        preflight_status: "ok",
        current_step: "context_detection",
      },
      action: {
        kind: "emit_message",
        message: "Preflight passed: Cortex reachable. (no codebase → ai-architect probe skipped)",
      },
    };
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
    return {
      state: {
        ...state,
        preflight_status: "ok",
        current_step: "context_detection",
      },
      action: {
        kind: "emit_message",
        message: "Preflight passed: Cortex + ai-architect reachable.",
      },
    };
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
