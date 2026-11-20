import { hasDefineStatementText, type DefineHandoffV1, type SectionType } from "@prd-gen/core";
import MarkdownIt from "markdown-it";
import { ACCEPTANCE_REFERENCES, DEFINE_REQUIREMENT_OPTIONS, requirementDefinitions } from "./hard-output-rules/rules/requirement-definitions.js";

type Sections = ReadonlyArray<{ type: SectionType; content: string }>;

const inline = new MarkdownIt("commonmark");

function hasVisibleProse(text: string): boolean {
  // parseInline's block rule creates exactly one inline token with children.
  return inline.parseInline(text, {})[0]!.children!.some(token =>
    token.type === "text" && hasDefineStatementText(token.content));
}

/** Reuse the CommonMark definition parser used by the document rules. */
export function projectDefineDocument(sections: Sections): Pick<DefineHandoffV1, "requirements" | "acceptance"> {
  const definitions = (type: SectionType, prefixes?: readonly string[]) => sections
    .filter(section => section.type === type)
    .flatMap(section => requirementDefinitions(section.content, prefixes, DEFINE_REQUIREMENT_OPTIONS))
    .map(({ id, text }) => ({ id, text: text.replace(/^:(?:\*\*)?/, "").trim() }));

  return {
    requirements: definitions("requirements").map(({ id, text }) => ({ id, text: hasVisibleProse(text) ? text : "" })),
    acceptance: definitions("acceptance_criteria", ["AC"]).map(({ id, text }) => {
      const references = ACCEPTANCE_REFERENCES.exec(text);
      return {
        id,
        text: hasVisibleProse(text.replace(ACCEPTANCE_REFERENCES, "")) ? text : "",
        requirement_ids: references ? references[1]!.split(",").map(id => id.trim()) : [],
      };
    }),
  };
}
