import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { step, newPipelineState } from "@prd-gen/orchestration";
import { afterEach, expect, it, vi } from "vitest";
import { loadArms } from "../real-run/plan-file.js";
import { runBench } from "../real-run/run-bench.js";
import { cannedInvoke } from "../real-run/canned-ports.js";
import type { Ports } from "../real-run/types.js";

vi.mock(import("node:fs/promises"), async original => {
  const fs = await original();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});
vi.mock(import("@prd-gen/orchestration"), async original => {
  const pipeline = await original();
  return { ...pipeline, step: vi.fn(pipeline.step), newPipelineState: vi.fn(pipeline.newPipelineState) };
});
afterEach(() => vi.clearAllMocks());

const file = fileURLToPath(new URL("../../real-run/plans/smoke.json", import.meta.url));
const ports: Ports = { clock: () => 0, record: () => {}, invoke: cannedInvoke };

it("reads the plan as UTF-8 and starts the reducer with the benchmark run ID", async () => {
  const [{ plan }] = await loadArms(file);
  expect(readFile).toHaveBeenCalledWith(file, "utf8");
  await runBench(plan, ports);
  expect(newPipelineState).toHaveBeenCalledWith(expect.objectContaining({ run_id: "real-run" }));
});

it.each(["reported", "thrown"])("submits exactly one identified %s probe error to the reducer", async kind => {
  const [{ plan }] = await loadArms(file);
  plan.limits.max_unmetered_calls = 1;
  await runBench(plan, { ...ports, invoke: async () => {
    if (kind === "thrown") throw new Error("provider unavailable");
    return { text: "", error: "provider unavailable", usage: null };
  } });
  expect(vi.mocked(step).mock.calls.map(([input]) => input.result)).toContainEqual({
    kind: "subagent_batch_result", batch_id: "preflight_subagent_probe",
    responses: [{ invocation_id: "preflight_subagent_probe", error: "provider unavailable" }],
  });
});

it("leaves the final step's probe undispatched", async () => {
  const [{ plan }] = await loadArms(file);
  const invoke = vi.fn(cannedInvoke);
  await runBench(plan, { ...ports, invoke });
  const calls = vi.mocked(step).mock.results;
  const probeStep = calls.findIndex(call => call.value.action.kind === "spawn_subagents") + 1;
  expect(probeStep).toBeGreaterThan(0);
  invoke.mockClear();
  plan.limits.max_steps = probeStep;
  const record = await runBench(plan, { ...ports, invoke });
  expect(invoke).not.toHaveBeenCalled();
  expect(record.terminal).toEqual({ kind: "stopped", reason: "max_steps" });
});

it("uses emitted settings even when the host extends strings with a purpose property", async () => {
  const [{ plan }] = await loadArms(file);
  plan.policy = "as-emitted";
  plan.limits.max_invocations = 1;
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, "probe");
  Object.defineProperty(String.prototype, "probe", { configurable: true, value: { model: "foreign", effort: "high" } });
  try {
    const record = await runBench(plan, ports);
    expect(record.rows[0].used).toEqual({ model: "haiku", effort: "low" });
  } finally {
    if (descriptor) Object.defineProperty(String.prototype, "probe", descriptor);
    else Reflect.deleteProperty(String.prototype, "probe");
  }
});

it("submits the successful probe text with its invocation ID", async () => {
  const [{ plan }] = await loadArms(file);
  plan.limits.max_unmetered_calls = 1;
  await runBench(plan, { ...ports, invoke: async () => ({ text: "probe receipt", usage: null }) });
  expect(vi.mocked(step).mock.calls.map(([input]) => input.result)).toContainEqual({
    kind: "subagent_batch_result", batch_id: "preflight_subagent_probe",
    responses: [{ invocation_id: "preflight_subagent_probe", raw_text: "probe receipt" }],
  });
});
