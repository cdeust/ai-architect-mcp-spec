import { addCost, finishRecord } from "./run-record.js";
import { makeCannedDispatcher, newPipelineState, step, type ActionResult, type SpawnSubagentsAction } from "@prd-gen/orchestration";
import type { Invocation, Ports, Row, RunPlan, RunRecord, Settings, Stopped } from "./types.js";

function settingsFor(inv: Invocation, policy: RunPlan["policy"]): Settings {
  const override = policy === "as-emitted" ? undefined : policy[inv.purpose];
  return override ?? { model: inv.model ?? "session", effort: inv.effort ?? "session" };
}

async function measure(inv: Invocation, batch_id: string, plan: RunPlan, ports: Ports) {
  const used = settingsFor(inv, plan.policy);
  const row: Row = {
    batch_id,
    invocation_id: inv.invocation_id,
    purpose: inv.purpose,
    agent_type: inv.subagent_type,
    isolation: inv.isolation,
    prompt_characters: Array.from(inv.prompt).length,
    requested: {
      model: inv.model ?? null,
      effort: inv.effort ?? null,
    },
    used,
    workspace_kept: false,
    usage: null,
    error: null,
  };
  try {
    const result = await ports.invoke(inv, used, row);
    row.usage = result.usage;
    row.error = result.error ?? null;
    const response = row.error === null ? { raw_text: result.text } : { error: row.error };
    return { row, response: { invocation_id: inv.invocation_id, ...response } };
  } catch (cause) {
    row.error = cause instanceof Error ? cause.message : String(cause);
    return { row, response: { invocation_id: inv.invocation_id, error: row.error } };
  }
}

type BatchResult = Extract<ActionResult, { kind: "subagent_batch_result" }>;

function stopped(reason: Stopped["reason"]): Stopped {
  return { kind: "stopped", reason };
}

interface Measurements {
  rows: Row[];
  cost_usd: number;
  unmetered_calls: number;
}

function limitExceeded(measurements: Measurements, limits: RunPlan["limits"]) {
  if (measurements.unmetered_calls > limits.max_unmetered_calls) {
    return stopped("max_unmetered_calls");
  }
  if (measurements.cost_usd > limits.max_cost_usd) {
    return stopped("max_cost_usd");
  }
}

async function batch(
  action: SpawnSubagentsAction,
  plan: RunPlan,
  ports: Ports,
  measurements: Measurements,
): Promise<BatchResult | Stopped> {
  const { rows } = measurements;
  const { max_invocations } = plan.limits;
  const remaining = max_invocations - rows.length;
  const run = async (inv: SpawnSubagentsAction["invocations"][number]) => {
    const call = await measure({ ...inv, purpose: action.purpose }, action.batch_id, plan, ports);
    await ports.record(call.row);
    return call;
  };
  const responses: BatchResult["responses"] = [];
  function collect(call: Awaited<ReturnType<typeof run>>) {
    rows.push(call.row);
    responses.push(call.response);
    addCost(measurements, call.row.usage);
  }

  if (plan.mode === "parallel") {
    if (action.invocations.length > remaining) {
      return stopped("max_invocations");
    }
    const calls = await Promise.all(action.invocations.map(run));
    calls.forEach(collect);
    const stop = limitExceeded(measurements, plan.limits);
    if (stop) {
      return stop;
    }
  } else {
    for (const inv of action.invocations) {
      if (rows.length >= max_invocations) {
        return stopped("max_invocations");
      }
      collect(await run(inv));
      const stop = limitExceeded(measurements, plan.limits);
      if (stop) {
        return stop;
      }
    }
  }
  return { kind: "subagent_batch_result", batch_id: action.batch_id, responses };
}

function initialState(plan: RunPlan) {
  return newPipelineState({
    run_id: "real-run",
    feature_description: plan.description,
    prd_context: plan.prd_context,
    request_size: plan.request_size,
  });
}

export async function runBench(plan: RunPlan, ports: Ports): Promise<RunRecord> {
  const start = ports.clock();
  let state = initialState(plan);
  const canned = makeCannedDispatcher();
  const measurements: Measurements = { rows: [], cost_usd: 0, unmetered_calls: 0 };
  const { rows } = measurements;
  let result: ActionResult | undefined;
  let steps = 0;
  let batches = 0;
  let terminal: RunRecord["terminal"] = stopped("max_steps");
  while (steps < plan.limits.max_steps) {
    const out = step({ state, result });
    state = out.state;
    const action = out.action;
    steps++;
    if (action.kind === "done" || action.kind === "failed") {
      terminal = action;
      break;
    }
    if (steps === plan.limits.max_steps) {
      break;
    }
    if (action.kind === "spawn_subagents") {
      const before = rows.length;
      const measured = await batch(action, plan, ports, measurements);
      if (rows.length > before) {
        batches++;
      }
      if (measured.kind === "stopped") {
        terminal = measured;
        break;
      }
      result = measured;
    } else if (action.kind === "ask_user") {
      if (!Object.hasOwn(plan.answers, action.question_id)) {
        terminal = stopped(`unregistered question: ${action.question_id}`);
        break;
      }
      result = { ...plan.answers[action.question_id], kind: "user_answer", question_id: action.question_id };
    } else {
      result = canned(action);
    }
  }
  return finishRecord(state, terminal, rows, steps, batches, ports.clock() - start);
}
