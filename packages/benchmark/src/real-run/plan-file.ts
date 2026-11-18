import { readFile } from "node:fs/promises";
import { z } from "zod";
import { PRDContextSchema, RequestSizeSchema } from "@prd-gen/core";
import { SpawnSubagentsActionSchema, UserAnswerSchema } from "@prd-gen/orchestration";
import type { RunPlan } from "./types.js";

const settings = z.strictObject({ model: z.string().min(1), effort: z.enum(["session", "low", "medium", "high"]) });
const table = z.partialRecord(SpawnSubagentsActionSchema.shape.purpose, settings);
const planFile = z.strictObject({
  description: z.string().min(1),
  prd_context: PRDContextSchema,
  answers: z.record(z.string(), UserAnswerSchema.pick({ selected: true, freeform: true })),
  policies: z.record(z.string(), table),
  arms: z.array(z.strictObject({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    request_size: RequestSizeSchema,
    policy: z.string(),
    mode: z.enum(["sequential", "parallel"]),
  })).nonempty(),
});

export async function loadArms(file: string): Promise<{ name: string; plan: RunPlan }[]> {
  const { description, prd_context, answers, policies, arms } = planFile.parse(JSON.parse(await readFile(file, "utf8")));
  const names = new Set<string>();
  return arms.map(({ name, request_size, mode, policy: key }) => {
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate arm: ${name}`);
    names.add(name.toLowerCase());
    if (key !== "as-emitted" && !Object.hasOwn(policies, key)) throw new Error(`Unknown policy: ${key}`);
    const policy = key === "as-emitted" ? key : policies[key];
    return { name, plan: { description, prd_context, answers, request_size, mode, policy } };
  });
}
