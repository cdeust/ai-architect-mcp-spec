import MarkdownIt from "markdown-it";
import htmlInline from "markdown-it/lib/rules_inline/html_inline.mjs";

// CommonMark §4.6 HTML blocks of type 6 stop at blank lines. For a quotation
// we need to see valid tags through those boundaries and leave code opaque.
// Use the normal inline rule (§6.6), recording the tag's offset in its token.
const lexer = new MarkdownIt("commonmark");
lexer.inline.ruler.at("html_inline", (state, silent) => {
  const offset = state.pos;
  const first = state.tokens.length;
  const matched = htmlInline(state, silent);
  if (state.tokens.length > first) state.tokens.at(-1)!.meta = offset;
  return matched;
});
const BLOCK_QUOTE_TAG = /^<\/?blockquote(?=[ \t\n/>])/i;

/** Remove HTML quotations from inline source while preserving the block tree. */
export function parseWithoutHtmlQuotes(content: string, plainParser: MarkdownIt) {
  const env = {};
  const tokens = plainParser.parse(content, env);
  if (!content.toLowerCase().includes("<blockquote")) return tokens;
  let depth = 0;
  let markdownDepth = 0;
  for (const token of tokens) {
    if (token.type === "blockquote_open") markdownDepth++;
    if (token.type === "blockquote_close") markdownDepth--;
    if (markdownDepth > 0 || token.type !== "inline") continue;

    const visible: string[] = [];
    let cursor = 0;
    const [inline] = lexer.parseInline(token.content, env);
    for (const child of inline!.children!) {
      if (child.type !== "html_inline" || !BLOCK_QUOTE_TAG.test(child.content)) continue;
      const offset: number = child.meta;
      if (child.content.startsWith("</")) {
        if (depth === 0) continue;
        depth--;
        cursor = offset + child.content.length;
      } else {
        if (depth === 0) visible.push(token.content.slice(cursor, offset));
        depth++;
      }
    }
    if (depth === 0) visible.push(token.content.slice(cursor));
    token.content = visible.join("");
  }
  return tokens;
}
