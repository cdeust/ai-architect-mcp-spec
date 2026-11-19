import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parsePlan } from "../real-run/plan-file.js";

function plan() {
  return JSON.parse(readFileSync(new URL("../../real-run/plans/smoke.json", import.meta.url), "utf8"));
}

it.each(["as-listed", "reversed", undefined])("orders independent arms for %s", order => {
  const data = plan();
  data.order = order;
  data.arms.push({ ...data.arms[0], name: "Beta_9-x", policy: "as-emitted", limits: { max_steps: 3 } });
  const arms = parsePlan(data);
  expect(arms.map(arm => arm.name)).toEqual(order === "reversed" ? ["Beta_9-x", "smoke"] : ["smoke", "Beta_9-x"]);
  for (const { name, plan: arm } of arms) {
    expect(arm.order).toBe(order ?? "as-listed");
    expect(arm.limits).toEqual(name === "smoke" ? data.limits : { ...data.limits, max_steps: 3 });
    expect(arm.policy).toEqual(name === "smoke" ? data.policies.smoke : "as-emitted");
  }
});

it("rejects case-insensitive collisions and inherited policy names", () => {
  const data = plan();
  data.arms.push({ ...data.arms[0], name: "SmOkE" });
  expect(() => parsePlan(data)).toThrow(/^Duplicate arm: SmOkE$/);
  data.arms[1].name = "second";
  data.arms[1].policy = "constructor";
  expect(() => parsePlan(data)).toThrow(/^Unknown policy: constructor$/);
});

it.each(["-abc", "abc/", "a.b", ""])("rejects the entire unsafe output name %j", name => {
  const data = plan();
  data.arms[0].name = name;
  expect(() => parsePlan(data)).toThrow(/"name"/);
});

it.each(["session", "low", "medium", "high"])("accepts %s effort", effort => {
  const data = plan();
  data.policies.smoke.probe.effort = effort;
  expect(parsePlan(data)[0].plan.policy).toMatchObject({ probe: { model: "haiku", effort } });
});

it.each([
  ["order", ""], ["plan_max_cost_usd", -1], ["call_timeout_ms", 0], ["description", ""],
  ["policies.smoke.probe.model", ""], ["policies.smoke.probe.effort", "unknown"],
  ["limits.max_steps", -1], ["limits.max_unmetered_calls", -1], ["limits.max_invocations", 0.5],
  ["limits.max_cost_usd", -1], ["arms.0.mode", ""], ["arms", []],
])("reports the invalid plan field %s", (path, value) => {
  const data = plan();
  const keys = String(path).split(".");
  const field = keys.pop()!;
  keys.reduce((obj, key) => obj[key], data)[field] = value;
  expect(() => parsePlan(data)).toThrow('"' + field + '"');
});
