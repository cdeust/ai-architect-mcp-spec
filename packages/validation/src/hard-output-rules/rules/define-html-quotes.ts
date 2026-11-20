import MarkdownIt from "markdown-it";
import htmlInline from "markdown-it/lib/rules_inline/html_inline.mjs";
import { opaqueHtmlBlock } from "./requirement-html.js";

// CommonMark §4.6 HTML blocks of type 6 stop at blank lines. For a quotation
// we need to see the true opening and closing tags through those boundaries.
// The normal inline rule identifies valid HTML and leaves code spans opaque.
const lexer = new MarkdownIt("commonmark").enable("table");
lexer.block.ruler.at("html_block", opaqueHtmlBlock, { alt: ["paragraph", "reference", "blockquote"] });
lexer.inline.ruler.at("html_inline", (state, silent) => {
  const offset = state.pos;
  if (!htmlInline(state, silent)) return false;
  if (!silent) state.tokens.at(-1)!.meta = offset;
  return true;
});
const BLOCK_QUOTE_TAG = /^<\/?blockquote(?=[ \t\n/>])/i;

/** Mask cited HTML without removing line boundaries needed by the block parser. */
export function withoutHtmlBlockQuotes(content: string): string {
  if (!content.toLowerCase().includes("<blockquote")) return content;
  const lines = content.split(/\r\n?|\n/);
  let depth = 0;
  let quoteStart = 0;
  let markdownDepth = 0;
  for (const token of lexer.parse(content, {})) {
    if (token.type === "blockquote_open") markdownDepth++;
    if (token.type === "blockquote_close") markdownDepth--;
    if (markdownDepth > 0 || token.type !== "inline" || !token.map) continue;

    let line = token.map[0];
    let nextBreak = token.content.indexOf("\n");
    for (const child of token.children!) {
      if (child.type !== "html_inline" || !BLOCK_QUOTE_TAG.test(child.content)) continue;
      const offset: number = child.meta;
      while (nextBreak !== -1 && nextBreak < offset) {
        line++;
        nextBreak = token.content.indexOf("\n", nextBreak + 1);
      }
      if (child.content.startsWith("</")) {
        if (depth === 0) continue;
        depth--;
        if (depth === 0) lines.fill("", quoteStart, line + 1);
      } else {
        if (depth === 0) quoteStart = line;
        depth++;
      }
    }
  }
  if (depth > 0) lines.fill("", quoteStart);
  return lines.join("\n");
}
