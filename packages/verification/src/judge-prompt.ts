/**
 * Judge prompt construction.
 *
 * Builds a structured, deterministic prompt for a verification judge (genius
 * agent or team agent). The judge MUST return a single JSON object matching
 * `JudgeVerdict` — we parse it; we don't free-form synthesize.
 *
 * Lives in `@prd-gen/verification` because it is a use-case-layer concern:
 * the verification module owns the judge orchestration domain, including
 * how a judge is briefed. The infrastructure layer (ecosystem-adapters)
 * needs only to dispatch the resulting `subagent_type + prompt` to the
 * host's Agent tool.
 *
 * Origin: previously lived in `@prd-gen/ecosystem-adapters/clients/judge-prompt.ts`.
 * Moved here to fix the §2.2 layer violation surfaced by the Phase 3+4
 * cross-audit (code-reviewer H1).
 *
 * Source for verdict taxonomy: SKILL.md Rule 15 → core/domain/verdict.ts.
 *
 * source: cross-audit code-reviewer H1 (Phase 3+4, 2026-04).
 */

import { type JudgeRequest, agentSubagentType } from "@prd-gen/core";

export interface BuiltJudgePrompt {
  readonly description: string;
  readonly subagent_type: string;
  readonly prompt: string;
}

const VERDICT_TAXONOMY = `
| Verdict | Meaning | When to use |
|---------|---------|-------------|
| PASS | Claim is structurally complete AND verifiable from the document | FR traceability, AC completeness, SP arithmetic, structural checks |
| SPEC-COMPLETE | A test or measurement method is specified, but runtime data is needed to confirm | NFR performance targets (latency, fps, throughput), scalability limits |
| NEEDS-RUNTIME | Claim cannot be verified at design time at all | Load test results, p95 latency under prod traffic, real-world storage usage |
| INCONCLUSIVE | Claim depends on an unresolved open question or external factor | Claims referencing OQ-XXX, vendor SLA, regulatory interpretation |
| FAIL | Claim is structurally invalid or contradicts other claims | Arithmetic errors, orphan references, circular dependencies |

NFR claims about latency, fps, throughput, or storage MUST NOT receive PASS.
They receive SPEC-COMPLETE (if a test method is specified) or NEEDS-RUNTIME.
`.trim();

const RESPONSE_SCHEMA = `
{
  "verdict": "PASS" | "SPEC-COMPLETE" | "NEEDS-RUNTIME" | "INCONCLUSIVE" | "FAIL",
  "rationale": "<one paragraph: why you reached this verdict>",
  "caveats": ["<short caveat>", "..."],
  "confidence": <number in [0, 1]>
}
`.trim();

export function buildJudgePrompt(req: JudgeRequest): BuiltJudgePrompt {
  const { judge, claim, context } = req;
  const judgeDescription =
    judge.kind === "genius"
      ? `Apply the ${judge.name} reasoning pattern to evaluate the claim.`
      : `Apply your ${judge.name} role expertise to evaluate the claim.`;

  const prdExcerpt = context.prd_excerpt
    ? `<prd_excerpt>\n${context.prd_excerpt}\n</prd_excerpt>\n\n`
    : "";

  const codebaseSection = context.codebase_excerpts.length
    ? `<codebase_context>\n${context.codebase_excerpts.join("\n---\n")}\n</codebase_context>\n\n`
    : "";

  const memorySection = context.memory_excerpts.length
    ? `<memory_context>\n${context.memory_excerpts.join("\n---\n")}\n</memory_context>\n\n`
    : "";

  const prompt = [
    `You are acting as a verification judge for a PRD.`,
    judgeDescription,
    "",
    `<claim>`,
    `id: ${claim.claim_id}`,
    `type: ${claim.claim_type}`,
    `source_section: ${claim.source_section ?? "(unspecified)"}`,
    `text: ${claim.text}`,
    `</claim>`,
    "",
    `<evidence>`,
    claim.evidence,
    `</evidence>`,
    "",
    prdExcerpt + codebaseSection + memorySection,
    `<verdict_taxonomy>`,
    VERDICT_TAXONOMY,
    `</verdict_taxonomy>`,
    "",
    `Return EXACTLY ONE JSON object matching this schema and nothing else (no prose before or after, no markdown fences):`,
    "",
    RESPONSE_SCHEMA,
    "",
    `Constraints:`,
    `- Do NOT default to PASS. If you would assign PASS to every claim of this type, you are not doing your job.`,
    `- NFR claims (latency, throughput, fps, storage) MUST NOT receive PASS. Use SPEC-COMPLETE or NEEDS-RUNTIME.`,
    `- "rationale" must be specific to THIS claim, not a generic rubric.`,
    `- "confidence" reflects how sure you are about the verdict, not how confident you are about the claim.`,
  ].join("\n");

  return {
    description: `Judge ${claim.claim_id} (${judge.kind}:${judge.name})`,
    subagent_type: agentSubagentType(judge),
    prompt,
  };
}

const BATCH_RESPONSE_SCHEMA = `
[
  {
    "claim_id": "<the id of one claim above>",
    "verdict": "PASS" | "SPEC-COMPLETE" | "NEEDS-RUNTIME" | "INCONCLUSIVE" | "FAIL",
    "rationale": "<one paragraph: why you reached this verdict for THIS claim>",
    "caveats": ["<short caveat>", "..."],
    "confidence": <number in [0, 1]>
  }
]
`.trim();

