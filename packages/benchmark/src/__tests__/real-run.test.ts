import { expect, it } from "vitest";
import { cannedAnswer, cannedInvoke } from "../real-run/canned-ports.js";
import { summaryRow } from "../real-run/report.js";
import { runBench } from "../real-run/run-bench.js";
import type { Ports, RunPlan } from "../real-run/types.js";

const plan: RunPlan = { call_timeout_ms: 600000, limits: { max_invocations: 80, max_cost_usd: 25, max_steps: 200 }, description: "build a simple feature for OAuth login", prd_context: "feature",
  request_size: "tiny", policy: "as-emitted", mode: "sequential", answers: {} };
const ports: Ports = { record: () => {}, clock: () => 0, answer: cannedAnswer, invoke: cannedInvoke };

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
      const { text, usage } = await cannedInvoke(inv, used);
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
  expect(record.totals).toMatchObject({ invocations: 1, errors: 1, unmetered_calls: 1, cost_usd: null });
  expect(record.terminal.kind).toBe("failed");
  expect(record.quality).toEqual({ outcome: null, distribution: null, hard_output_score: null });
});

it("passes a registered clarification answer into the section prompt", async () => {
  const freeform = "Only the pilot tenant can log in.";
  const prompts: string[] = [];
  await runBench({ ...plan, answers: { clarification_answer: { selected: [], freeform } } }, {
    ...ports, answer: question => {
      expect(question.question_id).not.toBe("clarification_answer");
      return cannedAnswer(question);
    }, invoke: async (inv, settings) => {
      prompts.push(inv.prompt);
      return cannedInvoke(inv, settings);
    },
  });
  expect(prompts.some(prompt => prompt.includes(freeform))).toBe(true);
});

it("keeps billed usage when a provider reports failure", async () => {
  const record = await runBench(plan, { ...ports, invoke: async (inv, settings) => {
    const result = await cannedInvoke(inv, settings);
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
      return cannedInvoke(...args);
    } });
    expect(record.terminal).toEqual({ kind: "stopped", reason: "max_invocations" });
    expect(calls).toBe(mode === "parallel" ? index : index + 1);
    expect(record.rows).toEqual(full.rows.slice(0, calls));
  }
});

it("includes the call crossing the cost limit and allows exact equality", async () => {
  const limits = { ...plan.limits, max_cost_usd: 1 };
  const record = await runBench({ ...plan, limits }, { ...ports, invoke: async (...args) => {
    const result = await cannedInvoke(...args);
    return { ...result, usage: { ...result.usage, cost_usd: 1 } };
  } });
  expect(record.terminal).toEqual({ kind: "stopped", reason: "max_cost_usd" });
  expect(record.totals).toMatchObject({ invocations: 2, cost_usd: 2 });
});

it("records a completed call before a later host failure", async () => {
  const saved: string[] = [];
  const aborted = runBench(plan, {
    ...ports,
    record: async row => {
      await Promise.resolve();
      saved.push(row.purpose);
    },
    answer: () => { throw new Error("host interrupted"); },
  });
  await expect(aborted).rejects.toThrow("host interrupted");
  expect(saved).toEqual(["probe"]);
});

it("compares all four token counters and spend to the first arm", async () => {
  const { run } = await timedRun("sequential");
  const baseline = { ...run.totals, input_tokens: 84, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 12 };
  expect(summaryRow("second", run, baseline)).toContain("| 168 | 2.00× | 3 | 0.25× |");
  expect(summaryRow("second", run, { ...baseline, input_tokens: 0, cost_usd: null }))
    .toContain("| 168 | — | 3 | — |");
});
