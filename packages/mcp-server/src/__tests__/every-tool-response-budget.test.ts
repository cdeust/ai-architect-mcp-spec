/**
 * Size contract of the whole server (#125): every response of every tool
 * the built server lists stays within the 100,000-char budget the server
 * declares (MAX_RESPONSE_CHARS), on inputs chosen to make that tool's
 * response large.
 *
 * Driven through the built server over stdio, so the measured text is the
 * text a host receives. The three pipeline tools are measured over one whole
 * run, played by this file as the host with the canned dispatcher: every
 * `start_pipeline` and `submit_action_result` envelope, and
 * `get_pipeline_state` in each of its formats at every step.
 *
 * A tool the server lists and this file does not measure fails the last
 * test: a new tool comes with its case.
 *
 * source: #125 asks for "a test on the size of every response against its
 * declared limit". Measured 2026-11-13 through the server built from main @
 * efd9e2e, before the fixes of #125: `validate_prd_section` 487,789 chars,
 * `validate_prd_document` 514,288, `get_pipeline_state` format "full"
 * 100,003 at the file_export step of the run below.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PRDContextSchema,
  SectionTypeSchema,
  ThinkingStrategySchema,
  tryCreateEvidenceRepository,
} from "@prd-gen/core";
import {
  MAX_RESPONSE_CHARS,
  defaultFakeSectionDraft,
  makeCannedDispatcher,
  type NextAction,
} from "@prd-gen/orchestration";
import { validateSection } from "@prd-gen/validation";
import { planDocumentVerification } from "@prd-gen/verification";
import {
  SELF_DEPENDENT_STORIES,
  UNRESOLVED_SYMBOL_REFERENCES,
  filler,
  largePrd,
} from "./large-inputs.js";
import { startStdioServer, type StdioServer, type ToolResponse } from "./stdio-server.js";

// Above vitest's 5 s default: the run is about 400 calls to one server, and
// each validator page is a call on a section of about 100,000 chars.
const TEST_TIMEOUT_MS = 120_000;

/** Rows of the evidence store behind get_quality_history (its `limit` maximum). */
const QUALITY_ROWS = 200;

interface Measure {
  readonly tool: string;
  readonly label: string;
  readonly chars: number;
}

const measures: Measure[] = [];
let server: StdioServer;
/** False when better-sqlite3 cannot be loaded here: the store stays empty. */
let storeFilled = false;

/**
 * postcondition: the evidence store at `path` holds QUALITY_ROWS quality
 *                scores and one execution of every strategy; false when the
 *                native module is unavailable (same contract as
 *                evidence-db-path.test.ts).
 */
function fillEvidenceStore(path: string): boolean {
  const repo = tryCreateEvidenceRepository(path);
  if (repo === null) return false;
  try {
    for (let i = 0; i < QUALITY_ROWS; i++) {
      repo.recordQualityScore({
        prdId: `run_mrlqa0aj_${String(i).padStart(6, "0")}`,
        prdContext: "feature",
        rulesChecked: 65,
        rulesPassed: 60,
        criticalViolations: 1,
        totalScore: 0.875,
        auditFlagsRaised: 3,
      });
    }
    for (const strategy of ThinkingStrategySchema.options) {
      repo.recordStrategyExecution({
        strategy,
        claimCharacteristics: ["architecture", "security", "performance"],
        complexityTier: "complex",
        expectedImprovement: 0.2,
        actualConfidenceGain: 0.1,
        wasCompliant: true,
        retryCount: 1,
        prdContext: "feature",
      });
    }
  } finally {
    repo.close();
  }
  return true;
}

beforeAll(async () => {
  server = await startStdioServer((path) => {
    storeFilled = fillEvidenceStore(path);
  });
});

afterAll(async () => {
  await server?.close();
});

/** Calls a tool and records the size of what it answered. */
async function measured(tool: string, label: string, args: Record<string, unknown>): Promise<ToolResponse> {
  const response = await server.call(tool, args);
  measures.push({ tool, label, chars: response.text.length });
  return response;
}

interface Paged {
  readonly __page: { readonly offset: number; readonly next_offset: number | null };
}

/**
 * Follows `__page.next_offset` from 0 through `offsetArg`, measuring every
 * page; returns the number of pages.
 */
async function measuredWalk(
  tool: string,
  label: string,
  args: Record<string, unknown>,
  offsetArg: string,
): Promise<number> {
  let pages = 0;
  let offset: number | null = 0;
  while (offset !== null) {
    const response = await measured(tool, `${label}, ${offsetArg} ${offset}`, { ...args, [offsetArg]: offset });
    expect(response.isError, response.text.slice(0, 300)).toBe(false);
    const page = (JSON.parse(response.text) as Paged).__page;
    expect(page.offset).toBe(offset);
    offset = page.next_offset;
    if (++pages > 1_000) throw new Error("walk does not terminate");
  }
  return pages;
}

