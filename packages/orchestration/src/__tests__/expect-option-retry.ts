import { expect } from "vitest";
import type { NextAction } from "../types/actions.js";

export function expectOptionRetry(action: NextAction, original: NextAction, accepted?: string) {
  if (original.kind !== "ask_user" || !original.options) throw new Error("Expected an option question");
  const labels = accepted ?? original.options.map(({ label }) => label).join(", ");
  expect(action).toEqual({
    ...original,
    description: `${original.description}\n\nYour answer was not one of the options. Choose one of: ${labels}.`,
  });
}
