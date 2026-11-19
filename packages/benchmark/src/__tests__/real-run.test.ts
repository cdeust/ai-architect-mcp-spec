import { loadArms } from "../real-run/plan-file.js";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { cannedInvoke } from "../real-run/canned-ports.js";
import { summaryRow } from "../real-run/report.js";
import { runBench } from "../real-run/run-bench.js";
import type { Ports, RunPlan } from "../real-run/types.js";

const plan: RunPlan = { call_timeout_ms: 600000, limits: { max_invocations: 80, max_cost_usd: 25, max_unmetered_calls: 2, max_steps: 200 }, description: "build a simple feature for OAuth login", prd_context: "feature",
  request_size: "tiny", policy: "as-emitted", mode: "sequential", answers: {
    "clarification_answer": { "selected": [], "freeform": "Use OAuth 2.0 authorization code flow with PKCE against one identity provider, Google; sessions last 24 hours; no social account linking; web only." },
    "clarification_continue": { "selected": ["proceed"] },
    "implementation_gate": { "selected": ["PRD only"] }
  } };
const ports: Ports = { record: () => {}, clock: () => 0, invoke: cannedInvoke };

it.each([["tiny", 12], ["standard", 27]] as const)("drives the %s seed to done", async (request_size, count) => {
  const record = await runBench({ ...plan, request_size }, ports);
  expect(record.terminal.kind).toBe("done");
  expect(record.rows).toHaveLength(count);
  expect(record.totals.invocations).toBe(count);
  expect(record.batches).toBe(new Set(record.rows.map(r => r.batch_id)).size);
  expect(record.steps).toBeGreaterThan(record.batches);
  expect(record.quality.hard_output_score).toEqual(expect.any(Number));
  if (record.terminal.kind === "done") {
    expect(record.quality.distribution).toEqual(record.terminal.verification?.distribution);
    expect(record.quality.outcome).toEqual(record.terminal.outcome);
  }
  const drafts = record.rows.filter(row => row.purpose === "draft");
  expect(drafts[0]).toMatchObject({ requested: { model: null, effort: null }, used: { model: "session", effort: "session" } });
  if (request_size === "standard") expect(drafts.length).toBe(20);
});

async function timedRun(mode: RunPlan["mode"]) {
  let now = 0;
  let active = 0;
  let peak = 0;
  const completed: string[] = [];
  const recorded: string[] = [];
  const run = await runBench({ ...plan, mode, policy: { draft: { model: "sonnet", effort: "medium" } } }, {
    ...ports, record: row => {
      recorded.push(row.invocation_id);
    }, clock: () => now, invoke: async (inv, used) => {
      const start = now;
      const first = active === 0;
      peak = Math.max(peak, ++active);
      if (inv.purpose === "draft") expect(used).toEqual({ model: "sonnet", effort: "medium" });
      const { text, usage } = await cannedInvoke(inv);
      // Finish the first concurrent call last to exercise submission order.
      if (first && active > 1) await Promise.resolve();
      now = Math.max(now, start + 1);
      active--;
      completed.push(inv.invocation_id);
      return { text, usage: { ...usage, input_tokens: 2, output_tokens: 3, cache_read_tokens: 4,
        cache_creation_tokens: 5, duration_ms: 1, cost_usd: 0.25 } };
    },
  });
  return { run, peak, completed, recorded };
}

it("overlaps only calls of a parallel batch and attributes the same spend in either mode", async () => {
  const sequential = await timedRun("sequential");
  const parallel = await timedRun("parallel");
  expect(sequential.peak).toBe(1);
  expect(parallel.peak).toBeGreaterThan(1);
  expect(sequential.completed).toEqual(sequential.run.rows.map(r => r.invocation_id));
  expect(parallel.recorded).toEqual(parallel.completed);
  expect(parallel.completed).not.toEqual(sequential.completed);
  expect(parallel.run.rows).toEqual(sequential.run.rows);
  expect(parallel.run.wall_time_ms).toBe(parallel.run.batches);
  expect(sequential.run.wall_time_ms).toBe(12);
  expect(parallel.run.totals).toEqual({ invocations: 12, errors: 0, unmetered_calls: 0, input_tokens: 24,
    output_tokens: 36, cache_read_tokens: 48, cache_creation_tokens: 60, duration_ms: 12, cost_usd: 3 });
  expect(parallel.run.per_purpose.probe).toMatchObject({ invocations: 1, cost_usd: 0.25 });
  expect(parallel.run.rows[0]).toMatchObject({ purpose: "probe", used: { model: "haiku", effort: "low" },
    agent_type: expect.stringContaining("engineer"), prompt_characters: expect.any(Number), error: null });
});

it("retains an unmetered probe failure and the reducer's terminal decision", async () => {
  const record = await runBench(plan, { ...ports, invoke: async () => { throw new Error("invalid response"); } });
  expect(record.rows[0]).toMatchObject({ usage: null, error: "invalid response" });
  expect(record.totals).toMatchObject({ invocations: 1, errors: 1, unmetered_calls: 1, cost_usd: 0 });
  expect(record.terminal.kind).toBe("failed");
  expect(record.quality).toEqual({ outcome: null, distribution: null, hard_output_score: null });
});

