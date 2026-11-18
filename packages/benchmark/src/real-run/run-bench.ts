import { makeCannedDispatcher, newPipelineState, step, type ActionResult, type SpawnSubagentsAction } from "@prd-gen/orchestration";
import type { Invocation, Ports, Row, RunPlan, RunRecord, Settings, Totals } from "./types.js";

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

async function batch(action: SpawnSubagentsAction, plan: RunPlan, ports: Ports, rows: Row[]): Promise<ActionResult> {
  const run = (inv: SpawnSubagentsAction["invocations"][number]) =>
    measure({ ...inv, purpose: action.purpose }, action.batch_id, plan, ports);
  const calls = [];
  if (plan.mode === "parallel") {
    calls.push(...await Promise.all(action.invocations.map(run)));
  } else {
    for (const inv of action.invocations) calls.push(await run(inv));
  }
  rows.push(...calls.map(call => call.row));
  return { kind: "subagent_batch_result", batch_id: action.batch_id, responses: calls.map(call => call.response) };
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

export async function runBench(plan: RunPlan, ports: Ports): Promise<RunRecord> {
  const start = ports.clock();
  let state = newPipelineState({ run_id: "real-run", feature_description: plan.description,
    prd_context: plan.prd_context, request_size: plan.request_size });
  const canned = makeCannedDispatcher();
  const rows: Row[] = [];
  let result: ActionResult | undefined;
  let steps = 0;
  let batches = 0;
  for (;;) {
    const out = step({ state, result });
    state = out.state;
    const action = out.action;
    steps++;
    if (action.kind === "done" || action.kind === "failed") {
      const done = action.kind === "done" ? action : null;
      const score = done?.summary.match(/^Hard-output score: ([\d.]+) \/ 1\.00$/m);
      const per_purpose: RunRecord["per_purpose"] = {};
      for (const purpose of new Set(rows.map(row => row.purpose))) {
        per_purpose[purpose] = totals(rows.filter(row => row.purpose === purpose));
      }
      return { rows, totals: totals(rows), per_purpose, steps, batches, wall_time_ms: ports.clock() - start,
        terminal: action, quality: { outcome: done?.outcome ?? null, hard_output_score: score ? Number(score[1]) : null,
          distribution: done?.verification?.distribution ?? null } };
    }
    if (action.kind === "spawn_subagents") {
      batches++;
      result = await batch(action, plan, ports, rows);
    } else if (action.kind === "ask_user") {
      const answer = Object.hasOwn(plan.answers, action.question_id) && plan.answers[action.question_id];
      result = answer ? { ...answer, kind: "user_answer", question_id: action.question_id } : ports.answer(action);
    } else result = canned(action);
  }
}
