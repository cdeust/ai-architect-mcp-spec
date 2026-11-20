import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { makeCannedDispatcher, newPipelineState, NextActionSchema, type ActionResult, type NextAction } from "@prd-gen/orchestration";
import { startStdioServer, type StdioServer } from "./stdio-server.js";
import fixture from "./fixtures/define-delivery-command.json";
import { RunFiles } from "../run-files.js";

interface Envelope {
  readonly run_id: string;
  readonly current_step: string;
  readonly action: unknown;
}

async function call<T>(server: StdioServer, tool: string, args: Record<string, unknown>): Promise<T> {
  const response = await server.call(tool, args);
  expect(response.isError, `${tool}: ${response.text}`).toBe(false);
  return JSON.parse(response.text) as T;
}

const PUBLISH = "With `--until ci`, publish the verified commit automatically.";
const STOP = "With `--until ci`, stop after CI and never publish the verified commit.";
type Pilot = "delivery" | "empty" | "conflict";

function makeHost(output: string, pilot: Pilot) {
  const drafts: Readonly<Record<string, string>> = fixture.drafts;
  const canned = makeCannedDispatcher({ fake_section_draft: section => {
    expect(drafts, `draft for ${section}`).toHaveProperty(section);
    if (pilot === "empty") return "ok";
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
      answers.push(turn.answer);
      return { kind: "user_answer", question_id: action.question_id, selected: [], freeform: turn.answer };
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

async function driveToGate(server: StdioServer, host: ReturnType<typeof makeHost>) {
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
    }
    const result = host.respond(action);
    if (!result) throw new Error(`Run ended at ${envelope.current_step}/${action.kind} before the gate`);
    envelope = await call<Envelope>(server, "submit_action_result", { run_id, result });
  }
  throw new Error(`Run did not reach implementation_gate. Trace: ${trace.join(", ")}`);
}

it.each<{ name: string; pilot: Pilot; finding?: string }>([
  { name: "delivery-command specification", pilot: "delivery" },
  { name: "semantically empty specification", pilot: "empty", finding: "The requirements section must define at least one FR or NFR statement." },
  { name: "conflicting publication specification", pilot: "conflict", finding: "Conflicting publication instructions for --until ci" },
])("resumes the $name at Define without starting implementation", async ({ pilot, finding }) => {
  const output = mkdtempSync(join(tmpdir(), "prd-gen-define-"));
  const home = join(output, "home");
  mkdirSync(home);
  const start = () => startStdioServer(undefined, { cwd: output, env: { HOME: home, USERPROFILE: home } });
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
      const answer = (selected: string) => call<Envelope>(server!, "submit_action_result", {
        run_id,
        result: { kind: "user_answer", question_id: "implementation_gate", selected: [selected] },
      });
      const rejected = await answer("Implement");
      expect(rejected).toMatchObject({
        current_step: "implementation_gate",
        action: { kind: "ask_user", question_id: "implementation_gate", options: action.options },
      });
      expect(await readState(server)).toMatchObject({ post_specs: { decision: "pending" } });

      const overridden = await answer("Override policy (explicit)");
      expect(overridden.current_step).toBe("implementation_gate");
      const report = NextActionSchema.parse(overridden.action);
      expect(report).toMatchObject({
        kind: "write_file",
        content: expect.stringContaining("Computed status: blocked"),
      });
      expect(await readState(server)).toMatchObject({
        post_specs: { decision: "implement", policy_derogation: { policy_status: "blocked" } },
      });
    }
  } finally {
    await server?.close();
    rmSync(output, { recursive: true, force: true });
  }
}, 120_000);

it("reports quantity and publication contradictions through the MCP validator", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "prd-gen-define-verifier-"));
  let server: StdioServer | undefined;
  try {
    server = await startStdioServer(undefined, { cwd: scratch, env: { HOME: scratch, USERPROFILE: scratch } });
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
  { savedOption: "Implement", answer: "PRD only" },
  { savedOption: "Implement anyway (dérogation explicite)", answer: "Override policy (explicit)" },
])("updates the old $savedOption choice and accepts $answer", async ({ savedOption, answer }) => {
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
    server = await startStdioServer(undefined, { cwd: home, env: { HOME: home, USERPROFILE: home } });
    const recovered = await call<Envelope>(server, "get_pipeline_state", { run_id, format: "action" });
    expect(recovered.action).toMatchObject({
      kind: "ask_user",
      description: expect.stringContaining("The requirements section must define"),
      options: [expect.objectContaining({ label: "PRD only" }), expect.objectContaining({ label: "Override policy (explicit)" })],
    });
    const submit = (result: ActionResult) => call<Envelope>(server!, "submit_action_result", { run_id, result });
    const choice = await submit({ kind: "user_answer", question_id: "implementation_gate", selected: [answer] });
    const report = NextActionSchema.parse(choice.action);
    expect(report).toMatchObject({
      kind: "write_file",
      path: formerReport,
      content: expect.stringContaining("Computed status: blocked"),
    });

    const acknowledged = await submit({ kind: "file_written", path: formerReport, bytes: 1 });
    if (answer === "Override policy (explicit)") {
      expect(acknowledged.current_step).toBe("implementation");
      return;
    }
    const dispatch = makeCannedDispatcher();
    const next = NextActionSchema.parse(acknowledged.action);
    const done = next.kind === "done" ? next : NextActionSchema.parse((await submit(dispatch(next)!)).action);
    expect(done).toMatchObject({ kind: "done", outcome: { status: "needs_attention" }, summary: expect.stringContaining("Hard-output score: 0.70 / 1.00") });
  } finally {
    await server?.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);
