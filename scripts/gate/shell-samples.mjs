/**
 * Texts of shell drawn from the grammar the guard's command reader claims to
 * read (commandsOf, gate-lib.mjs). The tests run each text in a real shell,
 * with a stand-in `git` that only writes down that it ran, and hold the guard
 * to it: whatever the shell ran as git, the guard must have seen.
 *
 * The draw is a function of the seed alone: the same seed gives the same
 * texts on every machine. Only builtins of the shell and `git` appear in a
 * text, so nothing but the stand-in can run.
 *
 * What a text holds, on purpose, beside the commands: the same push written
 * where it is only text (a string, a comment, the body of a here-document
 * with a quoted end word), and the characters that open or close something
 * elsewhere (quotes, parentheses, braces, `#`, `<<`), written where they are
 * only characters. A reader that takes one for the other loses its place,
 * and misses a command that follows.
 */

/** The command the stand-in records, and the guard refuses. */
export const MARK = "git push --force origin main";

const BARE = ["a", "bc", "1", "x=y"];
const ESCAPED = ["\\;", "\\(", '\\"', "\\'", "\\#", "a\\ b", "\\{"];
const ANSI = ["a\\'b", "it\\'s ; (", "\\n", `${MARK}`];
const SUMS = ["$((1+2))", "$(( (1+2) << 1 ))", "$((1 << 2))"];
// Text, each where it is only text.
const IN_SINGLE = ["a b", MARK, '"', "(", ")", `$(${MARK})`, `\`${MARK}\``, "#", ";", "\n", "\\", "${u:-", "}", "<<E"];
const IN_DOUBLE = ["a b", MARK, "'", "(", ")", " # ", ";", "\n", "}", "{", "|", "&&", "<<E", '\\"', "\\$(", "\\`", "it's"];
const IN_COMMENT = ["a b", MARK, "'", '"', "(", ")", "${", "`", "$(", "don't", ";"];
const IN_QUOTED_BODY = ["a b", MARK, "'", '"', "(", ")", `$(${MARK})`, `\`${MARK}\``, "${", "it's", "E x"];
const IN_EXPANDED_BODY = ["a b", MARK, "'", '"', "(", ")", "#", "it's", "\\$(", "E x"];
// A default value that holds what closes the expansion, as text.
const DEFAULTS = ['"}"', "'}'", "(", "\\}"];
const DEFAULTS_IN_STRING = ['"}"', "'", "(", "\\}"];

/**
 * precondition:  `seed` is a 32-bit integer; `count` a number of texts.
 * postcondition: `count` texts of shell, the same for the same seed.
 */
