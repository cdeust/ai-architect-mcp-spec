import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { makeCannedDispatcher, newPipelineState, NextActionSchema, step, type ActionResult, type NextAction, type PipelineState } from "@prd-gen/orchestration";
import { CLEAN_CONTROL, SEEDED_DEFECTS } from "../../../validation/src/__tests__/seeded-defects.fixture.js";
import { startStdioServer, type StdioServer, type StdioServerOptions } from "./stdio-server.js";
import fixture from "./fixtures/define-delivery-command.json";
import { digest, makeReviewAuthority, makeReviewRepo } from "./fixtures/review-dossier.js";
import { RunFiles } from "../run-files.js";

type ReviewInvocation = Extract<NextAction, { kind: "spawn_subagents" }>;
type ReviewEvidence = { status: "clear" | "inconclusive" | "finding"; citations: { source_id: string; quote: string }[] };
const DECLARED_EDGE = "Some browsers deny clipboard access to pages that are not focused.";
const DECLARED_EXCLUSION = "no request leaves the page and nothing is stored.";
const CLOUD_REQUIREMENT = "Every copied snippet is saved to the reader's cloud account history.";
const EDGE_HANDLING = "If the browser denies clipboard access, show an error and preserve the current clipboard.";

function semanticFixture(scenario: string) {
  if (scenario === "scope_creep" || scenario === "missing_edge_case") {
    return SEEDED_DEFECTS.find(({ category }) => category === scenario)!.sections;
  }
  if (scenario !== "covered") return CLEAN_CONTROL;
  return SEEDED_DEFECTS.find(({ category }) => category === "missing_edge_case")!.sections.map(({ type, content }) => ({
    type,
    content: type === "requirements" ? content + "\n| FR-004 | " + EDGE_HANDLING + " | Must | Design review |"
      : type === "acceptance_criteria" ? content + "\n- AC-004 (FR-004): Denied clipboard access shows an error."
      : type === "testing" ? content + "\n| T-004 | AC-004 | Deny clipboard access and check the error. |" : content,
  }));
}

function semanticSections(scenario: string, raw: boolean) {
  return semanticFixture(scenario).map(({ type, content }) => ({
    section_type: type,
    // The historical fixture used leading references. Canonical handoff cases
    // put the same references after the statement as required by Define v1.
    content: type === "acceptance_criteria" && !raw
      ? content.replace(/^- (AC-\d+) \((FR-\d+)\): (.+)$/gm, "- $1: $3 ($2).")
      : content,
    status: "passed" as const, attempt: 1, violation_count: 0, last_violations: [], attempt_log: [],
  }));
}

function semanticFixtureResult(action: ReviewInvocation, scenario: string) {
  const prompt = action.invocations[0]!.prompt;
  const { sources } = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)) as {
    sources: { source_id: string; text: string }[];
  };
  const cite = (quote: string) => {
    const source = sources.find(x => x.text.includes(quote));
    expect(source, quote).toBeDefined();
    return { source_id: source!.source_id, quote };
  };
  const clear: ReviewEvidence = { status: "clear", citations: [] };
  const scope: ReviewEvidence = scenario === "scope_creep"
    ? { status: "finding", citations: [cite(DECLARED_EXCLUSION), cite(CLOUD_REQUIREMENT)] } : clear;
  const edge: ReviewEvidence = scenario === "missing_edge_case"
    ? { status: "finding", citations: [cite(DECLARED_EDGE)] }
    : scenario === "inconclusive" ? { status: "inconclusive", citations: [] }
    : scenario === "covered" ? { status: "clear", citations: [cite(DECLARED_EDGE), cite(EDGE_HANDLING)] } : clear;
  const raw = JSON.stringify({
    scope_creep: scenario === "invented_quote"
      ? { status: "finding", citations: [{ source_id: "request", quote: "invented" }, cite(DECLARED_EXCLUSION)] }
      : scope,
    missing_edge_case: edge,
  });
  return { kind: "subagent_batch_result", batch_id: action.batch_id,
    responses: [{ invocation_id: action.invocations[0]!.invocation_id, raw_text: raw }] };
}

async function finishSemanticSelfCheck(server: StdioServer, envelope: Envelope, scenario: string) {
  const canned = makeCannedDispatcher();
  while (["self_check", "finalize"].includes(envelope.current_step) || NextActionSchema.parse(envelope.action).kind === "write_file") {
    const action = NextActionSchema.parse(envelope.action);
    if (action.kind === "write_file") {
      envelope = await call<Envelope>(server, "submit_action_result", {
        run_id: envelope.run_id, result: { kind: "file_written", path: action.path, bytes: Buffer.byteLength(action.content) },
      });
    } else {
      expect(action.kind === "spawn_subagents" && action.batch_id.startsWith("self_check_scope_coverage_")).toBe(false);
      const result = canned(action);
      if (!result) throw new Error("Unhandled self-check action " + action.kind);
      if (scenario === "panel_fails" && result.kind === "subagent_batch_result") {
        for (const reply of result.responses) {
          const verdicts = JSON.parse(reply.raw_text!) as { verdict: string }[];
          reply.raw_text = JSON.stringify(verdicts.map(verdict => ({ ...verdict, verdict: "FAIL" })));
        }
      }
      envelope = await call<Envelope>(server, "submit_action_result", { run_id: envelope.run_id, result });
    }
  }
  return NextActionSchema.parse(envelope.action);
}

const SEMANTIC_ISSUE_CASES = [
  ["scope_creep", "scope_creep (finding)", true],
  ["missing_edge_case", "missing_edge_case (finding)", true],
  ["scope_creep", "scope_creep (finding)", false],
  ["missing_edge_case", "missing_edge_case (finding)", false],
  ["invented_quote", "current, complete scope and edge-case evidence is required", false],
  ["clean", null, false],
  ["covered", null, false],
  ["inconclusive", "missing_edge_case (inconclusive)", false],
  ["panel_fails", "carry a blocked verdict", false],
] as const;

