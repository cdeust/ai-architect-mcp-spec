import type { DefineHandoffV1, SectionType } from "@prd-gen/core";
import MarkdownIt from "markdown-it";
import { requirementDefinitions } from "./hard-output-rules/rules/requirement-definitions.js";

type Sections = ReadonlyArray<{ type: SectionType; content: string }>;

// A final parenthesized list after whitespace is the explicit traceability
// marker. A URL destination or a reference inside inline code or a comment
// cannot supply it, since the closing Markdown punctuation would follow it.
const ACCEPTANCE_REFERENCES = /[ \t]\(((?:FR|NFR)-\d{1,9}(?:[ \t]*,[ \t]*(?:FR|NFR)-\d{1,9})*)\)\.?$/;
const inline = new MarkdownIt("commonmark", { html: true });

function hasVisibleProse(text: string): boolean {
  return inline.parseInline(text, {})[0]?.children?.some(token =>
    token.type === "text" && /[\p{L}\p{N}]/u.test(token.content)) ?? false;
}

/** Reuse the CommonMark definition parser used by the document rules. */
export function projectDefineDocument(sections: Sections): Pick<DefineHandoffV1, "requirements" | "acceptance"> {
  const definitions = (type: SectionType, prefixes?: readonly string[]) => sections
    .filter(section => section.type === type)
    .flatMap(section => requirementDefinitions(section.content, prefixes))
    .map(({ id, text }) => ({ id, text: text.replace(/^:(?:\*\*)?/, "").trim() }));

  return {
    requirements: definitions("requirements").map(({ id, text }) => ({ id, text: hasVisibleProse(text) ? text : "" })),
    acceptance: definitions("acceptance_criteria", ["AC"]).map(({ id, text }) => ({
      id,
      text: hasVisibleProse(text.replace(ACCEPTANCE_REFERENCES, "")) ? text : "",
      requirement_ids: ACCEPTANCE_REFERENCES.exec(text)?.[1]?.split(",").map(id => id.trim()) ?? [],
    })),
  };
}
