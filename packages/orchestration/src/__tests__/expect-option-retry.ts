import { expect } from "vitest";
import type { NextAction } from "../types/actions.js";

export function expectOptionRetry(action: NextAction, original: NextAction) {
  if (original.kind !== "ask_user" || !original.options) throw new Error("Expected an option question");
  expect(action).toMatchObject({ ...original, description: expect.stringContaining(original.description) });
  if (action.kind !== "ask_user") throw new Error("Expected the question again");
  expect(action.description).toContain("not one of the options");
  for (const { label } of original.options) expect(action.description).toContain(label);
}
