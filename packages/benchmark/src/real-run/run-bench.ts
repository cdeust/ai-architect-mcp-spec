import { makeCannedDispatcher, newPipelineState, step, type ActionResult, type SpawnSubagentsAction } from "@prd-gen/orchestration";
import type { Invocation, Ports, Row, RunPlan, RunRecord, Settings, Stopped, Totals } from "./types.js";

function settingsFor(inv: Invocation, policy: RunPlan["policy"]): Settings {
  const override = policy === "as-emitted" ? undefined : policy[inv.purpose];
  return override ?? { model: inv.model ?? "session", effort: inv.effort ?? "session" };
}

async function measure(inv: Invocation, batch_id: string, plan: RunPlan, ports: Ports) {
  const used = settingsFor(inv, plan.policy);
  const row: Row = {
    batch_id, invocation_id: inv.invocation_id, purpose: inv.purpose,
    agent_type: inv.subagent_type, prompt_characters: Array.from(inv.prompt).length,
    requested: { model: inv.model ?? null, effort: inv.effort ?? null },
    used, usage: null, error: null,
  };
  try {
    const result = await ports.invoke(inv, used);
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

async function batch(action: SpawnSubagentsAction, plan: RunPlan, ports: Ports, rows: Row[]): Promise<BatchResult | Stopped> {
  const { max_invocations, max_cost_usd } = plan.limits;
  const remaining = max_invocations - rows.length;
  const run = async (inv: SpawnSubagentsAction["invocations"][number]) => {
    const call = await measure({ ...inv, purpose: action.purpose }, action.batch_id, plan, ports);
    await ports.record(call.row);
    return call;
  };
  let spend = rows.reduce((sum, row) => sum + (row.usage?.cost_usd ?? 0), 0);
  const responses: BatchResult["responses"] = [];
  function collect(call: Awaited<ReturnType<typeof run>>) {
    rows.push(call.row);
    responses.push(call.response);
    spend += call.row.usage?.cost_usd ?? 0;
  }
  if (plan.mode === "parallel") {
    if (action.invocations.length > remaining) return stopped("max_invocations");
    const calls = await Promise.all(action.invocations.map(run));
    calls.forEach(collect);
  } else {
    for (const inv of action.invocations) {
      if (rows.length >= max_invocations) return stopped("max_invocations");
      collect(await run(inv));
      if (spend > max_cost_usd) return stopped("max_cost_usd");
    }
  }
  if (spend > max_cost_usd) return stopped("max_cost_usd");
  return { kind: "subagent_batch_result", batch_id: action.batch_id, responses };
}

function totals(rows: Row[]): Totals {
  const result: Totals = { invocations: rows.length, errors: 0, unmetered_calls: 0, input_tokens: 0,
    output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, duration_ms: 0, cost_usd: 0 };
  for (const { usage, error } of rows) {
    if (error !== null) result.errors++;
    if (usage?.cost_usd == null) result.cost_usd = null;
    else if (result.cost_usd !== null) result.cost_usd += usage.cost_usd;
    if (!usage) {
      result.unmetered_calls++;
      continue;
    }
    for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "duration_ms"] as const) {
      result[key] += usage[key];
    }
  }
  return result;
}

function quality(terminal: RunRecord["terminal"]): RunRecord["quality"] {
  const done = terminal.kind === "done" ? terminal : undefined;
  const score = done?.summary.match(/^Hard-output score: ([\d.]+) \/ 1\.00$/m);
  return {
    outcome: done?.outcome ?? null,
    hard_output_score: score ? Number(score[1]) : null,
    distribution: done?.verification?.distribution ?? null,
  };
}

function perPurpose(rows: Row[]): RunRecord["per_purpose"] {
  const grouped: RunRecord["per_purpose"] = {};
  for (const purpose of new Set(rows.map(row => row.purpose))) {
    grouped[purpose] = totals(rows.filter(row => row.purpose === purpose));
  }
  return grouped;
}

export async function runBench(plan: RunPlan, ports: Ports): Promise<RunRecord> {
  const start = ports.clock();
  let state = newPipelineState({ run_id: "real-run", feature_description: plan.description,
    prd_context: plan.prd_context, request_size: plan.request_size });
  const canned = makeCannedDispatcher();
  const rows: Row[] = [];
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
    if (steps === plan.limits.max_steps) break;
    if (action.kind === "spawn_subagents") {
      const before = rows.length;
      const measured = await batch(action, plan, ports, rows);
      if (rows.length > before) batches++;
      if (measured.kind === "stopped") {
        terminal = measured;
        break;
      }
      result = measured;
    } else if (action.kind === "ask_user") {
      const answer = Object.hasOwn(plan.answers, action.question_id) && plan.answers[action.question_id];
      result = answer ? { ...answer, kind: "user_answer", question_id: action.question_id } : ports.answer(action);
    } else result = canned(action);
  }
  return {
    terminal, rows, batches, steps,
    totals: totals(rows),
    per_purpose: perPurpose(rows),
    quality: quality(terminal),
    wall_time_ms: ports.clock() - start,
  };
}
