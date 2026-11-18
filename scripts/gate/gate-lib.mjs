/**
 * The decisions of the delivery gate, as pure functions (no process, no
 * file): which production lines a diff changed, which mutants of a Stryker
 * report touch them undetected, whether a tool call is a delivery, and what
 * a sandbox profile becomes for one operation. `gate.mjs` does the I/O.
 *
 * What the gate runs and what counts as production or as a delivery is in
 * `delivery-gate.json`; nothing here names a command or a path of this
 * repository.
 */

/**
 * precondition:  `diff` is the output of `git diff -U0 --src-prefix=a/
 *                --dst-prefix=b/`.
 * postcondition: for each file the diff leaves in place, the ranges of lines
 *                it adds or changes, as [first, last] in the new file, in
 *                the order of the diff. A hunk that only deletes adds no
 *                range: no line of it is left to mutate, so a deleted file
 *                is absent.
 */
const NEW_FILE = "+++ b/";

export function changedLines(diff) {
  const ranges = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith(NEW_FILE)) {
      file = line.slice(NEW_FILE.length);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const first = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    if (!ranges.has(file)) ranges.set(file, []);
    ranges.get(file).push([first, first + count - 1]);
  }
  return ranges;
}

/**
 * precondition:  `ranges` comes from changedLines; `production` is the
 *                source of a regular expression over repository paths.
 * postcondition: the entries of `ranges` whose file is production code, in
 *                the same order. Empty when the diff changes no production
 *                line.
 */
export function productionChanges(ranges, production) {
  const isProduction = new RegExp(production);
  return new Map([...ranges].filter(([file]) => isProduction.test(file)));
}

/** A mutant the tests did not detect, or that Stryker did not finish. */
const UNDETECTED = new Set(["Survived", "NoCoverage", "Pending"]);

/**
 * precondition:  `report` is a mutation-testing-report-schema document
 *                (Stryker's json reporter), with file paths relative to the
 *                repository; `changes` comes from productionChanges.
 * postcondition: the mutants that touch a changed line and that no test
 *                detects, as { file, line, mutator, status, replacement },
 *                in report order; `judged` counts every mutant that touches
 *                a changed line, whatever its status. A mutant touches a
 *                line when its span, first to last line, overlaps a changed
 *                range: an expression written on several lines is judged
 *                when any of its lines changed. Mutants marked equivalent in
 *                the source have the status Ignored and are not undetected.
 */
export function judgeMutants(report, changes) {
  const undetected = [];
  let judged = 0;
  for (const [file, { mutants }] of Object.entries(report.files)) {
    const fileRanges = changes.get(file);
    if (!fileRanges) continue;
    for (const mutant of mutants) {
      const { start, end } = mutant.location;
      if (!fileRanges.some(([first, last]) => start.line <= last && end.line >= first)) continue;
      judged += 1;
      if (UNDETECTED.has(mutant.status)) {
        undetected.push({
          file,
          line: start.line,
          mutator: mutant.mutatorName,
          status: mutant.status,
          replacement: mutant.replacement ?? "",
        });
      }
    }
  }
  return { judged, undetected };
}

/**
 * precondition:  `call` is the JSON a PreToolUse hook receives; `delivers`
 *                is the `delivers` object of delivery-gate.json.
 * postcondition: true iff the call sends work out of the machine: a tool
 *                listed in `delivers.tools`, or a Bash command one of the
 *                `delivers.commands` expressions matches.
 */
export function isDelivery(call, delivers) {
  if (delivers.tools.includes(call?.tool_name)) return true;
  if (call?.tool_name !== "Bash") return false;
  const command = call.tool_input?.command;
  if (typeof command !== "string") return false;
  return delivers.commands.some((source) => new RegExp(source).test(command));
}

/**
 * precondition:  `profile` is a profile file of scripts/gate/profiles, as
 *                parsed JSON; `vars` gives a value to each `${name}` it uses.
 * postcondition: { srt, env }: the settings handed to the sandbox runtime and
 *                the whole environment of the operation, with every `${name}`
 *                of every string replaced. The environment holds the
 *                variables of `env.pass` that `hostEnv` defines, then those
 *                of `env.set`; nothing else of the host crosses. Throws on a
 *                `${name}` that `vars` does not define: a path left with its
 *                placeholder would name nothing, and so protect nothing.
 */
export function resolveProfile(profile, vars, hostEnv) {
  const fill = (value) => {
    if (typeof value === "string") {
      return value.replace(/\$\{(\w+)\}/g, (_, name) => {
        if (!Object.hasOwn(vars, name)) throw new Error(`profile variable \${${name}} is not defined`);
        return vars[name];
      });
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner)]));
    }
    return value;
  };
  const env = {};
  for (const name of profile.env.pass) {
    if (hostEnv[name] !== undefined) env[name] = hostEnv[name];
  }
  Object.assign(env, fill(profile.env.set));
  return { srt: fill(profile.srt), env };
}
