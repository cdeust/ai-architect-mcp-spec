import MarkdownIt, { type MarkdownIt as Parser } from "markdown-it";

// CommonMark §4.6 HTML blocks of type 6 stop at blank lines. For a quotation
// we need to see valid tags through those boundaries and leave code opaque.
// Use the normal inline rule (§6.6), recording the tag's offset in its token.
// markdown-it 15 no longer exports its rule modules (`markdown-it/lib/…`), so
// the rule is taken from the parser's own chain before it is wrapped.
const lexer = new MarkdownIt("commonmark");
const htmlInline = lexer.inline.ruler.__rules__.find((rule) => rule.name === "html_inline")?.fn;
if (htmlInline === undefined) throw new Error("markdown-it has no html_inline rule");
lexer.inline.ruler.at("html_inline", (state, silent) => {
  const offset = state.pos;
  const first = state.tokens.length;
  const matched = htmlInline(state, silent);
  if (state.tokens.length > first) state.tokens.at(-1)!.meta = { offset };
  return matched;
});
const BLOCK_QUOTE_TAG = /^<\/?blockquote(?=[ \t\n/>])/i;

/** Remove HTML quotations from inline source while preserving the block tree. */
export function parseWithoutHtmlQuotes(content: string, plainParser: Parser) {
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
      const offset = child.meta!.offset as number;
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
