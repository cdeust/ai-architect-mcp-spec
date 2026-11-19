import { expect, it } from "vitest";
import { ActionResultSchema } from "../index.js";

it("accepts 16 selected strings and refuses the seventeenth at the result boundary", () => {
  const selected = Array.from({ length: 16 }, (_, i) => String(i));
  const result = { kind: "user_answer", question_id: "pr_gate", selected };
  expect(ActionResultSchema.parse(result)).toEqual(result);
  const parsed = ActionResultSchema.safeParse({ ...result, selected: [...selected, "extra"] });
  expect(parsed.error?.issues).toMatchObject([{ code: "too_big", maximum: 16, inclusive: true, path: ["selected"] }]);
});
