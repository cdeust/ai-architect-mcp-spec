declare module "markdown-it/lib/rules_inline/html_inline.mjs" {
  import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
  export default function htmlInline(state: StateInline, silent: boolean): boolean;
}