async function measuredOk(tool: string, label: string, args: Record<string, unknown>): Promise<ToolResponse> {
  const response = await measured(tool, label, args);
  expect(response.isError, response.text.slice(0, 300)).toBe(false);
  return response;
}

// ─── One whole pipeline run, this file as the host ──────────────────────────

interface Envelope {
  readonly run_id: string;
  readonly current_step: string;
  readonly action: { kind: string; invocations?: Array<Record<string, unknown>> } & Record<string, unknown>;
  readonly __bounded: { readonly applied: ReadonlyArray<{ field: string; next_offset?: number }> };
}

interface RunFacts {
  readonly steps: number;
  readonly lastActionKind: string;
  /** Envelopes whose spawn_subagents prompts did not all fit. */
  readonly boundedEnvelopes: number;
  /** format:"full" responses that shed something to fit. */
  readonly degradedFullStates: number;
}

/** A canned section draft, padded to the section size of `largePrd`. */
function largeDraft(sectionType: string): string {
  const draft = defaultFakeSectionDraft(sectionType);
  const target = 7_250; // source: the per-section size of large-inputs.ts largePrd()
  return draft.length >= target ? draft : `${draft}\n\n${filler(sectionType, target - draft.length - 2)}`;
}

/**
 * Reads the prompts an envelope left as stubs, from `next_offset`, and
 * returns the action with every invocation whole.
 */
async function withEveryPrompt(envelope: Envelope): Promise<NextAction> {
  const omission = envelope.__bounded.applied.find((d) => d.field === "action.invocations[].prompt");
  const label = `${envelope.current_step} action`;
  if (omission === undefined) {
    await measuredOk("get_pipeline_state", label, { run_id: envelope.run_id, format: "action" });
    return envelope.action as unknown as NextAction;
  }
  const invocations = envelope.action.invocations!.slice(0, omission.next_offset);
  let offset: number | null = omission.next_offset!;
  while (offset !== null) {
    const response = await measuredOk("get_pipeline_state", `${label}, invocation_offset ${offset}`, {
      run_id: envelope.run_id,
      format: "action",
      invocation_offset: offset,
    });
    const page = JSON.parse(response.text) as Paged & { action: { invocations: Array<Record<string, unknown>> } };
    invocations.push(...page.action.invocations);
    offset = page.__page.next_offset;
  }
  expect(invocations).toHaveLength(envelope.action.invocations!.length);
  for (const invocation of invocations) expect(typeof invocation.prompt).toBe("string");
  return { ...envelope.action, invocations } as unknown as NextAction;
}

async function playRun(): Promise<RunFacts> {
  const dispatch = makeCannedDispatcher({ fake_section_draft: largeDraft });
  let boundedEnvelopes = 0;
  let degradedFullStates = 0;
  let response = await measuredOk("start_pipeline", "start", {
    feature_description: "build a feature for OAuth login",
    codebase_path: "/tmp/smoke",
  });
  for (let steps = 0; ; steps++) {
    if (steps > 2_000) throw new Error("the run does not terminate");
    const envelope = JSON.parse(response.text) as Envelope;
    const where = `${envelope.current_step}/${envelope.action.kind}`;
    if (envelope.__bounded.applied.length > 0) boundedEnvelopes++;
    for (const format of ["summary", "full", "grounding", "validation"]) {
      const state = await measuredOk("get_pipeline_state", `${where} ${format}`, {
        run_id: envelope.run_id,
        format,
      });
      const applied = (JSON.parse(state.text) as { __bounded?: { applied: unknown[] } }).__bounded?.applied;
      if (format === "full" && applied !== undefined && applied.length > 0) degradedFullStates++;
    }
    const result = dispatch(await withEveryPrompt(envelope));
    if (result === undefined) {
      return { steps, lastActionKind: envelope.action.kind, boundedEnvelopes, degradedFullStates };
    }
    response = await measuredOk("submit_action_result", `after ${where}`, { run_id: envelope.run_id, result });
  }
}

let run: Promise<RunFacts> | undefined;
/** The run is played once; the three pipeline tools share its measures. */
function theRun(): Promise<RunFacts> {
  run ??= playRun();
  return run;
}

async function pipelineCase(): Promise<void> {
  const facts = await theRun();
  expect(facts.lastActionKind).toBe("done");
  // The run is large enough to reach both bounds, not only small responses.
  expect(facts.boundedEnvelopes).toBeGreaterThan(0);
  expect(facts.degradedFullStates).toBeGreaterThan(0);
}

// ─── One case per tool ──────────────────────────────────────────────────────

