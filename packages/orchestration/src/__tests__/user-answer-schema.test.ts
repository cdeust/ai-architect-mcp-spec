import { expect, it, vi } from "vitest";

it("accepts 16 selected strings and refuses the seventeenth at the result boundary", async () => {
  vi.resetModules();
  const { ActionResultSchema } = await import("../types/actions.js");
  const empty = { kind: "user_answer", question_id: "pr_gate" };
  expect(ActionResultSchema.parse(empty)).toEqual({ ...empty, selected: [] });
  const selected = Array.from({ length: 16 }, (_, i) => String(i));
  const result = { kind: "user_answer", question_id: "pr_gate", selected };
  expect(ActionResultSchema.parse(result)).toEqual(result);
  const parsed = ActionResultSchema.safeParse({ ...result, selected: [...selected, "extra"] });
  expect(parsed.error?.issues).toMatchObject([{ code: "too_big", maximum: 16, inclusive: true, path: ["selected"] }]);
});
