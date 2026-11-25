import MarkdownIt, { type MarkdownIt as Parser, type Token } from "markdown-it";

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

interface Scope {
  /** First inline outside the container. The document root has no closing token. */
  end?: number;
}

interface Tag {
  source: Token;
  closer?: Tag;
}

interface Inline {
  token: Token;
  tags: Tag[];
  scope: Scope;
}

function quoteTags(content: string): Tag[] {
  const [inline] = lexer.parseInline(content, {});
  return inline!.children!
    .filter(child => child.type === "html_inline" && BLOCK_QUOTE_TAG.test(child.content))
    .map(source => ({ source }));
}

function scopedInlines(tokens: Token[]): Inline[] {
  const inlines: Inline[] = [];
  const scopes: Scope[] = [{}];
  let markdownDepth = 0;
  for (const token of tokens) {
    if (token.type === "blockquote_open") markdownDepth++;
    if (token.type === "blockquote_close") markdownDepth--;
    if (markdownDepth > 0) continue;
    if (token.type.startsWith("heading_") || ["li", "td", "th"].includes(token.tag)) {
      if (token.nesting === 1) scopes.push({});
      else scopes.pop()!.end = inlines.length;
    } else if (token.type === "inline") {
      inlines.push({ token, tags: quoteTags(token.content), scope: scopes.at(-1)! });
    }
  }
  return inlines;
}

function pairQuotes(inlines: Inline[]): void {
  const open: { tag: Tag; scope: Scope }[] = [];
  for (const [index, { scope, tags }] of inlines.entries()) {
    // A child can close its parent's quote. A sibling cannot close the child's.
    while (open.length && (open.at(-1)!.scope.end ?? Infinity) <= index) open.pop();
    for (const tag of tags) {
      if (tag.source.content.startsWith("</")) {
        const opener = open.pop();
        if (opener) opener.tag.closer = tag;
      } else {
        open.push({ tag, scope });
      }
    }
  }
}

function removePairedQuotes(inlines: Inline[]): void {
  let closing: Tag | undefined;
  for (const { token, tags } of inlines) {
    const visible: string[] = [];
    let cursor = 0;
    for (const tag of tags) {
      const offset = tag.source.meta!.offset as number;
      if (tag === closing) {
        cursor = offset + tag.source.content.length;
        closing = undefined;
      } else if (!closing && tag.closer) {
        visible.push(token.content.slice(cursor, offset));
        closing = tag.closer;
      }
    }
    if (!closing) visible.push(token.content.slice(cursor));
    token.content = visible.join("");
  }
}

/** Remove only paired HTML quotations, preserving the original block tree. */
export function parseWithoutHtmlQuotes(content: string, plainParser: Parser) {
  const tokens = plainParser.parse(content, {});
  if (!content.toLowerCase().includes("<blockquote")) return tokens;
  const inlines = scopedInlines(tokens);
  pairQuotes(inlines);
  removePairedQuotes(inlines);
  return tokens;
}