/** Line that opens each claim's id inside a `<claim>` block of a judge prompt. */
const CLAIM_ID_LINE = /^<claim>\nid: (.+)$/gm;

/**
 * One prompt for one judge over several claims: the PRD and the other
 * context are embedded ONCE, followed by one `<claim>`/`<evidence>` pair per
 * claim, and the judge returns one JSON array with one verdict per claim_id.
 *
 * Issue #119: the per-(judge × claim) prompt re-embedded the whole PRD in
 * every judge invocation (twelve copies of a 27k-token PRD in the audited
 * run). The claims a judge sees here are the ones it would have seen one by
 * one; only the transport changes.
 *
 * precondition:  `requests` is non-empty; every request names the same judge
 *                and carries the same `context` (they come from one
 *                planDocumentVerification call, which gives every request
 *                the same document excerpt and the same options); claim_ids
 *                are distinct.
 * postcondition: the prompt carries the context of `requests[0]` once and
 *                every claim in order; `claimIdsInJudgePrompt(prompt)` returns
 *                the claim_ids of `requests`, in the same order.
 */
export function buildBatchedJudgePrompt(
  requests: readonly JudgeRequest[],
): BuiltJudgePrompt {
  if (requests.length === 0) {
    throw new Error("buildBatchedJudgePrompt: no request to batch");
  }
  const { judge, context } = requests[0];
  for (const req of requests) {
    if (req.judge.kind !== judge.kind || req.judge.name !== judge.name) {
      throw new Error(
        `buildBatchedJudgePrompt: mixed judges (${judge.kind}:${judge.name} and ${req.judge.kind}:${req.judge.name})`,
      );
    }
    if (req.context.prd_excerpt !== context.prd_excerpt) {
      throw new Error("buildBatchedJudgePrompt: requests carry different PRD excerpts");
    }
  }
  const judgeDescription =
    judge.kind === "genius"
      ? `Apply the ${judge.name} reasoning pattern to evaluate each claim.`
      : `Apply your ${judge.name} role expertise to evaluate each claim.`;

  const claimBlocks = requests.flatMap(({ claim }) => [
    `<claim>`,
    `id: ${claim.claim_id}`,
    `type: ${claim.claim_type}`,
    `source_section: ${claim.source_section ?? "(unspecified)"}`,
    `text: ${claim.text}`,
    `</claim>`,
    `<evidence claim_id="${claim.claim_id}">`,
    claim.evidence,
    `</evidence>`,
    "",
  ]);

  const prompt = [
    `You are acting as a verification judge for a PRD.`,
    judgeDescription,
    `There are ${requests.length} claim(s). Judge each one on its own: a verdict on one claim must not depend on the verdict you give another.`,
    "",
    contextSections(context),
    ...claimBlocks,
    `<verdict_taxonomy>`,
    VERDICT_TAXONOMY,
    `</verdict_taxonomy>`,
    "",
    `Return EXACTLY ONE JSON array with one object per claim above, each carrying that claim's "claim_id", matching this schema and nothing else (no prose before or after, no markdown fences):`,
    "",
    BATCH_RESPONSE_SCHEMA,
    "",
    `Constraints:`,
    `- One object per claim_id listed above, no more, no less.`,
    `- Do NOT default to PASS. If you would assign PASS to every claim of a type, you are not doing your job.`,
    `- NFR claims (latency, throughput, fps, storage) MUST NOT receive PASS. Use SPEC-COMPLETE or NEEDS-RUNTIME.`,
    `- Each "rationale" must be specific to its claim, not a generic rubric.`,
    `- "confidence" reflects how sure you are about the verdict, not how confident you are about the claim.`,
  ].join("\n");

  const ids = requests.map((r) => r.claim.claim_id);
  return {
    description: `Judge ${ids.length === 1 ? ids[0] : `${ids.length} claims`} (${judge.kind}:${judge.name})`,
    subagent_type: agentSubagentType(judge),
    prompt,
  };
}

/**
 * The claim_ids a judge prompt asks about, in prompt order.
 *
 * precondition:  `prompt` was built by buildJudgePrompt or
 *                buildBatchedJudgePrompt.
 * postcondition: one id per `<claim>` block; a host or a canned dispatcher
 *                that answers a batched prompt reads the ids it must answer
 *                for from here instead of re-parsing the prompt itself.
 */
export function claimIdsInJudgePrompt(prompt: string): readonly string[] {
  return [...prompt.matchAll(CLAIM_ID_LINE)].map((m) => m[1]);
}

function contextSections(context: JudgeRequest["context"]): string {
  const prdExcerpt = context.prd_excerpt
    ? `<prd_excerpt>\n${context.prd_excerpt}\n</prd_excerpt>\n\n`
    : "";
  const codebaseSection = context.codebase_excerpts.length
    ? `<codebase_context>\n${context.codebase_excerpts.join("\n---\n")}\n</codebase_context>\n\n`
    : "";
  const memorySection = context.memory_excerpts.length
    ? `<memory_context>\n${context.memory_excerpts.join("\n---\n")}\n</memory_context>\n\n`
    : "";
  return prdExcerpt + codebaseSection + memorySection;
}
