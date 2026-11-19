import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { cannedInvoke } from "../real-run/canned-ports.js";
import { harness } from "./real-run-cli-harness.js";

const source = new URL("../../real-run/plans/smoke.json", import.meta.url);
it.each([
  [0.0000001, 2, "configured arm limit"],
  [1, 0.0000001, "remaining plan budget"],
])("explains skipped sub-microdollar budgets, arm=%s plan=%s", async (limit, cap, cause) => {
  const dir = await mkdtemp(join(tmpdir(), "bench-skip-"));
  try {
    const plan = JSON.parse(await readFile(source, "utf8"));
    plan.limits.max_cost_usd = limit;
    plan.plan_max_cost_usd = cap;
    const file = join(dir, "plan.json");
    await writeFile(file, JSON.stringify(plan));
    const result = await harness({}).run("--dry-run", "--plan", file, "--out", dir);
    expect(result.status).toBe(1);
    const message = `smoke: skipped because the ${cause} is below 0.000001 USD (effective limit 0 USD).`;
    expect(result.stderr).toBe(message);
    expect(await readFile(join(dir, "summary.md"), "utf8")).toContain("\n\n" + message + "\n\nArm execution order: \n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("prints unequal caps, exact overspend and flushed JSON lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-caps-"));
  try {
    const plan = JSON.parse(await readFile(source, "utf8"));
    plan.arms.push({ ...plan.arms[0], name: "later", limits: { max_cost_usd: 2 } });
    plan.plan_max_cost_usd = 1;
    const file = join(dir, "plan.json");
    await writeFile(file, JSON.stringify(plan));
    const append = vi.fn(appendFileSync);
    const host = harness({}, { append, invoker: () => async inv => {
      const result = await cannedInvoke(inv);
      return { ...result, usage: { ...result.usage, cost_usd: 1.25 } };
    } });
    const result = await host.run("--i-accept-model-cost", "--plan", file, "--out", dir);
    expect(result.stdout.split("\n")[0]).toBe("Reported-spend limits: 1 + 2 = 3 USD across arms. Plan cap 1 USD. Worst case for reported spend: plan cap plus at most one in-flight batch or call.");
    const message = "Plan stopped at 1.25 reported USD (plan_max_cost_usd 1).";
    expect(result.stderr).toBe(message + "\nlater: skipped because the plan cap is exhausted (effective limit 0 USD).");
    expect(result.status).toBe(1);
    const journal = join(dir, "smoke", "rows.jsonl");
    const line = await readFile(journal, "utf8");
    expect(append).toHaveBeenCalledExactlyOnceWith(journal, JSON.stringify(JSON.parse(line)) + "\n", { flush: true });
    expect(await readFile(join(dir, "summary.md"), "utf8")).toContain("\n\n" + message + "\n");
    for (const name of ["record.json", "sections.json"]) {
      const content = await readFile(join(dir, "smoke", name), "utf8");
      expect(content).toBe(JSON.stringify(JSON.parse(content), null, 2) + "\n");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([["--out", "folder"], ["--plan", "plan"]])("requires both paths with %s alone", async (...args) => {
  const result = await harness({}).run("--dry-run", ...args);
  expect(result).toEqual({ status: 1, stderr: "Expected --plan <file.json> --out <dir>", stdout: "" });
});

it("releases listeners and preserves non-Error messages after a failing read", async () => {
  const exitCode = vi.fn();
  const host = harness({}, { exitCode, loadArms: async () => {
    host.events.emit("exit");
    throw "storage unavailable";
  } });
  const result = await host.run("--dry-run", "--plan", "plan", "--out", "out");
  expect(result).toEqual({ status: 1, stderr: "storage unavailable", stdout: "" });
  expect(exitCode).not.toHaveBeenCalled();
  expect(host.events.eventNames()).toEqual([]);
});
