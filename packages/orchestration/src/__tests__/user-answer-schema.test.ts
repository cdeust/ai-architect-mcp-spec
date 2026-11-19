import { expect, it, vi } from "vitest";

it("accepts four selected entries including blanks and refuses the fifth at the result boundary", async () => {
  vi.resetModules();
  const { ActionResultSchema } = await import("../types/actions.js");
  const empty = { kind: "user_answer", question_id: "pr_gate" };
  expect(ActionResultSchema.parse(empty)).toEqual({ ...empty, selected: [] });
  const selected = ["Implement", "", " ", "  "];
  const result = { kind: "user_answer", question_id: "pr_gate", selected };
  expect(ActionResultSchema.parse(result)).toEqual(result);
  const parsed = ActionResultSchema.safeParse({ ...result, selected: [...selected, ""] });
  expect(parsed.error?.issues).toMatchObject([{ code: "too_big", maximum: 4, inclusive: true, path: ["selected"] }]);
});
