import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bignumber } from "mathjs";
import { expect, it, vi } from "vitest";
import { effectiveDollars } from "../real-run/cli-budget.js";
import { parsePlan } from "../real-run/plan-file.js";
import { cannedInvoke } from "../real-run/canned-ports.js";
import type { Ports } from "../real-run/types.js";
import { harness } from "./real-run-cli-harness.js";

const smoke = readFileSync(new URL("../../real-run/plans/smoke.json", import.meta.url), "utf8");

function cli(invoke: Ports["invoke"], cap = 2) {
  const plan = JSON.parse(smoke);
  plan.limits.max_cost_usd = cap;
  plan.plan_max_cost_usd = cap;
  const write = vi.fn(async (_path: unknown, _data: unknown, _opts?: unknown) => {});
  const host = harness({}, {
    loadArms: async () => parsePlan(plan),
    mkdir: vi.fn(), stat: vi.fn(), append: vi.fn(), writeFile: write,
    invoker: () => invoke,
  });
  const run = () => host.run("--i-accept-model-cost", "--plan", "smoke", "--out", "out");
  function footer() {
    const text = String(write.mock.calls.find(([path]) => path === join("out", "summary.md"))?.[1]);
    return text.slice(text.lastIndexOf("|") + 1);
  }
  return { run, write, footer };
}

it("creates an empty exclusive journal and an exclusive summary with no optional sections", async () => {
  const host = cli(cannedInvoke);
  expect((await host.run()).status).toBe(0);
  expect(host.write).toHaveBeenCalledWith(join("out", "smoke", "rows.jsonl"), "", { flag: "wx" });
  expect(host.write).toHaveBeenCalledWith(join("out", "summary.md"), expect.any(String), { flag: "wx" });
  expect(host.footer()).toBe("\n\nArm execution order: smoke\n");
});

it("lists only retained paths and writes the exact workspace footer", async () => {
  let index = 0;
  const host = cli(async (inv, _used, row) => {
    index++;
    row.workspace_kept = index <= 2;
    if (index !== 2) row.workspace_path = `/call/${index}`;
    return cannedInvoke(inv);
  });
  expect((await host.run()).status).toBe(0);
  expect(host.footer()).toBe("\n\nKept workspaces\n\n- /call/1\n\nArm execution order: smoke\n");
});

it("writes the summary after a call without usage", async () => {
  const host = cli(async () => ({ text: "", usage: null, error: "provider unavailable" }));
  const result = await host.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  expect(host.footer()).toBe("\n\nArm execution order: smoke\n");
});

it("detects overspend by the smallest charge against a large plan cap", async () => {
  let calls = 0;
  const cap = 1e308;
  const host = cli(async inv => {
    const result = await cannedInvoke(inv);
    const cost = [Number.MIN_VALUE, cap][calls++] ?? 0;
    return { ...result, usage: { ...result.usage, cost_usd: cost } };
  }, cap);
  const result = await host.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("Plan stopped at 1." + "0".repeat(631) + "5e+308 reported USD (plan_max_cost_usd 1e+308).");
});

it("clamps a negative balance to zero available dollars", () => {
  expect(effectiveDollars(bignumber("-0.5"))).toBe(0);
});