const CASES: Record<string, () => Promise<void>> = {
  get_config: async () => {
    await measuredOk("get_config", "no argument", {});
  },
  read_skill_config: async () => {
    await measuredOk("read_skill_config", "no argument", {});
  },
  check_health: async () => {
    await measuredOk("check_health", "no argument", {});
  },
  list_available_strategies: async () => {
    await measuredOk("list_available_strategies", "no argument", {});
  },
  get_prd_context_info: async () => {
    for (const context of PRDContextSchema.options) {
      await measuredOk("get_prd_context_info", context, { context });
    }
  },
  coordinate_context_budget: async () => {
    for (const prd_context of PRDContextSchema.options) {
      await measuredOk("coordinate_context_budget", `${prd_context}, nothing completed`, { prd_context });
      await measuredOk("coordinate_context_budget", `${prd_context}, every section completed`, {
        prd_context,
        completed_sections: [...SectionTypeSchema.options],
      });
    }
  },
  validate_prd_section: async () => {
    const stories = await measuredWalk(
      "validate_prd_section",
      "1,500 self-dependent stories",
      { content: SELF_DEPENDENT_STORIES, section_type: "user_stories" },
      "item_offset",
    );
    expect(stories).toBeGreaterThan(1);
    const symbols = await measuredWalk(
      "validate_prd_section",
      "4,000 unresolved symbols",
      { content: UNRESOLVED_SYMBOL_REFERENCES, section_type: "technical_specification", known_symbols: [] },
      "item_offset",
    );
    expect(symbols).toBeGreaterThan(1);
    // 23 chars in, one violation: it was 189,370 chars out before the rules
    // named the first missing numbers and counted the rest (listed-ids.ts).
    const wideGap = await measuredWalk(
      "validate_prd_section",
      "two criteria numbered 1 and 20000",
      { content: "- AC-1: a\n- AC-20000: b", section_type: "acceptance_criteria" },
      "item_offset",
    );
    expect(wideGap).toBe(1);
  },
  validate_prd_document: async () => {
    const pages = await measuredWalk(
      "validate_prd_document",
      "stories and symbols",
      {
        sections: [
          { type: "user_stories", content: SELF_DEPENDENT_STORIES },
          { type: "technical_specification", content: UNRESOLVED_SYMBOL_REFERENCES },
        ],
        known_symbols: [],
      },
      "item_offset",
    );
    expect(pages).toBeGreaterThan(1);
  },
  get_quality_history: async () => {
    const response = await measured("get_quality_history", `limit ${QUALITY_ROWS}`, { limit: QUALITY_ROWS });
    // Without better-sqlite3 the tool answers its "unavailable" error, which
    // is measured all the same.
    expect(response.isError).toBe(!storeFilled);
    if (storeFilled) expect(JSON.parse(response.text)).toHaveLength(QUALITY_ROWS);
  },
  get_strategy_effectiveness: async () => {
    const response = await measured("get_strategy_effectiveness", "every strategy", { min_executions: 1 });
    expect(response.isError).toBe(!storeFilled);
    if (storeFilled) {
      const body = JSON.parse(response.text) as { performance: unknown[] };
      expect(body.performance).toHaveLength(ThinkingStrategySchema.options.length);
    }
  },
  map_failure_to_retrieval: async () => {
    const { violations } = validateSection(SELF_DEPENDENT_STORIES, "user_stories");
    expect(violations.length).toBeGreaterThanOrEqual(1_500);
    await measuredOk("map_failure_to_retrieval", `${violations.length} violations`, { violations });
  },
  plan_section_verification: async () => {
    const [requirements] = largePrd(58_000);
    const pages = await measuredWalk(
      "plan_section_verification",
      "one 58,000-char section",
      { section_type: requirements.type, content: requirements.content },
      "request_offset",
    );
    expect(pages).toBeGreaterThan(1);
  },
  plan_document_verification: async () => {
    const pages = await measuredWalk(
      "plan_document_verification",
      "eight sections, 58,000 chars",
      { sections: largePrd() },
      "request_offset",
    );
    expect(pages).toBeGreaterThan(1);
  },
  conclude_verification: async () => {
    const plan = planDocumentVerification(largePrd() as Parameters<typeof planDocumentVerification>[0], {
      include_prd_excerpt: true,
    });
    const verdicts = plan.judge_requests.map((request) => ({
      judge: request.judge,
      claim_id: request.claim.claim_id,
      verdict: "PASS",
      rationale: "The claim is supported by the section text quoted as evidence.",
      caveats: [],
      confidence: 0.8,
    }));
    expect(verdicts.length).toBeGreaterThan(40);
    await measuredOk("conclude_verification", `${verdicts.length} verdicts`, {
      scope: "document",
      verdicts,
      consensus_strategy: "weighted_average",
    });
  },
  start_pipeline: pipelineCase,
  submit_action_result: pipelineCase,
  get_pipeline_state: pipelineCase,
};

describe("every tool: every response within the declared budget (#125)", () => {
  it.each(Object.keys(CASES))(
    "%s",
    async (tool) => {
      await CASES[tool]();
      const mine = measures.filter((m) => m.tool === tool);
      expect(mine.length, `no response of ${tool} was measured`).toBeGreaterThan(0);
      expect(mine.filter((m) => m.chars > MAX_RESPONSE_CHARS)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it("measures every tool the server lists", async () => {
    expect(Object.keys(CASES).sort()).toEqual((await server.listTools()).sort());
  });
});
