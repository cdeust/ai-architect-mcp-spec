import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { makeCannedDispatcher, NextActionSchema, type ActionResult, type NextAction } from "@prd-gen/orchestration";
import { startStdioServer, type StdioServer } from "./stdio-server.js";
import fixture from "./fixtures/define-delivery-command.json";

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

function makeHost(output: string, draftOverride?: string) {
  const drafts: Readonly<Record<string, string>> = fixture.drafts;
  const canned = makeCannedDispatcher({ fake_section_draft: section => {
    expect(drafts, `draft for ${section}`).toHaveProperty(section);
    return draftOverride ?? drafts[section]!;
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

// Characterization of the producer baseline. The false positive is a defect for the reconciliation phase.
it.each([
  { name: "delivery-command specification", draftOverride: undefined, status: "needs_attention" },
  { name: "semantically empty specification", draftOverride: "ok", status: "passed" },
])("resumes the $name at Define without starting implementation", async ({ draftOverride, status }) => {
  const output = mkdtempSync(join(tmpdir(), "prd-gen-define-"));
  const home = join(output, "home");
  mkdirSync(home);
  const start = () => startStdioServer(undefined, { cwd: output, env: { HOME: home, USERPROFILE: home } });
  const host = makeHost(output, draftOverride);
  let server: StdioServer | undefined;
  try {
    server = await start();
    const { run_id, action, trace } = await driveToGate(server, host);
    expect(action.question_id).toBe("implementation_gate");
    expect(trace).toMatchSnapshot();
    expect({ artifacts: [...host.artifacts.keys()], pendingDecision: action }).toMatchSnapshot("observed handoff");
    expect(host.answers).toEqual(fixture.clarifications.map(turn => turn.answer));
    const prd = readFileSync(join(output, "01-prd.md"), "utf8");
    if (draftOverride) {
      expect(prd).toMatch(/^ok$/m);
      expect(prd).not.toContain("FR-001:");
    } else {
      expect(prd).toContain("FR-001: Publish only the commit accepted by the local gate and CI.");
    }
    expect(readFileSync(join(output, "10-verification-report.md"), "utf8")).toContain("Verification Report");

    const readState = async (active: StdioServer) => {
      const full = await call<{ state: unknown; __bounded: { applied: unknown[] } }>(active, "get_pipeline_state", { run_id, format: "full" });
      expect(full.__bounded.applied).toEqual([]);
      return full.state;
    };
    const before = await readState(server);
    expect(before).toMatchObject({
      current_step: "implementation_gate",
      written_files: [...host.artifacts.values()],
      pending_completion: { outcome: { status } },
    });
    if (draftOverride) {
      expect(before).toMatchObject({ pending_completion: { summary: expect.stringContaining("Hard-output score: 1.00 / 1.00") } });
    }
    await server.close();
    server = await start();

    const recovered = await call<Envelope>(server, "get_pipeline_state", { run_id, format: "action" });
    expect(recovered).toMatchObject({ run_id, action });
    expect(await readState(server)).toEqual(before);
  } finally {
    await server?.close();
    rmSync(output, { recursive: true, force: true });
  }
}, 120_000);

it("characterizes which cross-section contradictions the document verifier reports", async () => {
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
    const publication = await verify(server, "With `--until ci`, publish the verified commit automatically.",
      "With `--until ci`, stop after CI and never publish the verified commit.");
    expect(publication.violations.map(finding => finding.rule)).not.toContain("contradictory_requirements");
  } finally {
    await server?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