it("starts automatic semantic review using the configured host model", async () => {
  const home = mkdtempSync(join(tmpdir(), "prd-gen-semantic-start-"));
  let server: StdioServer | undefined;
  try {
    server = await startDefineServer({ cwd: home, env: {
      HOME: home, USERPROFILE: home, PRD_GEN_SEMANTIC_REVIEW_MODEL: "gemini-argon",
    } });
    const { run_id } = await call<Envelope>(server, "start_pipeline", fixture.request);
    const { state } = await call<{ state: PipelineState }>(server, "get_pipeline_state", { run_id, format: "full" });
    expect(state.semantic_review_requested).toBe(true);
    expect(state.semantic_review_model).toBe("gemini-argon");
    expect(state.semantic_review).toBeUndefined();
  } finally {
    await server?.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

it.each(SEMANTIC_ISSUE_CASES)("validates host scope review evidence for %s (%s, raw %s) on MCP stdio", async (scenario, failure, raw) => {
  const home = mkdtempSync(join(tmpdir(), "prd-gen-semantic-review-"));
  const files = new RunFiles(join(home, ".prd-gen", "runs"));
  const run_id = "run_semantic_issue";
  const seed = newPipelineState({ run_id, feature_description: "Copy button for browser documentation.", semantic_review: true });
  const { state, action } = step({ state: {
    ...seed, current_step: "self_check",
    clarifications: [{ round: 1, question: "Should copying stay local?", answer: "Yes.", asked_at: seed.started_at }],
    sections: semanticSections(scenario, raw),
    written_files: [`prd-output/${run_id}/01-prd.md`],
  } });
  expect(action.kind).toBe("spawn_subagents");
  const start = () => startDefineServer({ cwd: home, env: { HOME: home, USERPROFILE: home } });
  let server: StdioServer | undefined;
  try {
    files.write(state, action);
    server = await start();
    const recovered = await call<Envelope>(server, "get_pipeline_state", { run_id, format: "action" });
    const judge = NextActionSchema.parse(recovered.action);
    if (judge.kind !== "spawn_subagents") throw new Error("Expected semantic review");
    expect(judge.batch_id).toMatch(/^self_check_scope_coverage_/);
    const result = semanticFixtureResult(judge, scenario);
    const response = await call<Envelope>(server, "submit_action_result", { run_id, result });
    const completion = await finishSemanticSelfCheck(server, response, scenario);
    expect(completion).toMatchObject({ kind: "done" });
    if (completion.kind !== "done") throw new Error("Expected autonomous review completion");
    if (failure) expect(completion.outcome).toMatchObject({
      status: "needs_attention", reasons: expect.arrayContaining([expect.stringContaining(failure)]),
    });
    await server.close();
    server = await start();
    const replay = await call<Envelope>(server, "submit_action_result", { run_id, result });
    expect(replay.action).toEqual(completion);
    const define = await server.call("get_pipeline_state", { run_id, format: "define_handoff_v1" });
    expect(define.isError, define.text).toBe(failure !== null);
    if (raw) expect(JSON.parse(define.text)).toMatchObject({ error: { code: "define_document_invalid" } });
    else if (failure) expect(JSON.parse(define.text)).toMatchObject({ error: {
      code: "define_not_ready",
      message: expect.stringContaining(scenario === "panel_fails" ? "detailed verification evidence" : failure),
    } });
    else expect(JSON.parse(define.text)).toMatchObject({ handoff: { run_id } });
    if (scenario === "clean") {
      const full = await call<{ state: PipelineState }>(server, "get_pipeline_state", { run_id, format: "full" });
      await server.close();
      const changed = full.state.clarifications.map(turn => ({ ...turn, question: "Should copies be saved remotely?" }));
      files.write({ ...full.state, clarifications: changed }, completion);
      server = await start();
      const stale = await server.call("get_pipeline_state", { run_id, format: "define_handoff_v1" });
      expect(stale.isError).toBe(true);
      expect(JSON.parse(stale.text)).toMatchObject({
        error: { code: "define_not_ready", message: expect.stringContaining("semantic_review") },
      });
    }
  } finally {
    await server?.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

interface Envelope {
  readonly run_id: string;
  readonly current_step: string;
  readonly action: unknown;
}

function startDefineServer(options: StdioServerOptions) {
  const root = process.env.PRD_GEN_TEST_PLUGIN_ROOT;
  if (!root) return startStdioServer(undefined, options);
  const { mcpServers } = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const launcher = mcpServers["prd-gen"]!;
  expect(launcher.command).toBe("node");
  const resolveRoot = (value: string) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
  const [entry, ...args] = launcher.args.map(resolveRoot);
  const env = Object.fromEntries(Object.entries(launcher.env).map(([name, value]) => [name, resolveRoot(value)]));
  return startStdioServer(undefined, { ...options, entry, args, env: { ...options.env, ...env } });
}

async function call<T>(server: StdioServer, tool: string, args: Record<string, unknown>): Promise<T> {
  const response = await server.call(tool, args);
  expect(response.isError, `${tool}: ${response.text}`).toBe(false);
  return JSON.parse(response.text) as T;
}

const PUBLISH = "With `--until ci`, publish the verified commit automatically.";
const STOP = "With `--until ci`, stop after CI and never publish the verified commit.";
type Pilot = "delivery" | "ready" | "empty" | "conflict" | "sourced";

function makeHost(output: string, pilot: Pilot) {
  const drafts: Readonly<Record<string, string>> = fixture.drafts;
  let requirementAttempts = 0;
  const canned = makeCannedDispatcher({ fake_section_draft: section => {
    expect(drafts, `draft for ${section}`).toHaveProperty(section);
    if (pilot === "empty") return "ok";
    if ((pilot === "ready" || pilot === "sourced") && section === "testing") {
      return "Replay AC-001 with a failed check, AC-002 with a CI-only stop, and AC-003 with an already published ref whose ruleset failed.";
    }
    if (pilot === "sourced" && section === "requirements") {
      const policy = ++requirementAttempts === 1 ? PUBLISH : STOP;
      return drafts[section]!.replace("Stop before publication with `--until ci`.", policy);
    }
    if (pilot === "conflict" && section === "overview") return PUBLISH;
    if (pilot === "conflict" && section === "requirements") {
      return drafts[section]!.replace("Stop before publication with `--until ci`.", STOP);
    }
    return drafts[section]!;
  } });
  const answers: string[] = [];
  const artifacts = new Map<string, string>();
  function respond(action: NextAction): ActionResult | undefined {
    if (action.kind === "ask_user" && action.question_id === "clarification_answer") {
      const turn = fixture.clarifications[answers.length];
      if (!turn) throw new Error("The host requested an unrecorded clarification answer");
      expect(action.header).toContain(turn.question);
      // The historical fixture leaves the target implicit. This variant names it.
      const answer = pilot === "sourced" && answers.length === 2 ? STOP : turn.answer;
      answers.push(answer);
      return { kind: "user_answer", question_id: action.question_id, selected: [], freeform: answer };
    }
    if (action.kind === "spawn_subagents" && action.batch_id.startsWith("clarification_compose_")) {
      const turn = fixture.clarifications[answers.length];
      if (!turn) throw new Error("The host requested an unrecorded clarification question");
      return { kind: "subagent_batch_result", batch_id: action.batch_id, responses: action.invocations.map(invocation => ({
        invocation_id: invocation.invocation_id, raw_text: JSON.stringify({ question: turn.question, options: null }),
      })) };
    }
    if (action.kind === "write_file") {
      const name = basename(action.path);
      expect(name).toMatch(/^\d{2}-[a-z-]+\.md$/);
      expect(artifacts.has(name)).toBe(false);
      writeFileSync(join(output, name), action.content, { flag: "wx" });
      artifacts.set(name, action.path);
    }
    return canned(action);
  }
  return { respond, answers, artifacts };
}

function actionLabel(action: NextAction): string {
  switch (action.kind) {
    case "ask_user": return `${action.kind}/${action.question_id}`;
    case "call_cortex_tool":
    case "call_pipeline_tool": return `${action.kind}/${action.tool_name}`;
    case "spawn_subagents": return `${action.kind}/${action.batch_id}`;
    case "write_file": return `${action.kind}/${basename(action.path)}`;
    default: return action.kind;
  }
}

async function driveToGate(
  server: StdioServer,
  host: ReturnType<typeof makeHost>,
  observeDraft?: (runId: string, action: Extract<NextAction, { kind: "spawn_subagents" }>) => Promise<StdioServer>,
) {
  let envelope = await call<Envelope>(server, "start_pipeline", fixture.request);
  const run_id = envelope.run_id;
  const trace: string[] = [];
  // Same ceiling as the local canned-run harness. The pilot stops at the first gate question.
  for (let count = 0; count < 300; count++) {
    expect(envelope.run_id).toBe(run_id);
    const action = NextActionSchema.parse(envelope.action);
    trace.push(`${envelope.current_step}/${actionLabel(action)}`);
    if (envelope.current_step === "implementation_gate" && action.kind === "ask_user") {
      return { run_id, action, trace };
    }
    if (action.kind === "spawn_subagents") {
      expect(["probe", "draft", "judge"]).toContain(action.purpose);
      if (observeDraft && action.batch_id.startsWith("section_generate_")) server = await observeDraft(run_id, action);
    }
    const result = host.respond(action);
    if (!result) throw new Error(`Run ended at ${envelope.current_step}/${action.kind} before the gate`);
    envelope = await call<Envelope>(server, "submit_action_result", { run_id, result });
  }
  throw new Error(`Run did not reach implementation_gate. Trace: ${trace.join(", ")}`);
}

it("drives the configured reviewer from start to a read-only Define handoff", async () => {
  const output = mkdtempSync(join(tmpdir(), "prd-gen-automatic-define-"));
  const server = await startDefineServer({ cwd: output, env: {
    HOME: output, USERPROFILE: output, PRD_GEN_SEMANTIC_REVIEW_MODEL: "gemini-argon",
  } });
  try {
    const host = makeHost(output, "ready");
    let envelope = await call<Envelope>(server, "start_pipeline", fixture.request);
    const { run_id } = envelope;
    const reviewed: string[] = [];
    for (let turn = 0; turn < 300; turn++) {
      const action = NextActionSchema.parse(envelope.action);
      if (action.kind === "done") {
        expect(action.outcome?.status, action.summary).toBe("passed");
        expect(reviewed).toHaveLength(1);
        const response = await call<{ handoff: { run_id: string } }>(server, "get_pipeline_state", {
          run_id, format: "define_handoff_v1",
        });
        expect(response.handoff.run_id).toBe(run_id);
        return;
      }
      if (envelope.current_step === "self_check" || envelope.current_step === "implementation_gate") {
        expect(action.kind).not.toBe("ask_user");
      }
      const result = action.kind === "spawn_subagents" && action.batch_id.startsWith("self_check_scope_coverage_")
        ? dispatchConfiguredReview(action, reviewed)
        : host.respond(action);
      if (!result) throw new Error("Unexpected action: " + actionLabel(action));
      envelope = await call<Envelope>(server, "submit_action_result", { run_id, result });
    }
    throw new Error("Automatic Define never reached done");
  } finally {
    await server.close();
    rmSync(output, { force: true, recursive: true });
  }
}, 120_000);

function dispatchConfiguredReview(action: ReviewInvocation, reviewed: string[]) {
  expect(action.invocations).toHaveLength(1);
  expect(action.invocations[0]?.model).toBe("gemini-argon");
  expect(reviewed).not.toContain(action.batch_id);
  reviewed.push(action.batch_id);
  return semanticFixtureResult(action, "clean");
}

it.each<{ name: string; pilot: Pilot; finding?: string }>([
  { name: "delivery-command specification", pilot: "delivery" },
  { name: "semantically empty specification", pilot: "empty", finding: "The requirements section must define at least one FR or NFR statement." },
  { name: "conflicting publication specification", pilot: "conflict", finding: "Conflicting publication instructions for --until ci" },
])("resumes the $name at Define without starting implementation", async ({ pilot, finding }) => {
  const output = mkdtempSync(join(tmpdir(), "prd-gen-define-"));
  const home = join(output, "home");
  mkdirSync(home);
  const start = () => startDefineServer({ cwd: output, env: { HOME: home, USERPROFILE: home } });
  const host = makeHost(output, pilot);
  let server: StdioServer | undefined;
  try {
    server = await start();
    const { run_id, action, trace } = await driveToGate(server, host);
    expect(action.question_id).toBe("implementation_gate");
    expect(trace).toMatchSnapshot();
    expect({ artifacts: [...host.artifacts.keys()], pendingDecision: action }).toMatchSnapshot("observed handoff");
    expect(host.answers).toEqual(fixture.clarifications.map(turn => turn.answer));
    const prd = readFileSync(join(output, "01-prd.md"), "utf8");
    if (pilot === "empty") {
      expect(prd).toMatch(/^ok$/m);
      expect(prd).not.toContain("FR-001:");
    } else {
      expect(prd).toContain("FR-001: Publish only the commit accepted by the local gate and CI.");
    }
    if (!finding) {
      expect(readFileSync(join(output, "10-verification-report.md"), "utf8")).toContain("Verification Report");
    }

    const readState = async (active: StdioServer) => {
      const full = await call<{ state: unknown; __bounded: { applied: unknown[] } }>(active, "get_pipeline_state", { run_id, format: "full" });
      expect(full.__bounded.applied).toEqual([]);
      return full.state;
    };
    const before = await readState(server);
    expect(before).toMatchObject({
      current_step: "implementation_gate",
      written_files: [...host.artifacts.values()],
      pending_completion: { outcome: { status: "needs_attention" } },
    });
    const handoff = await server.call("get_pipeline_state", { run_id, format: "define_handoff_v1" });
    expect(handoff.isError).toBe(true);
    expect(JSON.parse(handoff.text)).toMatchObject({
      error: { code: "define_document_invalid" },
    });
    if (finding) {
      expect(before).not.toMatchObject({ pending_completion: { summary: expect.stringContaining("Hard-output score: 1.00 / 1.00") } });
      expect(action.description).toContain(finding);
    }
    await server.close();
    server = await start();

    const recovered = await call<Envelope>(server, "get_pipeline_state", { run_id, format: "action" });
    expect(recovered).toMatchObject({ run_id, action });
    expect(await readState(server)).toEqual(before);
    if (finding) {
      const rejected = await server.call("submit_action_result", {
        run_id, result: { kind: "user_answer", question_id: "implementation_gate", selected: ["Implement"] },
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.parse(rejected.text)).toMatchObject({ error: { code: "architect_os_required" } });
      expect(await readState(server)).toEqual(before);

    }
  } finally {
    await server?.close();
    rmSync(output, { recursive: true, force: true });
  }
}, 120_000);

it("reads a validated Define v1 handoff at the gate and after restart", async () => {
  const output = mkdtempSync(join(tmpdir(), "prd-gen-define-v1-"));
  const start = () => startDefineServer({ cwd: output, env: { HOME: output, USERPROFILE: output } });
  const host = makeHost(output, "ready");
  let server: StdioServer | undefined;
  try {
    server = await start();
    const { run_id, action } = await driveToGate(server, host);
    const args = { run_id, format: "define_handoff_v1" };
    const planArgs = { run_id, format: "verified_plan_v1", plan_step: "delivery" };
    const checkpoint = new RunFiles(join(output, ".prd-gen", "runs")).pathOf(run_id)!;
    const savedBytes = readFileSync(checkpoint);
    const before = await call(server, "get_pipeline_state", { run_id, format: "full" });
    expect(before).toMatchObject({ state: {
      pending_completion: { outcome: { status: "passed" }, verification: expect.any(Object) },
      post_specs: { decision: "pending" },
    } });
    expect(action.options?.map(option => option.label)).toEqual(["PRD only", "Review verification findings"]);
    expect((await server.call("get_pipeline_state", { run_id, format: "define_handoff_v2" })).isError).toBe(true);
    const ready = await call(server, "get_pipeline_state", args);
    expect(ready).toMatchObject({
      handoff: {
        version: 1,
        run_id,
        requirements: [
          { id: "FR-001", text: "Publish only the commit accepted by the local gate and CI." },
          { id: "FR-002", text: "Stop before publication with `--until ci`." },
          { id: "FR-003", text: expect.any(String) },
        ],
        acceptance: [
          { id: "AC-001", requirement_ids: ["FR-001"] },
          { id: "AC-002", requirement_ids: ["FR-002"] },
          { id: "AC-003", requirement_ids: ["FR-003"] },
        ],
      },
    });
    expect(await call(server, "get_pipeline_state", args)).toEqual(ready);
    const plan = await call(server, "get_pipeline_state", planArgs);
    expect(plan).toMatchObject({ verified_plan: {
      run_id,
      proposal: { step: "delivery", acceptance_ids: ["AC-001", "AC-002", "AC-003"] },
    } });
    expect(await call(server, "get_pipeline_state", planArgs)).toEqual(plan);
    expect(readFileSync(checkpoint)).toEqual(savedBytes);
    const missingStep = await server.call("get_pipeline_state", { run_id, format: "verified_plan_v1" });
    expect(missingStep.isError).toBe(true);
    expect(JSON.parse(missingStep.text)).toMatchObject({ error: { code: "plan_step_invalid" } });
    expect(await call(server, "get_pipeline_state", { run_id, format: "full" })).toEqual(before);
    await server.close();
    server = await start();
    expect(await call(server, "get_pipeline_state", args)).toEqual(ready);
    expect(await call(server, "get_pipeline_state", planArgs)).toEqual(plan);
    expect(readFileSync(checkpoint)).toEqual(savedBytes);
    expect(await call(server, "get_pipeline_state", { run_id, format: "action" })).toMatchObject({ action });
    const { state } = await call<{ state: PipelineState }>(server, "get_pipeline_state", { run_id, format: "full" });
    const assertRefusedHandoff = async () => {
      for (const request of [args, planArgs]) {
        const response = await server!.call("get_pipeline_state", request);
        expect(response.isError).toBe(true);
        expect(JSON.parse(response.text)).toMatchObject({ error: { code: "define_not_ready" } });
      }
    };
    for (const withReport of [true, false]) {
      await server.close();
      new RunFiles(join(output, ".prd-gen", "runs")).write({
        ...state,
        written_files: withReport ? state.written_files : state.written_files.filter(path => !path.endsWith("10-verification-report.md")),
      }, { ...action, options: [{ label: "PRD only" }, { label: "Override policy (explicit)" }] });
      server = await start();
      await assertRefusedHandoff();

      const inspected = await call<Envelope>(server, "submit_action_result", {
        run_id, result: { kind: "user_answer", question_id: "implementation_gate", selected: ["Review verification findings"] },
      });
      const pending = NextActionSchema.parse(inspected.action);
      expect(pending.kind).toBe(withReport ? "ask_user" : "write_file");
      await server.close();
      server = await start();
      if (pending.kind === "write_file") {
        writeFileSync(join(output, basename(pending.path)), pending.content);
        await call(server, "submit_action_result", {
          run_id, result: { kind: "file_written", path: pending.path, bytes: Buffer.byteLength(pending.content) },
        });
      }
      await assertRefusedHandoff();
      await call(server, "submit_action_result", {
        run_id, result: { kind: "user_answer", question_id: "implementation_gate", selected: ["unrecognized choice"] },
      });
      await server.close();
      server = await start();
      await assertRefusedHandoff();
    }

  } finally {
    await server?.close();
    rmSync(output, { recursive: true, force: true });
  }
}, 120_000);

it("serves the ticketed Define of the gate after PRD only, across restarts", async () => {
  const output = mkdtempSync(join(tmpdir(), "prd-gen-define-tickets-"));
  const start = () => startDefineServer({ cwd: output, env: { HOME: output, USERPROFILE: output } });
  const host = makeHost(output, "ready");
  const files = new RunFiles(join(output, ".prd-gen", "runs"));
  let server: StdioServer | undefined;
  try {
    server = await start();
    const { run_id, action } = await driveToGate(server, host);
    const args = { run_id, format: "define_handoff_v1" };
    const planArgs = { run_id, format: "verified_plan_v1", plan_step: "delivery" };
    const atGate = await server.call("get_pipeline_state", args);
    expect(atGate.isError).toBeFalsy();
    expect(JSON.parse(atGate.text).handoff.tickets).toEqual([
      { id: "TICKET-001", story_points: 1, depends_on: [], acceptance_ids: ["AC-001"] },
      { id: "TICKET-002", story_points: 2, depends_on: ["TICKET-001"], acceptance_ids: ["AC-002"] },
      { id: "TICKET-003", story_points: 3, depends_on: ["TICKET-002"], acceptance_ids: ["AC-003"] },
    ]);
    const planAtGate = await server.call("get_pipeline_state", planArgs);
    // The reply text is the Define the plan binds: architect-os writes it plus LF.
    expect(JSON.parse(planAtGate.text).verified_plan.define_sha256)
      .toBe(createHash("sha256").update(atGate.text + "\n").digest("hex"));
    expect(readFileSync(join(output, "07-jira-tickets.md"), "utf8")).toContain("#### TICKET-003 — Deliver AC-003");

    let envelope = await call<Envelope>(server, "submit_action_result", {
      run_id, result: { kind: "user_answer", question_id: action.question_id, selected: ["PRD only"] },
    });
    let last: ActionResult | undefined;
    for (let count = 0; envelope.current_step !== "complete" && count < 10; count++) {
      const result = host.respond(NextActionSchema.parse(envelope.action));
      if (!result) break;
      last = result;
      envelope = await call<Envelope>(server, "submit_action_result", { run_id, result });
    }
    expect(envelope).toMatchObject({ current_step: "complete", action: { kind: "done" } });
    // A host that lost the final response retries it: the run keeps its terminal action and its Define.
    const retried = await call<Envelope>(server, "submit_action_result", { run_id, result: last });
    expect(retried.action).toEqual(envelope.action);
    expect((await server.call("get_pipeline_state", args)).text).toBe(atGate.text);
    await server.close();
    server = await start();
    expect((await server.call("get_pipeline_state", args)).text).toBe(atGate.text);
    expect((await server.call("get_pipeline_state", planArgs)).text).toBe(planAtGate.text);

    const { state } = await call<{ state: PipelineState }>(server, "get_pipeline_state", { run_id, format: "full" });
    const done = NextActionSchema.parse(envelope.action);
    const reread = async (checkpoint: PipelineState) => {
      await server!.close();
      files.write(checkpoint, done);
      server = await start();
      return Promise.all([args, planArgs].map(request => server!.call("get_pipeline_state", request)));
    };
    const [handoff, plan] = await reread({ ...state, passed_define: undefined });
    for (const refused of [handoff!, plan!]) {
      expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.text)).toMatchObject({ error: { code: "define_not_pending" } });
    }
    if (state.jira_result?.status !== "passed") throw new Error("Expected generated tickets");
    const [first, second] = state.jira_result.tickets;
    const estimate = { ...state, jira_result: { status: "passed" as const, tickets: [{ ...first!, story_points: 5 }, ...state.jira_result.tickets.slice(1)] } };
    for (const response of await reread(estimate)) {
      expect(JSON.parse(response.text)).toMatchObject({ error: { code: "define_not_ready", message: expect.stringContaining("no longer projects") } });
    }
    // A checkpoint whose "passed" tickets form a cycle is not a valid checkpoint: it does not load.
    const cycle = { ...state, jira_result: { status: "passed" as const, tickets: [{ ...first!, depends_on: [second!.id] }, ...state.jira_result.tickets.slice(1)] } };
    await server.close();
    files.write(cycle, done);
    server = await start();
    const refusedCycle = await server.call("get_pipeline_state", args);
    expect(refusedCycle.isError).toBe(true);
    expect(JSON.parse(refusedCycle.text)).not.toHaveProperty("handoff");
  } finally {
    await server?.close();
    rmSync(output, { recursive: true, force: true });
  }
}, 120_000);

async function assertReviewRefusal(
  server: StdioServer, args: Record<string, unknown>, code: string,
) {
  const response = await server.call("get_pipeline_state", args);
  expect(response.isError).toBe(true);
  expect(JSON.parse(response.text)).toEqual({ error: { code, message: expect.any(String) } });
}

it("prepares a review of the operator-approved revisions through the packaged tool", async () => {
  const output = mkdtempSync(join(tmpdir(), "prd-gen-review-v1-"));
  const candidate = makeReviewRepo(output);
  const authorityFile = join(output, "approval.json");
  const env = {
    HOME: output, USERPROFILE: output,
    PRD_GEN_REVIEW_REPOSITORY: candidate.repo,
    PRD_GEN_REVIEW_REPOSITORY_ID: "fixture/review",
    PRD_GEN_REVIEW_GIT: candidate.gitExecutable,
  };
  const start = (path: string, overrides?: Record<string, string>) => startDefineServer({
    cwd: output, env: { ...env, PRD_GEN_REVIEW_AUTHORITY: path, ...overrides },
  });
  let server: StdioServer | undefined;
  try {
    server = await start(authorityFile);
    const { run_id } = await driveToGate(server, makeHost(output, "ready"));
    const args = { run_id, format: "implementation_review_v1", plan_step: "delivery", review_id: "delivery-review" };
    const { verified_plan: plan } = await call<{ verified_plan: {
      run_id: string; plan_sha256: string; define_sha256: string; proposal_sha256: string;
    } }>(server, "get_pipeline_state", { ...args, format: "verified_plan_v1" });
    const authority = makeReviewAuthority(plan, candidate);
    const save = (patch: Partial<typeof authority> = {}) => writeFileSync(authorityFile, JSON.stringify({ ...authority, ...patch }));
    await assertReviewRefusal(server, args, "review_evidence_unavailable");
    save();
    const { implementation_review: review } = await call<{ implementation_review: { diff: string } }>(
      server, "get_pipeline_state", args,
    );
    expect(review).toMatchObject({
      status: "ready_for_review", base_revision: candidate.base, reviewed_revision: candidate.head,
      plan_sha256: plan.plan_sha256, approval_sha256: authority.decision.approval_sha256,
      diff_sha256: digest(review.diff),
      acceptance: ["AC-001", "AC-002", "AC-003"].map(id => ({ id, status: "evidence_required" })),
    });
    expect(review.diff).toContain("rename from old.txt");
    expect(review.diff).toContain("rename to receipt.txt");
    expect(review.diff).toContain("deleted file mode");
    expect(review.diff).not.toMatch(/large\.txt|uncommitted change/);
    writeFileSync(join(candidate.repo, ".gitattributes"), "*.txt -diff\n");
    expect(await call(server, "get_pipeline_state", args)).toEqual({ implementation_review: review });
    await assertReviewRefusal(server, { ...args, review_id: "wrong-review" }, "review_authority_invalid");
    save({ decision: { ...authority.decision, approval_sha256: "a".repeat(64) } });
    await assertReviewRefusal(server, args, "review_authority_invalid");
    save({ base_revision: candidate.large });
    await assertReviewRefusal(server, args, "review_revision_invalid");
    save({ reviewed_revision: candidate.large });
    await assertReviewRefusal(server, args, "review_response_too_large");
    await server.close();
    save();
    const fork = join(output, "other-repository");
    candidate.git("clone", "-q", candidate.repo, fork);
    server = await start(authorityFile, {
      PRD_GEN_REVIEW_REPOSITORY: fork, PRD_GEN_REVIEW_REPOSITORY_ID: "fixture/other",
    });
    await assertReviewRefusal(server, args, "review_repository_invalid");
    await server.close();
    if (process.platform !== "win32") {
      const linked = join(output, "linked");
      candidate.git("worktree", "add", "--quiet", "--detach", linked, candidate.head);
      const binary = join(candidate.repo, ".git", "never-run");
      const invoked = binary + ".invoked";
      writeFileSync(binary, '#!/bin/sh\n: > "$0.invoked"\n', { mode: 0o700 });
      server = await start(authorityFile, {
        PRD_GEN_REVIEW_REPOSITORY: linked, PRD_GEN_REVIEW_GIT: binary,
      });
      await assertReviewRefusal(server, args, "review_authority_invalid");
      expect(existsSync(invoked)).toBe(false);
      await server.close();
      server = await start(authorityFile, { PRD_GEN_REVIEW_REPOSITORY: linked });
      expect(await call(server, "get_pipeline_state", args)).toEqual({ implementation_review: review });
      await server.close();
    }
    const inside = join(candidate.repo, "approval.json");
    writeFileSync(inside, readFileSync(authorityFile));
    const shortcut = join(output, "candidate-link");
    symlinkSync(candidate.repo, shortcut, "junction");
    server = await start(join(shortcut, "approval.json"));
    await assertReviewRefusal(server, args, "review_authority_invalid");
  } finally {
    await server?.close();
    rmSync(output, { recursive: true, force: true });
  }
}, 120_000);

it("reports quantity and publication contradictions through the MCP validator", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "prd-gen-define-verifier-"));
  let server: StdioServer | undefined;
  try {
    server = await startDefineServer({ cwd: scratch, env: { HOME: scratch, USERPROFILE: scratch } });
    const verify = (active: StdioServer, overview: string, requirement: string) =>
      call<{ violations: { rule: string; message: string }[] }>(active, "validate_prd_document", { sections: [
        { type: "requirements", content: `- FR-001: ${requirement}` },
        { type: "overview", content: overview },
      ] });

    const quantities = await verify(server, "- NFR-001: The verification link expires after three hours.",
      "The verification link expires after one hour.");
    expect(quantities.violations).toContainEqual(expect.objectContaining({
      rule: "contradictory_requirements", message: expect.stringContaining("FR-001"),
    }));
    const publication = await verify(server, PUBLISH, STOP);
    expect(publication.violations).toContainEqual(expect.objectContaining({
      rule: "contradictory_publication_policy",
      message: expect.stringContaining("FR-001"),
    }));
  } finally {
    await server?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);

it.each([
  "Implement", "Implement anyway (dérogation explicite)", "Override policy (explicit)",
])("retires %s from an old saved gate", async (savedOption) => {
  const home = mkdtempSync(join(tmpdir(), "prd-gen-define-legacy-"));
  const run_id = "run_legacy_define";
  const formerReport = `prd-output/${run_id}/10-verification-report.md`;
  const files = new RunFiles(join(home, ".prd-gen", "runs"));
  const old = newPipelineState({ run_id, feature_description: "Legacy delivery PRD" });
  files.write({
    ...old,
    current_step: "implementation_gate",
    sections: [
      { section_type: "overview", status: "passed", content: "Validate a delivery.", attempt: 1, violation_count: 0, last_violations: [], attempt_log: [] },
      { section_type: "requirements", status: "failed", attempt: 1, violation_count: 1, last_violations: [], attempt_log: [] },
      { section_type: "acceptance_criteria", status: "passed", content: "", attempt: 1, violation_count: 0, last_violations: [], attempt_log: [] },
    ],
    written_files: [`prd-output/${run_id}/01-prd.md`, formerReport],
    pending_completion: {
      summary: "Self-check complete.\nHard-output score: 1.00 / 1.00",
      artifacts: [],
      outcome: { status: "passed", reasons: [] },
    },
  }, {
    kind: "ask_user", question_id: "implementation_gate", header: "Proceed to implementation?",
    description: "The PRD/specs are ready.", multi_select: false,
    options: [{ label: "PRD only" }, { label: savedOption }],
  });
  let server: StdioServer | undefined;
  try {
    server = await startDefineServer({ cwd: home, env: { HOME: home, USERPROFILE: home } });
    const recovered = await call<Envelope>(server, "get_pipeline_state", { run_id, format: "action" });
    expect(recovered.action).toMatchObject({
      kind: "ask_user",
      description: expect.stringContaining("The requirements section must define"),
      options: [expect.objectContaining({ label: "PRD only" }), expect.objectContaining({ label: "Review verification findings" })],
    });
    const submit = (result: ActionResult) => call<Envelope>(server!, "submit_action_result", { run_id, result });
    const rejected = await server.call("submit_action_result", {
      run_id, result: { kind: "user_answer", question_id: "implementation_gate", selected: [], freeform: savedOption },
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(rejected.text)).toMatchObject({ error: { code: "architect_os_required" } });
    expect(await call<Envelope>(server, "get_pipeline_state", { run_id, format: "action" })).toEqual(recovered);
    const choice = await submit({ kind: "user_answer", question_id: "implementation_gate", selected: ["PRD only"] });
    const report = NextActionSchema.parse(choice.action);
    expect(report).toMatchObject({
      kind: "write_file",
      path: formerReport,
      content: expect.stringContaining("Computed status: blocked"),
    });

    const acknowledged = await submit({ kind: "file_written", path: formerReport, bytes: 1 });
    const dispatch = makeCannedDispatcher();
    const next = NextActionSchema.parse(acknowledged.action);
    const done = next.kind === "done" ? next : NextActionSchema.parse((await submit(dispatch(next)!)).action);
    expect(done).toMatchObject({ kind: "done", outcome: { status: "needs_attention" }, summary: expect.stringContaining("Hard-output score: 0.70 / 1.00") });
  } finally {
    await server?.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);


it("reuses sourced decisions across drafts and retry, then rechecks saved decisions on restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "prd-gen-define-decisions-"));
  const start = () => startDefineServer({ cwd: home, env: { HOME: home, USERPROFILE: home } });
  let server = await start();
  try {
    const observed = new Map<string, string[]>();
    const { run_id, action } = await driveToGate(server, makeHost(home, "sourced"), async (runId, draft) => {
      const prompt = draft.invocations[0]!.prompt;
      const registers = observed.get(draft.batch_id) ?? [];
      registers.push(prompt.match(/<decision_register>[\s\S]*?<\/decision_register>/)?.[0] ?? "");
      observed.set(draft.batch_id, registers);
      if (draft.batch_id === "section_generate_requirements" && registers.length === 2) {
        const { state } = await call<{ state: PipelineState }>(server, "get_pipeline_state", { run_id: runId, format: "full" });
        expect(state.sections.find(section => section.section_type === "requirements")?.violation_count).toBe(1);
        if (state.retry_policy?.arm === "without_prior_violations") {
          expect(prompt).not.toContain("opposing the user publication decision");
        } else {
          expect(prompt).toContain("requirements/FR-002");
          expect(prompt).toContain("opposing the user publication decision from clarification:");
        }
        await server.close();
        server = await start();
        expect(await call(server, "get_pipeline_state", { run_id: runId, format: "action" })).toMatchObject({ action: draft });
      }
      return server;
    });
    const overview = observed.get("section_generate_overview")![0]!;
    expect(overview).toContain('"sources":["clarification:');
    expect(overview).toContain('"direction":"refuse"');
    expect(observed.get("section_generate_requirements")).toEqual([overview, overview]);
    expect(observed.get("section_generate_acceptance_criteria")).toEqual([overview]);
    const args = { run_id, format: "define_handoff_v1" };
    expect(await call(server, "get_pipeline_state", args)).toMatchObject({
      handoff: { run_id, requirements: expect.arrayContaining([{ id: "FR-002", text: STOP }]) },
    });

    const { state } = await call<{ state: PipelineState }>(server, "get_pipeline_state", { run_id, format: "full" });
    const source = state.clarifications.find(turn => turn.answer === STOP)!;
    const index = state.clarifications.indexOf(source);
    const files = new RunFiles(join(home, ".prd-gen", "runs"));
    const requireRefusal = async (saved: PipelineState, expected: string[]) => {
      await server.close();
      files.write(saved, action);
      server = await start();
      const failure = await server.call("get_pipeline_state", args);
      expect(failure.isError).toBe(true);
      const parsed = JSON.parse(failure.text) as { error: { code: string; message: string } };
      expect(parsed.error.code).toBe("define_document_invalid");
      for (const evidence of expected) expect(parsed.error.message).toContain(evidence);
    };
    // An old gate accepted individually valid drafts and saved no source checks.
    await requireRefusal({
      ...state,
      sections: state.sections.map(section => section.section_type === "requirements"
        ? { ...section, content: section.content!.replace(STOP, PUBLISH) }
        : section),
    }, ["requirements/FR-002", `clarification:${source.round}:${index + 1}`]);
    await requireRefusal({
      ...state,
      // The source is the only place that records a policy on this target.
      sections: state.sections.map(section => {
        if (section.section_type === "requirements") return { ...section, content: fixture.drafts.requirements };
        if (section.section_type === "acceptance_criteria") {
          const traced = PUBLISH.replace(/\.$/, " (FR-002).");
          return { ...section, content: section.content!.replace(/^(- AC-002: ).*$/m, `$1${traced}`) };
        }
        return section;
      }),
    }, ["acceptance_criteria/AC-002", "FR-002", `clarification:${source.round}:${index + 1}`]);
    await requireRefusal({
      ...state,
      feature_description: PUBLISH,
    }, ["Conflicting user publication decisions", "user-request", `clarification:${source.round}:${index + 1}`]);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

it("does not reissue or acknowledge saved execution after restarting the manifest launcher", async () => {
  const home = mkdtempSync(join(tmpdir(), "prd-gen-legacy-execution-"));
  const files = new RunFiles(join(home, ".prd-gen", "runs"));
  const run_id = "run_legacy_execution";
  const seed = newPipelineState({ run_id, feature_description: "Legacy implementation" });
  const retired: NextAction = {
    kind: "spawn_subagents", purpose: "implement", batch_id: "implementation_engineer",
    invocations: [{ invocation_id: "implementation_engineer", model: "haiku", description: "Legacy",
      prompt: "Historical action must not be exposed", subagent_type: "engineer", isolation: "worktree" }],
  };
  let server: StdioServer | undefined;
  try {
    for (const current_step of ["implementation", "input_analysis"] as const) {
      files.write({ ...seed, current_step }, retired);
      const path = files.pathOf(run_id)!;
      const before = readFileSync(path);
      server = await startDefineServer({ cwd: home, env: { HOME: home, USERPROFILE: home } });
      const full = await call<{ state: PipelineState }>(server, "get_pipeline_state", { run_id, format: "full" });
      expect(full.state.current_step).toBe(current_step);
      for (const invocation_offset of [0, 1]) {
        const recovered = await server.call("get_pipeline_state", { run_id, format: "action", invocation_offset });
        expect(recovered.isError).toBe(true);
        expect(JSON.parse(recovered.text)).toMatchObject({ error: { code: "architect_os_required" } });
      }
      const late = await server.call("submit_action_result", { run_id, result: {
        kind: "subagent_batch_result", batch_id: retired.batch_id,
        responses: [{ invocation_id: "implementation_engineer", raw_text: "late legacy result" }],
      } });
      expect(late.isError).toBe(true);
      expect(JSON.parse(late.text)).toMatchObject({ error: { code: "architect_os_required" } });
      expect(readFileSync(path)).toEqual(before);
      await server.close();
      server = undefined;
    }
  } finally {
    await server?.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);