it("passes a registered clarification answer into the section prompt", async () => {
  const freeform = "Only the pilot tenant can log in.";
  const prompts: string[] = [];
  await runBench({ ...plan, answers: { clarification_answer: { selected: [], freeform } } }, {
    ...ports, invoke: async inv => {
      prompts.push(inv.prompt);
      return cannedInvoke(inv);
    },
  });
  expect(prompts.some(prompt => prompt.includes(freeform))).toBe(true);
});

it("keeps billed usage when a provider reports failure", async () => {
  const record = await runBench(plan, { ...ports, invoke: async inv => {
    const result = await cannedInvoke(inv);
    return { ...result, error: "provider failed", usage: { ...result.usage, cost_usd: 0.25 } };
  } });
  expect(record.terminal.kind).toBe("failed");
  expect(record.totals).toMatchObject({ errors: 1, unmetered_calls: 0, cost_usd: 0.25 });
});

it("stops at the step cap and preserves the calls already measured", async () => {
  const record = await runBench({ ...plan, limits: { ...plan.limits, max_steps: 1 } }, ports);
  expect(record.terminal).toEqual({ kind: "stopped", reason: "max_steps" });
  expect(record.steps).toBe(1);
  expect(record.rows).toHaveLength(0);
});

it("admits individual calls sequentially and entire batches in parallel", async () => {
  const full = await runBench(plan, ports);
  const index = full.rows.findIndex((row, i) => row.batch_id === full.rows[i + 1]?.batch_id);
  expect(index).toBeGreaterThanOrEqual(0);
  const limits = { ...plan.limits, max_invocations: index + 1 };
  for (const mode of ["parallel", "sequential"] as const) {
    let calls = 0;
    const record = await runBench({ ...plan, mode, limits }, { ...ports, invoke: (...args) => {
      calls++;
      return cannedInvoke(args[0]);
    } });
    expect(record.terminal).toEqual({ kind: "stopped", reason: "max_invocations" });
    expect(calls).toBe(mode === "parallel" ? index : index + 1);
    expect(record.rows).toEqual(full.rows.slice(0, calls));
  }
});

it("includes the call crossing the cost limit and allows exact equality", async () => {
  const limits = { ...plan.limits, max_cost_usd: 1 };
  const record = await runBench({ ...plan, limits }, { ...ports, invoke: async (...args) => {
    const result = await cannedInvoke(args[0]);
    return { ...result, usage: { ...result.usage, cost_usd: 1 } };
  } });
  expect(record.terminal).toEqual({ kind: "stopped", reason: "max_cost_usd" });
  expect(record.totals).toMatchObject({ invocations: 2, cost_usd: 2 });
});

it.each(["sequential", "parallel"] as const)("uses decimal reported spend in %s mode", async (mode) => {
  for (const extra of [0, 0.01]) {
    const costs = [0.1, 0.2, extra];
    const record = await runBench({ ...plan, mode, limits: { ...plan.limits, max_cost_usd: 0.3 } }, {
      ...ports,
      invoke: async inv => {
        const cost_usd = costs.shift() ?? 0;
        const result = await cannedInvoke(inv);
        return { ...result, usage: { ...result.usage, cost_usd } };
      },
    });
    expect(record.totals.cost_usd).toBe(extra === 0 ? 0.3 : 0.31);
    if (extra === 0) expect(record.terminal.kind).toBe("done");
    else expect(record.terminal).toEqual({ kind: "stopped", reason: "max_cost_usd" });
  }
});

it("records a completed call before a later host failure", async () => {
  const saved: string[] = [];
  const aborted = runBench(plan, {
    ...ports,
    record: async row => {
      await Promise.resolve();
      if (saved.length === 2) throw new Error("host interrupted");
      saved.push(row.purpose);
    },
  });
  await expect(aborted).rejects.toThrow("host interrupted");
  expect(saved).toEqual(["probe", "draft"]);
});

it("compares all four token counters and spend to the first arm", async () => {
  const { run } = await timedRun("sequential");
  const baseline = { ...run.totals, input_tokens: 84, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 12 };
  expect(summaryRow("second", run, baseline)).toContain("| 168 | 2.00× | 3 | 0.25× |");
  expect(summaryRow("second", run, { ...baseline, input_tokens: 0, cost_usd: 0 }))
    .toContain("| 168 | — | 3 | — |");
});

it("accounts for all in-flight calls when a parallel batch crosses the cost limit", async () => {
  const full = await runBench(plan, ports);
  const grouped = full.rows.find((row, i) => row.batch_id === full.rows[i + 1]?.batch_id);
  expect(grouped).toBeDefined();
  const record = await runBench({ ...plan, mode: "parallel", limits: { ...plan.limits, max_cost_usd: 0 } }, {
    ...ports,
    invoke: async (...args) => {
      const result = await cannedInvoke(args[0]);
      const cost_usd = args[0].invocation_id === grouped?.invocation_id ? 1 : 0;
      return { ...result, usage: { ...result.usage, cost_usd } };
    },
  });
  expect(record.terminal).toEqual({ kind: "stopped", reason: "max_cost_usd" });
  const last = full.rows.map(row => row.batch_id).lastIndexOf(grouped!.batch_id);
  expect(record.rows.map(row => row.invocation_id)).toEqual(full.rows.slice(0, last + 1).map(row => row.invocation_id));
  expect(record.totals.cost_usd).toBe(1);
});

