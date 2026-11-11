/**
 * MCP prompts for prd-gen — prompts/list + prompts/get (issue #28).
 *
 * prd-gen is almost entirely a staged pipeline, and the stages ARE the
 * product. A caller that invokes them out of order does not get an error — it
 * gets a pipeline in a wrong state. These prompts publish the ordering as
 * enumerable protocol.
 *
 * Source of truth (criterion 2): a prompt step names a tool and pulls that
 * tool's one-line summary from the live registered-tool description via
 * `summaryOf` — the SAME schema `tools/list` advertises. The prompt owns only
 * the *ordering* (the pipeline the SKILL.md / skill-config.json already
 * encode); it never hand-copies a tool's description. Three copies of one
 * ordering contract is the drift defect, not a feature.
 *
 * Per-argument `title`: the installed MCP SDK models a prompt argument as
 * name/description/required only (PromptArgumentSchema has no `title` field),
 * so the human title is folded into each argument's description. The
 * prompt-level `title` IS emitted.
 */

import type { McpServer, RegisteredPrompt } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Resolves a tool's registered description, or undefined if unknown. */
export type ToolSummarySource = (toolName: string) => string | undefined;

interface Step {
  readonly tool: string;
  readonly guidance: string;
}

const PRD_CONTEXTS = [
  "proposal",
  "feature",
  "bug",
  "incident",
  "poc",
  "mvp",
  "release",
  "cicd",
] as const;

// ─── Prompt catalog (ordering only; summaries come from the tool schemas) ───

const RUN_PIPELINE_STEPS: readonly Step[] = [
  { tool: "coordinate_context_budget", guidance: "Allocate the per-section token budget BEFORE generating anything." },
  { tool: "start_pipeline", guidance: "Initialize the run; it returns the first NextAction to execute." },
  { tool: "get_pipeline_state", guidance: "Read the current state by run_id whenever you need to re-orient." },
  { tool: "submit_action_result", guidance: "Feed each executed action's result back; repeat until the action is `done`." },
  { tool: "plan_document_verification", guidance: "Once sections exist, emit the JudgeRequest[] across the whole document; follow __page.next_offset (request_offset) to the last page." },
  { tool: "conclude_verification", guidance: "Aggregate the JudgeVerdict[] into the final VerificationReport." },
];

const VERIFY_DOCUMENT_STEPS: readonly Step[] = [
  { tool: "get_pipeline_state", guidance: "Load the run's current sections by run_id." },
  { tool: "plan_document_verification", guidance: "Emit the cross-section JudgeRequest[] to execute; follow __page.next_offset (request_offset) to the last page." },
  { tool: "submit_action_result", guidance: "Return each judge batch's verdicts to the reducer." },
  { tool: "validate_prd_document", guidance: "Run the deterministic Hard Output Rules pass (SP arithmetic, AC numbering, coverage)." },
  { tool: "conclude_verification", guidance: "Aggregate verdicts into the VerificationReport." },
];

/** Prompt name → the tools its workflow drives (for profile availability). */
export const PROMPT_STEP_TOOLS: Readonly<Record<string, readonly string[]>> = {
  run_prd_pipeline: RUN_PIPELINE_STEPS.map((s) => s.tool),
  verify_prd_document: VERIFY_DOCUMENT_STEPS.map((s) => s.tool),
};

export const PROMPT_NAMES = Object.keys(PROMPT_STEP_TOOLS);

// ─── Body composition ───────────────────────────────────────────────────────

/** First sentence of a description (up to the first ". "), or a fallback. */
function firstSentence(description: string | undefined, tool: string): string {
  if (!description) return `\`${tool}\``;
  const idx = description.indexOf(". ");
  return idx === -1 ? description : description.slice(0, idx + 1);
}

function renderBody(
  intro: string,
  steps: readonly Step[],
  closing: string,
  summaryOf: ToolSummarySource,
): string {
  const lines = [
    intro,
    "",
    "prd-gen's tools are a pipeline and the order is the product — calling them " +
      "out of order leaves the pipeline in a wrong state, not an error. Work them " +
      "in this order:",
    "",
  ];
  steps.forEach((step, i) => {
    lines.push(`${i + 1}. \`${step.tool}\` — ${firstSentence(summaryOf(step.tool), step.tool)} ${step.guidance}`);
  });
  lines.push("", closing);
  return lines.join("\n");
}

function textResult(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Register every prompt on `server`, rendering bodies from `summaryOf`.
 * Returns the registered-prompt handles by name so the caller can gate them by
 * profile (both current prompts drive agent-facing tools, so both stay enabled
 * under every profile — the gating hook exists for future prompts).
 */
export function registerPrompts(
  server: McpServer,
  summaryOf: ToolSummarySource,
): Record<string, RegisteredPrompt> {
  const runPipeline = server.registerPrompt(
    "run_prd_pipeline",
    {
      title: "Run the PRD generation pipeline",
      description: "Drive the staged PRD generation + verification pipeline in the correct order.",
      argsSchema: {
        context: z.enum(PRD_CONTEXTS).describe("Context — the PRD context type (proposal, feature, bug, …)."),
        request: z.string().describe("Request — what the PRD should cover (the feature/incident/proposal to spec)."),
      },
    },
    ({ context, request }) =>
      textResult(
        renderBody(
          `Generate a "${context}" PRD for: ${request}`,
          RUN_PIPELINE_STEPS,
          "Never skip coordinate_context_budget or submit out of order — the reducer " +
            "advances one NextAction at a time and a skipped stage silently mis-states the run.",
          summaryOf,
        ),
      ),
  );

  const verifyDocument = server.registerPrompt(
    "verify_prd_document",
    {
      title: "Verify a PRD document",
      description: "Run the document-verification loop and deterministic checks over a pipeline run.",
      argsSchema: {
        run_id: z.string().describe("Run id — the pipeline run whose document should be verified."),
      },
    },
    ({ run_id }) =>
      textResult(
        renderBody(
          `Verify the PRD document for pipeline run "${run_id}".`,
          VERIFY_DOCUMENT_STEPS,
          "conclude_verification only aggregates verdicts you actually submitted — do " +
            "not conclude before every planned JudgeRequest has a returned verdict.",
          summaryOf,
        ),
      ),
  );

  return { run_prd_pipeline: runPipeline, verify_prd_document: verifyDocument };
}
