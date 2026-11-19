import { expect, it } from "vitest";
import { matchOfferedOption } from "../handlers/match-offered-option.js";

const options = [{ label: "First   Option" }, { label: "No" }];

it("returns the canonical offered label and refuses multiple selections even when freeform agrees with the first", () => {
  expect(matchOfferedOption(options, { selected: [" first\tOPTION ", "No"], freeform: " FIRST Option " })).toBeUndefined();
  expect(matchOfferedOption(options, { selected: ["", " first\tOPTION ", "  "], freeform: " FIRST Option " })).toBe("First   Option");
  expect(matchOfferedOption(options, { selected: [], freeform: " NO " })).toBe("No");
  expect(matchOfferedOption(options, { selected: ["unknown", "No"], freeform: "No" })).toBeUndefined();
});

it.each(["first", "not first option", "", undefined])("requires a whole option for %s", (freeform) => {
  expect(matchOfferedOption(options, { selected: [], freeform })).toBeUndefined();
});

it("requires an answer even if an option has an empty label", () => {
  expect(matchOfferedOption([{ label: "" }], { selected: [] })).toBeUndefined();
});

it("requires agreement between nonblank fields and ignores blank selections", () => {
  expect(matchOfferedOption(options, { selected: ["No"], freeform: "First Option" })).toBeUndefined();
  expect(matchOfferedOption(options, { selected: ["  "], freeform: "no" })).toBe("No");
  expect(matchOfferedOption(options, { selected: ["NO"], freeform: " " })).toBe("No");
});

it("preserves word boundaries and rejects an absent answer regardless of the labels", () => {
  expect(matchOfferedOption(options, { selected: ["FirstOption"] })).toBeUndefined();
  expect(matchOfferedOption([{ label: "Stryker was here!" }], { selected: [] })).toBeUndefined();
});

it("compares lowercase labels without aliasing Unicode long s to ASCII S", () => {
  const labels = [{ label: "PUSH" }];
  expect(matchOfferedOption(labels, { selected: ["PUSH"] })).toBe("PUSH");
  expect(matchOfferedOption(labels, { selected: ["PuSh"] })).toBe("PUSH");
  expect(matchOfferedOption(labels, { selected: ["Puſh"] })).toBeUndefined();
});

it("compares canonically equivalent text on both sides and preserves compatibility distinctions", () => {
  const nfd = "de\u0301rogation";
  expect(matchOfferedOption([{ label: nfd }], { selected: ["dérogation"] })).toBe(nfd);
  expect(matchOfferedOption([{ label: "dérogation" }], { selected: [], freeform: nfd })).toBe("dérogation");
  expect(matchOfferedOption(options, { selected: ["Ｎｏ"] })).toBeUndefined();
});
