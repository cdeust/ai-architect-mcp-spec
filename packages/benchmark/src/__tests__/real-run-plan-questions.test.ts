import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tempDirectory } from "./real-run-cli-harness.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import { isBinaryExpression, isPropertyAccessExpression, isPropertyAssignment, isShorthandPropertyAssignment, SyntaxKind, type Node } from "typescript/unstable/ast";
import { expect, it } from "vitest";
import { verifyBudgetDecisionFromAnswer } from "../../../orchestration/src/handlers/self-check-verify-budget.js";
import { loadArms } from "../real-run/plan-file.js";

const handlers = fileURLToPath(new URL("../../../orchestration/src/handlers/", import.meta.url));
const orchestration = join(handlers, "../..");
const unreachable = new Map([
  ["prd_context", "Both plans declare the PRD kind."],
  ["feasibility_focus", "The OAuth feature description does not trigger the epic gate."],
  ["pr_gate", "Both plans select PRD only at the implementation gate."],
]);

function assignedQuestion(node: Node) {
  if (isPropertyAssignment(node) && node.name.getText() === "question_id") return node.initializer;
  if (isShorthandPropertyAssignment(node) && node.name.getText() === "question_id") return node.name;
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken &&
      isPropertyAccessExpression(node.left) && node.left.name.getText() === "question_id") return node.right;
}

function emittedQuestionIds(root = orchestration) {
  const config = join(root, "tsconfig.json");
  const api = new API({ cwd: root });
  const ids = new Set<string>();
  try {
    const project = api.updateSnapshot({ openProjects: [config] }).getProject(config)!;
    for (const file of project.rootFiles) {
      if (!file.startsWith(join(root, "src") + "/") || /(?:\/__tests__\/|\.(?:test|spec)\.[^.]+$)/.test(file)) continue;
      const source = project.program.getSourceFile(file)!;
      function visit(node: Node) {
        const value = assignedQuestion(node);
        if (value) {
          // These are schema declarations and echoes of the question in a canned answer.
          const spelling = value.getText();
          const schema = file === join(root, "src/types/actions.ts") && spelling === "z.string()";
          const echo = file === join(root, "src/canned-dispatcher.ts") && spelling === "action.question_id";
          if (!schema && !echo) {
            const binding = isShorthandPropertyAssignment(node) && project.checker.getShorthandAssignmentValueSymbol(node);
            const type = binding ? project.checker.getTypeOfSymbol(binding) : project.checker.getTypeAtLocation(value);
            if (!type?.isStringLiteralType()) throw new Error(`${file}: resolve question_id ${spelling}`);
            ids.add(type.value);
          }
        }
        node.forEachChild(visit);
      }
      visit(source);
    }
  } finally {
    api.close();
  }
  return ids;
}

it.each(["pilot", "smoke"])("%s arms register all reachable handler questions", async name => {
  const arms = await loadArms(fileURLToPath(new URL(`../../real-run/plans/${name}.json`, import.meta.url)));
  const emitted = emittedQuestionIds();
  expect(emitted).toContain("self_check_verify_budget");
  for (const { plan } of arms) {
    for (const [id, reason] of unreachable) expect(plan.answers, reason).not.toHaveProperty(id);
    for (const id of emitted) {
      if (!unreachable.has(id)) expect(plan.answers, id).toHaveProperty(id);
    }
    const question_id = "self_check_verify_budget";
    const answer = plan.answers[question_id];
    expect(answer).toEqual({ selected: ["Reduced sample"] });
    expect(verifyBudgetDecisionFromAnswer({ kind: "user_answer", question_id, ...answer })).toBe("sample");
  }
});
it("finds literal, local, imported, shorthand and assigned question IDs across the source tree", async () => {
  const root = await tempDirectory("bench-question-ids-");
  try {
    const src = join(root, "src");
    await mkdir(join(src, "nested"), { recursive: true });
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*"] }));
    const handler = await readFile(join(handlers, "context-detection.ts"), "utf8");
    const property = "question_id: QUESTION_ID,";
    expect(handler).toContain(property);
    await writeFile(join(src, "shared.ts"), 'export const ID = "imported";');
    for (const [name, declaration, field] of [
      ["literal", "", 'question_id: "literal",'],
      ["local", 'const id = "local";', "question_id: id,"],
      ["imported", 'import { ID as imported } from "../shared.js";', "question_id: imported,"],
      ["shorthand", 'const question_id = "shorthand";', "question_id,"],
      ["assigned", 'const x = { question_id: "initial" }; x.question_id = "assigned";', ""],
    ]) {
      await writeFile(join(src, "nested", name + ".ts"), declaration + "\n" + handler.replace(property, field));
    }
    expect(emittedQuestionIds(root)).toEqual(new Set(["literal", "local", "imported", "shorthand", "initial", "assigned"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
