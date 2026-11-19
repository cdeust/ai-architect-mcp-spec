import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadArms } from "../real-run/plan-file.js";

const handlers = fileURLToPath(new URL("../../../orchestration/src/handlers/", import.meta.url));
const unreachable = new Set([
  "prd_context", // Both plans declare the PRD kind.
  "feasibility_focus", // The OAuth feature description does not trigger the epic gate.
  "pr_gate", // Both plans select PRD only at the implementation gate.
]);

async function emittedQuestionIds() {
  const shared = await readFile(join(handlers, "protocol-ids.ts"), "utf8");
  const ids = new Set<string>();
  for (const file of await readdir(handlers, { recursive: true })) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = await readFile(join(handlers, file), "utf8");
    const constants = new Map<string, string>();
    for (const [, name, value] of (shared + "\n" + source).matchAll(/\bconst\s+(\w+)\s*=\s*["']([^"']+)["']/g)) {
      constants.set(name, value);
    }
    for (const [, expression] of source.matchAll(/\bquestion_id\s*:\s*([^,}\n]+)/g)) {
      const token = expression.trim();
      const id = /^["']([^"']+)["']$/.exec(token)?.[1] ?? constants.get(token);
      expect(id, `${file}: resolve question_id ${token}`).toBeDefined();
      ids.add(id!);
    }
  }
  return ids;
}

it.each(["pilot", "smoke"])("%s arms register all reachable handler questions", async name => {
  const arms = await loadArms(fileURLToPath(new URL(`../../real-run/plans/${name}.json`, import.meta.url)));
  const emitted = await emittedQuestionIds();
  expect(emitted).toContain("self_check_verify_budget");
  for (const { plan } of arms) {
    for (const id of emitted) {
      if (!unreachable.has(id)) expect(plan.answers, id).toHaveProperty(id);
    }
    expect(plan.answers.self_check_verify_budget).toEqual({ selected: ["Reduced sample"] });
  }
});