it.each([
  { costs: [null, null], allowed: 1, reason: "max_unmetered_calls", spend: 0, unknown: 2 },
  { costs: [null, 2], allowed: 1, reason: "max_cost_usd", spend: 2, unknown: 1 },
])("accounts for reported spend and missing costs: $reason", async ({ costs, allowed, reason, spend, unknown }) => {
  let calls = 0;
  const record = await runBench({ ...plan, limits: { ...plan.limits, max_cost_usd: 1, max_unmetered_calls: allowed } }, {
    ...ports, invoke: async (...args) => {
      const result = await cannedInvoke(args[0]);
      return { ...result, usage: { ...result.usage, cost_usd: costs[calls++] ?? null } };
    },
  });
  expect(calls).toBe(2);
  expect(record.terminal).toEqual({ kind: "stopped", reason });
  expect(record.totals).toMatchObject({ cost_usd: spend, unmetered_calls: unknown });
});

it("stops at an unregistered question and names its id", async () => {
  const record = await runBench({ ...plan, answers: {} }, ports);
  expect(record.terminal).toEqual({ kind: "stopped", reason: "unregistered question: clarification_answer" });
  expect(record.rows.map(row => row.purpose)).toEqual(["probe", "draft"]);
});

it("submits the pilot's shared answer despite different model-generated options", async () => {
  const arms = await loadArms(fileURLToPath(new URL("../../real-run/plans/pilot.json", import.meta.url)));
  const shared = arms[0].plan.answers.clarification_answer?.freeform;
  expect(shared).toContain("OAuth 2.0 authorization code flow with PKCE");
  for (const { name, plan: arm } of arms.slice(0, 2)) {
    const prompts: string[] = [];
    const record = await runBench(arm, { ...ports, invoke: async inv => {
      prompts.push(inv.prompt);
      const result = await cannedInvoke(inv);
      return inv.description.startsWith("Compose clarification")
        ? { ...result, text: JSON.stringify({ question: "Identity provider?", options: [name, "other"] }) } : result;
    } });
    expect(record.terminal.kind).toBe("done");
    const answers = prompts.flatMap(prompt => [...prompt.matchAll(/^Q: Identity provider\?\nA: (.+)$/gm)].map(match => match[1]));
    expect(new Set(answers)).toEqual(new Set([shared]));
  }
});

it("stops before reducer recovery when the first failed call is unmetered and none are allowed", async () => {
  const record = await runBench({ ...plan, limits: { ...plan.limits, max_unmetered_calls: 0 } }, {
    ...ports, invoke: async () => { throw new Error("timed out"); },
  });
  expect(record.terminal).toEqual({ kind: "stopped", reason: "max_unmetered_calls" });
  expect(record.totals).toMatchObject({ invocations: 1, errors: 1, unmetered_calls: 1, cost_usd: 0 });
});

it("records every probe field and the elapsed clock difference", async () => {
  let time = 11;
  const limits = { ...plan.limits, max_invocations: 1 };
  const record = await runBench({ ...plan, limits, mode: "parallel" }, {
    ...ports, clock: () => time++, record: () => {},
  });
  expect(record.wall_time_ms).toBe(1);
  expect(record.batches).toBe(1);
  expect(record.rows).toEqual([{
    batch_id: "preflight_subagent_probe", invocation_id: "preflight_subagent_probe", purpose: "probe",
    agent_type: "zetetic-team-subagents:engineer", isolation: "none", prompt_characters: 70,
    requested: { model: "haiku", effort: "low" }, used: { model: "haiku", effort: "low" },
    workspace_kept: false, error: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
      cache_creation_tokens: 0, duration_ms: 0, cost_usd: 0, model_reported: "canned" },
  }]);
});

it("preserves a zero step budget and counts only batches that invoked a worker", async () => {
  const empty = await runBench({ ...plan, limits: { ...plan.limits, max_steps: 0 } }, ports);
  expect(empty).toMatchObject({ steps: 0, rows: [], batches: 0, terminal: { kind: "stopped", reason: "max_steps" } });
  const denied = await runBench({ ...plan, limits: { ...plan.limits, max_invocations: 0 } }, ports);
  expect(denied).toMatchObject({ batches: 0, rows: [], terminal: { kind: "stopped", reason: "max_invocations" } });
});

it("preserves the printable cause when an invoker rejects with a string", async () => {
  const record = await runBench(plan, { ...ports, invoke: async () => { throw "transport closed"; } });
  expect(record.rows[0].error).toBe("transport closed");
  expect(record.terminal.kind).toBe("failed");
});