export function shellSamples(seed, count) {
  // mulberry32: a small generator with a 32-bit state.
  // source: Tommy Ettinger, "Mulberry32", public domain,
  // https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const some = (min, max, make) => Array.from({ length: min + Math.floor(random() * (max - min + 1)) }, make);
  let ends = 0; // each here-document has an end word of its own
  let functions = 0; // and each function a name of its own: none calls itself

  /** Two or three plain commands, as backquotes hold them here: no quote, no backquote. */
  const plain = () => some(1, 2, () => pick([MARK, "echo a", ": b"])).join("; ");
  const then = (list) => (list.endsWith("\n") ? list : `${list}; `);

  const parameter = (depth, inString) => {
    const value = random() < 0.4 ? pick(inString ? DEFAULTS_IN_STRING : DEFAULTS) : word(depth, inString);
    return `\${u:-${value}}`;
  };
  const sum = (depth) => (depth > 0 && random() < 0.4 ? `$(( 1 + $(${list(depth - 1)}) ))` : pick(SUMS));
  const double = (depth) => {
    const part = () => {
      const kinds = ["text", "text", "parameter", "sum"];
      if (depth > 0) kinds.push("substitution", "substitution", "backquote");
      const kind = pick(kinds);
      if (kind === "substitution") return `$(${list(depth - 1)})`;
      if (kind === "backquote") return `\`${plain()}\``;
      if (kind === "parameter") return parameter(depth - 1, true);
      if (kind === "sum") return sum(depth - 1);
      return pick(IN_DOUBLE);
    };
    return `"${some(1, 3, part).join("")}"`;
  };
  const word = (depth, inString) => {
    const kinds = ["bare", "bare", "sum"];
    if (!inString) kinds.push("single", "ansi", "escaped");
    if (depth > 0) kinds.push("double", "parameter", "substitution", "substitution", "backquote");
    const kind = pick(kinds);
    if (kind === "single") return `'${some(1, 3, () => pick(IN_SINGLE)).join("")}'`;
    if (kind === "ansi") return `$'${pick(ANSI)}'`;
    if (kind === "escaped") return pick(ESCAPED);
    if (kind === "double") return double(depth - 1);
    if (kind === "parameter") return parameter(depth - 1, inString);
    if (kind === "substitution") return `$(${list(depth - 1)})`;
    if (kind === "backquote") return `\`${plain()}\``;
    if (kind === "sum") return sum(depth - 1);
    return pick(BARE);
  };

  const hereDocument = (depth) => {
    ends += 1;
    const end = `E${ends}`;
    const form = pick(["plain", "plain", "single", "double", "escaped", "dash"]);
    const quoted = form === "single" || form === "double" || form === "escaped";
    const part = () => {
      if (quoted) return pick(IN_QUOTED_BODY);
      const kind = pick(depth > 0 ? ["text", "text", "substitution", "backquote", "parameter"] : ["text"]);
      if (kind === "substitution") return `$(${list(depth - 1)})`;
      if (kind === "backquote") return `\`${plain()}\``;
      if (kind === "parameter") return parameter(depth - 1, true);
      return pick(IN_EXPANDED_BODY);
    };
    const body = some(1, 3, () => some(1, 3, part).join(" ")).join("\n");
    const written = { plain: end, single: `'${end}'`, double: `"${end}"`, escaped: `\\${end}`, dash: `-${end}` }[form];
    return `: <<${written}\n${body}\n${form === "dash" ? "\t" : ""}${end}\n`;
  };

  const simple = (depth) => {
    const kind = pick(["echo", "echo", "colon", "mark", "mark", "assigned", "wrapped", "option", "document", "comment", "trailing"]);
    if (kind === "echo") return `echo ${some(1, 3, () => word(depth, false)).join(" ")}`;
    if (kind === "colon") return `: ${word(depth, false)}`;
    if (kind === "assigned") return `v=${word(depth, false)} ${MARK}`;
    if (kind === "wrapped") return `${pick(["command", "eval", "time"])} ${MARK}`;
    if (kind === "option") return `git -c x=${word(depth, false)} push --force origin main`;
    if (kind === "document") return hereDocument(depth);
    if (kind === "comment") return `# ${some(1, 3, () => pick(IN_COMMENT)).join(" ")}\n`;
    if (kind === "trailing") return `echo a # ${some(1, 3, () => pick(IN_COMMENT)).join(" ")}\n`;
    return MARK;
  };
  const compound = (depth) => {
    const kind = pick(["if", "else", "braces", "subshell", "not", "for", "case", "pattern", "function"]);
    if (kind === "if") return `if ${then(list(depth))}then ${then(list(depth))}fi`;
    if (kind === "else") return `if ${then(list(depth))}then ${then(list(depth))}else ${then(list(depth))}fi`;
    if (kind === "braces") return `{ ${then(list(depth))}}`;
    if (kind === "subshell") return `(${list(depth)})`;
    if (kind === "not") return `! ${MARK}`;
    if (kind === "for") return `for r in a b; do ${then(list(depth))}done`;
    if (kind === "case") return `case a in a) ${list(depth)}\n;; b) echo b;; esac`;
    if (kind === "pattern") return `case a in (a) ${list(depth)}\n;; esac`;
    functions += 1;
    const name = `f${functions}`;
    return `${name}() { ${then(list(depth))}}; ${name}`;
  };
  const list = (depth) => {
    const commands = some(1, 3, () => (depth > 0 && random() < 0.3 ? compound(depth - 1) : simple(depth)));
    return commands.reduce((text, command) => text + (text.endsWith("\n") ? "" : pick(["; ", " && ", "\n", " | ", " || "])) + command);
  };

  return Array.from({ length: count }, () => list(3));
}
