import { expect, it } from "vitest";
import { matchOfferedOption } from "../handlers/match-offered-option.js";

const options = [{ label: "First   Option" }, { label: "No" }];

it("returns the canonical offered label and gives the first selection precedence", () => {
  expect(matchOfferedOption(options, { selected: [" first\tOPTION ", "No"], freeform: "No" })).toBe("First   Option");
  expect(matchOfferedOption(options, { selected: [], freeform: " NO " })).toBe("No");
  expect(matchOfferedOption(options, { selected: ["unknown", "No"], freeform: "No" })).toBeUndefined();
});

it.each(["first", "not first option", "", undefined])("requires a whole option for %s", (freeform) => {
  expect(matchOfferedOption(options, { selected: [], freeform })).toBeUndefined();
});

it("requires an answer even if an option has an empty label", () => {
  expect(matchOfferedOption([{ label: "" }], { selected: [] })).toBeUndefined();
});
