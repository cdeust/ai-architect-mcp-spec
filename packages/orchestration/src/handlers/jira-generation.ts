/**
 * JIRA ticket generation.
 *
 * Spawns the engineer subagent to produce JIRA tickets from the
 * acceptance_criteria + user_stories + requirements sections.
 * A failed section's draft is never source material (#122): when every
 * source failed, generation is skipped and file_export reports 07 as
 * failed_validation.
 *
 * The engineer answers with structured tickets. They are validated against
 * the acceptance criteria of the document and kept on the checkpoint as
 * `jira_result`, from which file_export renders 07-jira-tickets.md. Every new run records
 * `jira_result`; only a checkpoint of the Markdown-only generator lacks it.
 *
 * State machine:
 *   pending → spawn_subagents
 *   waiting → on result, validate, store and advance to file_export
 */

import type { StepHandler } from "../runner.js";
import type { JiraResult, SectionType } from "@prd-gen/core";
import { appendError, type PipelineState } from "../types/state.js";
import { buildJiraPrompt } from "@prd-gen/meta-prompting";
import { projectDefineDocument } from "@prd-gen/validation";
import { documentSections } from "../section-plan.js";
import { JIRA_GENERATION_INV_ID as INVOCATION_ID } from "./protocol-ids.js";
import { parseJiraDraft } from "./jira-ticket-draft.js";
import { clipChars, ERROR_MESSAGE_CHARS } from "../types/state/bounded-io.js";

/** The batch of the structured ticket request. */
export const JIRA_BATCH_ID = "jira_generation_tickets";
/**
 * The batch of the Markdown-only request. A run saved with that request in
 * flight answers it after an upgrade: its reply is kept as it was before,
 * as a section, and the run stays a checkpoint without jira_result.
 */
const MARKDOWN_BATCH_ID = "jira_generation";

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

/** Prefix of every failed generation in errors[]; a checkpoint before jira_result is read by it. */
export const JIRA_FAILED_PREFIX = "[jira_generation] failed";

type Failure = Extract<JiraResult, { status: "failed" }>;

function refuse(state: PipelineState, cause: Failure["cause"], detail: string, message: string) {
  const bounded = clipChars(detail, ERROR_MESSAGE_CHARS);
  const withError = appendError(
    state,
    `${JIRA_FAILED_PREFIX}: ${cause}: ${bounded}`,
    // The handler tolerates this (warns + continues to file_export): a
    // subagent flake or a refused reply, not a structural error of the run
    // (cross-audit curie H1, Phase 3+4 follow-up, 2026-04).
    "upstream_failure",
  );
  return {
    state: { ...withError, jira_result: { status: "failed" as const, cause, detail: bounded }, current_step: "file_export" as const },
    action: { kind: "emit_message" as const, level: "warn" as const, message },
  };
}

function keepMarkdownReply(state: PipelineState, response: { raw_text?: string; error?: string } | undefined) {
  const markdown = response?.raw_text?.trim();
  // A failed reply, even with partial text, is not a deliverable (as before the structured request).
  if (response?.error || !markdown) {
    const reason = response?.error || "no response";
    return {
      state: { ...appendError(state, `${JIRA_FAILED_PREFIX}: ${reason}`, "upstream_failure"), current_step: "file_export" as const },
      action: { kind: "emit_message" as const, level: "warn" as const, message: "JIRA generation failed; proceeding to file export anyway." },
    };
  }
  const section = {
    section_type: "jira_tickets" as const, status: "passed" as const, attempt: 1,
    violation_count: 0, last_violations: [], attempt_log: [], content: markdown,
  };
  return {
    state: { ...state, sections: [...state.sections, section], current_step: "file_export" as const },
    action: { kind: "emit_message" as const, message: "JIRA tickets generated. Writing files." },
  };
}

function acceptanceIds(state: PipelineState): ReadonlySet<string> {
  return new Set(projectDefineDocument(documentSections(state.sections)).acceptance.map(({ id }) => id));
}

export const handleJiraGeneration: StepHandler = ({ state, result }) => {
  if (result?.kind === "subagent_batch_result" && result.batch_id === MARKDOWN_BATCH_ID) {
    return keepMarkdownReply(state, result.responses.find((r) => r.invocation_id === INVOCATION_ID));
  }
  // Result of our spawn.
  if (result?.kind === "subagent_batch_result" && result.batch_id === JIRA_BATCH_ID) {
    const response = result.responses.find(
      (r) => r.invocation_id === INVOCATION_ID,
    );
    if (!response || response.error || !response.raw_text) {
      return refuse(state, "missing", response?.error || "no response",
        "JIRA generation failed; proceeding to file export anyway.");
    }
    const draft = parseJiraDraft(response.raw_text, acceptanceIds(state));
    if ("error" in draft) {
      return refuse(state, "invalid", draft.error,
        "jira_tickets_invalid: the generated tickets were refused; proceeding to file export without them.");
    }

    // file_export renders 07-jira-tickets.md from these tickets.
    const updated: PipelineState = {
      ...state,
      jira_result: { status: "passed", tickets: draft.tickets },
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
      state: { ...state, jira_result: { status: "failed", cause: "skipped", detail: "no source sections" }, current_step: "file_export" },
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
      batch_id: JIRA_BATCH_ID,
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
