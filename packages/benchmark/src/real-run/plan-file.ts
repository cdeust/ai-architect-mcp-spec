import { readFile } from "node:fs/promises";
import { z } from "zod";
import { PRDContextSchema, RequestSizeSchema } from "@prd-gen/core";
import { SpawnSubagentsActionSchema, UserAnswerSchema } from "@prd-gen/orchestration";
import type { RunPlan } from "./types.js";

const settings = z.strictObject({ model: z.string().min(1), effort: z.enum(["session", "low", "medium", "high"]) });
const table = z.partialRecord(SpawnSubagentsActionSchema.shape.purpose, settings);
const limitsSchema = z.strictObject({
  max_invocations: z.int().nonnegative(),
  max_cost_usd: z.number().nonnegative(),
  max_unmetered_calls: z.int().nonnegative(),
  max_steps: z.int().nonnegative(),
});
const planFile = z.strictObject({
  order: z.enum(["as-listed", "reversed"]).default("as-listed"),
  plan_max_cost_usd: z.number().nonnegative(),
  limits: limitsSchema,
  // source: Node timers accept delays up to a signed 32-bit integer in milliseconds.
  call_timeout_ms: z.int32().positive(),
  description: z.string().min(1),
  prd_context: PRDContextSchema,
  answers: z.record(z.string(), UserAnswerSchema.pick({ selected: true, freeform: true })),
  policies: z.record(z.string(), table),
  arms: z.array(z.strictObject({
    limits: limitsSchema.partial().optional(),
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    request_size: RequestSizeSchema,
    policy: z.string(),
    mode: z.enum(["sequential", "parallel"]),
  })).nonempty(),
});

type ArmPlan = RunPlan & Pick<z.infer<typeof planFile>, "plan_max_cost_usd" | "order">;

export async function loadArms(file: string): Promise<{ name: string; plan: ArmPlan }[]> {
  const json = await readFile(file, "utf8");
  return parsePlan(JSON.parse(json));
}

export function parsePlan(value: unknown) {
  const { policies, arms, limits, ...shared } = planFile.parse(value);
  const names = new Set<string>();
  if (shared.order === "reversed") arms.reverse();
  return arms.map(({ name, request_size, mode, policy: key, limits: override }) => {
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate arm: ${name}`);
    names.add(name.toLowerCase());
    if (key !== "as-emitted" && !Object.hasOwn(policies, key)) throw new Error(`Unknown policy: ${key}`);
    const policy = key === "as-emitted" ? key : policies[key];
    const plan: ArmPlan = { ...shared, request_size, mode, policy, limits: { ...limits, ...override } };
    return { name, plan };
  });
}
