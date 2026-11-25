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
 * The engineer answers with structured tickets. They are validated against
 * the acceptance criteria of the document, kept on the checkpoint as
 * `jira_result` and rendered to the Markdown section. Every new run records
 * `jira_result`; only a checkpoint of the Markdown-only generator lacks it.
 *
 * State machine:
 *   pending → spawn_subagents
 *   waiting → on result, validate, store and advance to file_export
 */

import type { StepHandler } from "../runner.js";
import type { SectionType } from "@prd-gen/core";
import { appendError, type PipelineState } from "../types/state.js";
import { buildJiraPrompt } from "@prd-gen/meta-prompting";
import { projectDefineDocument } from "@prd-gen/validation";
import { documentSections } from "../section-plan.js";
import { JIRA_GENERATION_INV_ID as INVOCATION_ID } from "./protocol-ids.js";
import { parseJiraDraft, renderJiraTickets } from "./jira-ticket-draft.js";

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

/** Recorded when no exportable source exists; file_export reports it from the sources. */
export const NO_JIRA_SOURCES = "no source sections";

/** Prefix shared by every failed generation; file_export reads `jira_result` first. */
const FAILED = "[jira_generation] failed";

function refuse(state: PipelineState, reason: string, message: string) {
  const withError = appendError(
    state,
    `${FAILED}: ${reason}`,
    // The handler tolerates this (warns + continues to file_export).
    // Tagging as "upstream_failure" keeps the structural-error gate
    // from firing on a recoverable subagent flake (cross-audit
    // curie H1, Phase 3+4 follow-up, 2026-04).
    "upstream_failure",
  );
  return {
    state: { ...withError, jira_result: { status: "failed" as const, reason }, current_step: "file_export" as const },
    action: { kind: "emit_message" as const, level: "warn" as const, message },
  };
}

function acceptanceIds(state: PipelineState): ReadonlySet<string> {
  return new Set(projectDefineDocument(documentSections(state.sections)).acceptance.map(({ id }) => id));
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
      return refuse(state, response?.error ?? "no response",
        "JIRA generation failed; proceeding to file export anyway.");
    }
    const draft = parseJiraDraft(response.raw_text, acceptanceIds(state));
    if ("error" in draft) {
      return refuse(state, `jira_tickets_invalid: ${draft.error}`,
        `jira_tickets_invalid: the generated tickets were refused; proceeding to file export without them. ${draft.error}`);
    }

    // The "jira_tickets" SectionType lives in @prd-gen/core; file-export
    // filters it from the PRD body and writes it to its own file.
    const updated: PipelineState = {
      ...state,
      jira_result: { status: "passed", tickets: draft.tickets },
      sections: [
        ...state.sections,
        {
          section_type: "jira_tickets",
          status: "passed",
          attempt: 1,
          violation_count: 0,
          last_violations: [],
          attempt_log: [],
          content: renderJiraTickets(draft.tickets),
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
      state: { ...state, jira_result: { status: "failed", reason: NO_JIRA_SOURCES }, current_step: "file_export" },
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
