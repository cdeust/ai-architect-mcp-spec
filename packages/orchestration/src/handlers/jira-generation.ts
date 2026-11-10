/**
 * JIRA ticket generation.
 *
 * Spawns the engineer subagent to produce JIRA tickets from the
 * acceptance_criteria + user_stories + requirements sections. The output is
 * stored as a synthetic "jira" pseudo-section so file_export can pick it up.
 * A failed section's draft is never source material (#122): when every
 * source failed, generation is skipped and file_export reports 07 as
 * failed_validation.
 *
 * State machine:
 *   pending → spawn_subagents
 *   waiting → on result, store and advance to file_export
 */

import type { StepHandler } from "../runner.js";
import type { SectionType } from "@prd-gen/core";
import { appendError, type PipelineState } from "../types/state.js";
import { buildJiraPrompt } from "@prd-gen/meta-prompting";
import { JIRA_GENERATION_INV_ID as INVOCATION_ID } from "./protocol-ids.js";

const BATCH_ID = "jira_generation";

/** The section types JIRA tickets are built from (shared with file_export). */
export const JIRA_SOURCE_TYPES: readonly SectionType[] = [
  "requirements",
  "user_stories",
  "acceptance_criteria",
];

function gatherSourceSections(state: PipelineState): ReadonlyArray<{
  section_type: string;
  content: string;
}> {
  return state.sections
    // A failed draft is not a deliverable (#122): no tickets are built from it.
    .filter(
      (s) => JIRA_SOURCE_TYPES.includes(s.section_type) && s.content && s.status !== "failed",
    )
    .map((s) => ({
      section_type: s.section_type,
      content: s.content!,
    }));
}

export const handleJiraGeneration: StepHandler = ({ state, result }) => {
  // Result of our spawn.
  if (
    result?.kind === "subagent_batch_result" &&
    result.batch_id === BATCH_ID
  ) {
    const response = result.responses.find(
      (r) => r.invocation_id === INVOCATION_ID,
    );
    if (!response || response.error || !response.raw_text) {
      const withError = appendError(
        state,
        `[jira_generation] failed: ${response?.error ?? "no response"}`,
        // The handler tolerates this (warns + continues to file_export).
        // Tagging as "upstream_failure" keeps the structural-error gate
        // from firing on a recoverable subagent flake (cross-audit
        // curie H1, Phase 3+4 follow-up, 2026-04).
        "upstream_failure",
      );
      return {
        state: { ...withError, current_step: "file_export" },
        action: {
          kind: "emit_message",
          level: "warn",
          message: "JIRA generation failed; proceeding to file export anyway.",
        },
      };
    }

    // Store JIRA output in its own typed section. The "jira_tickets"
    // SectionType lives in @prd-gen/core; file-export filters it from the
    // PRD body and writes it to its own file.
    const jiraMarkdown = response.raw_text.trim();
    const updated: PipelineState = {
      ...state,
      sections: [
        ...state.sections,
        {
          section_type: "jira_tickets",
          status: "passed",
          attempt: 1,
          violation_count: 0,
          last_violations: [],
          attempt_log: [],
          content: jiraMarkdown,
        },
      ],
      current_step: "file_export",
    };
    return {
      state: updated,
      action: {
        kind: "emit_message",
        message: "JIRA tickets generated. Writing files.",
      },
    };
  }

  // Trigger the spawn.
  const sourceMaterial = gatherSourceSections(state);
  if (sourceMaterial.length === 0) {
    return {
      state: { ...state, current_step: "file_export" },
      action: {
        kind: "emit_message",
        message: "No source sections for JIRA generation. Skipping.",
      },
    };
  }

  return {
    state,
    action: {
      kind: "spawn_subagents",
      purpose: "draft",
      batch_id: BATCH_ID,
      invocations: [
        {
          invocation_id: INVOCATION_ID,
          subagent_type: "zetetic-team-subagents:engineer",
          description: "Generate JIRA tickets from PRD",
          prompt: buildJiraPrompt({
            feature_description: state.feature_description,
            source_sections: sourceMaterial,
          }),
          isolation: "none",
        },
      ],
    },
  };
};
