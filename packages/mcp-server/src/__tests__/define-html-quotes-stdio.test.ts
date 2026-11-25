import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { makeCannedDispatcher, NextActionSchema, type NextAction } from "@prd-gen/orchestration";
import { expect, it } from "vitest";
import fixture from "./fixtures/define-delivery-command.json";
import { startStdioServer, type StdioServer } from "./stdio-server.js";

const mention = "Render quotes with the <blockquote> element.";
const drafts: Readonly<Record<string, string>> = {
  ...fixture.drafts,
  requirements: fixture.drafts.requirements.replace("FR-001: ", `FR-001: ${mention} `),
  testing: "Replay AC-001 with a failed check, AC-002 with a CI-only stop, and AC-003 with an already published ref whose ruleset failed.",
};

function fixtureHost(directory: string) {
  const canned = makeCannedDispatcher({ fake_section_draft: section => drafts[section]! });
  let answered = 0;
  return (action: NextAction) => {
    if (action.kind === "spawn_subagents" && action.batch_id.startsWith("clarification_compose_")) {
      const { question } = fixture.clarifications[answered]!;
      return { kind: "subagent_batch_result", batch_id: action.batch_id, responses: action.invocations.map(invocation => ({
        invocation_id: invocation.invocation_id, raw_text: JSON.stringify({ question, options: null }),
      })) };
    }
    if (action.kind === "ask_user" && action.question_id === "clarification_answer") {
      return { kind: "user_answer", question_id: action.question_id, selected: [], freeform: fixture.clarifications[answered++]!.answer };
    }
    if (action.kind === "write_file") writeFileSync(join(directory, basename(action.path)), action.content, { flag: "wx" });
    return canned(action);
  };
}

async function reachGate(server: StdioServer, directory: string) {
  const respond = fixtureHost(directory);
  let reply = await server.call("start_pipeline", fixture.request);
  // source: define-boundary-stdio.test.ts driveToGate, same fixture and action ceiling
  for (let step = 0; step < 300; step++) {
    expect(reply.isError, reply.text).toBe(false);
    const { run_id, current_step, action: raw } = JSON.parse(reply.text);
    const action = NextActionSchema.parse(raw);
    if (current_step === "implementation_gate" && action.kind === "ask_user") return run_id as string;
    const result = respond(action);
    if (!result) throw new Error(`Fixture ended at ${current_step}/${action.kind}`);
    reply = await server.call("submit_action_result", { run_id, result });
  }
  throw new Error("Fixture did not reach implementation_gate");
}

it("hands off every fixture requirement when the first one mentions an HTML tag", async () => {
  const home = mkdtempSync(join(tmpdir(), "prd-gen-quote-handoff-"));
  let server: StdioServer | undefined;
  try {
    server = await startStdioServer(undefined, { cwd: home, env: { HOME: home, USERPROFILE: home } });
    const run_id = await reachGate(server, home);
    const handoff = await server.call("get_pipeline_state", { run_id, format: "define_handoff_v1" });
    expect(handoff.isError, handoff.text).toBe(false);
    expect(JSON.parse(handoff.text).handoff.requirements).toEqual([
      { id: "FR-001", text: mention + " Publish only the commit accepted by the local gate and CI." },
      { id: "FR-002", text: "Stop before publication with `--until ci`." },
      { id: "FR-003", text: "Recheck both destination refs on resume and require a passing ruleset result for a ref that was already advanced." },
    ]);
  } finally {
    await server?.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000); // source: define-boundary-stdio.test.ts full fixture timeout
