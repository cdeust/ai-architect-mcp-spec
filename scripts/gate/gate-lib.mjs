/**
 * The decisions of the delivery gate. No process, no file, no clock here:
 * what touches the machine comes in through `ports`, so every decision is
 * run in a test with a double and is inside the gate's own mutation
 * perimeter. `gate.mjs` holds the adapters and nothing else.
 *
 * What the gate runs, what counts as production code, what a sandboxed
 * operation may reach and what the guard refuses are in descriptive files
 * (`delivery-gate.json`, `profiles/*.json`): nothing here names a command or
 * a path of this repository.
 *
 * Threat model (CONTRIBUTING.md, "The delivery gate"):
 *   - what a check executes (dependencies, build scripts, tests) is not
 *     trusted: it runs in a sandbox, on a copy of the committed tree, and
 *     can write that copy and nothing else, nor read the user's files;
 *   - a session that forgets the gate is stopped at the push, by git itself,
 *     and a commit that changes the gate is judged by the gate of the base
 *     revision, never by its own;
 *   - a session that forges a verdict on purpose is not stopped here: the
 *     hosted pipeline is what holds against it.
 */

/** A refusal to run or to judge: configuration, repository state, sandbox. */
export class Refusal extends Error {}

// ─── Configuration ──────────────────────────────────────────────────────────

const isText = (value) => typeof value === "string" && value !== "";
const isTextList = (value) => Array.isArray(value) && value.every(isText);
const isArgv = (value) => isTextList(value) && value.length > 0;

function expression(source, where) {
  if (!isText(source)) throw new Refusal(`delivery-gate.json: ${where} must be a regular expression`);
  try {
    return new RegExp(source);
  } catch (error) {
    throw new Refusal(`delivery-gate.json: ${where} is not a regular expression (${error.message})`);
  }
}

/**
 * precondition:  `raw` is delivery-gate.json, parsed.
 * postcondition: `raw`, when every key the gate reads is there with its
 *                type; else a Refusal that names the first faulty key. The
 *                gate validates before it runs anything: a malformed file
 *                never becomes a check that did not run or a guard that let
 *                a call through.
 */
export function validateConfig(raw) {
  const fail = (what) => {
    throw new Refusal(`delivery-gate.json: ${what}`);
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("must be an object");
  if (!isText(raw.base)) fail("base must be a git revision");
  if (!Array.isArray(raw.checks)) fail("checks must be a list");
  raw.checks.forEach((check, index) => {
    if (!isText(check?.name)) fail(`checks[${index}].name must be a name`);
    if (!isText(check.profile)) fail(`checks[${index}].profile must name a profile`);
    if (!isArgv(check.command)) fail(`checks[${index}].command must be a list of arguments`);
  });
  const mutation = raw.mutation;
  if (mutation === null || typeof mutation !== "object") fail("mutation must be an object");
  expression(mutation.production, "mutation.production");
  if (!isArgv(mutation.command)) fail("mutation.command must be a list of arguments");
  if (!isText(mutation.report)) fail("mutation.report must be a path");
  if (!isText(mutation.profile)) fail("mutation.profile must name a profile");
  if (!isTextList(raw.carry)) fail("carry must be a list of directory names");
  const guard = raw.guard;
  if (guard === null || typeof guard !== "object") fail("guard must be an object");
  expression(guard.start, "guard.start");
  const written = (source, where) => expression(fill(source, guardWords(guard)), where);
  written(guard.git, "guard.git");
  if (!Array.isArray(guard.push)) fail("guard.push must be a list");
  guard.push.forEach((source, index) => written(source, `guard.push[${index}]`));
  if (!Array.isArray(guard.refuse)) fail("guard.refuse must be a list");
  guard.refuse.forEach((rule, index) => {
    written(rule?.pattern, `guard.refuse[${index}].pattern`);
    if (!isText(rule.why)) fail(`guard.refuse[${index}].why must say why`);
  });
  if (!isTextList(guard.hosted)) fail("guard.hosted must be a list of environment variable names");
  if (!isTextList(guard.refusedTools)) fail("guard.refusedTools must be a list of tool names");
  return raw;
}

// ─── The lines a change touches ─────────────────────────────────────────────

/**
 * precondition:  `diff` is `git diff -U0` of ONE file. Which file is known
 *                to the caller, from a list git gave with its names intact:
 *                no file header is read here, so a quoted name, a name with
 *                a space or a line of content that looks like a header
 *                cannot move a hunk to another file.
 * postcondition: the ranges of lines the diff adds or changes, as
 *                [first, last] in the new file, in order. A hunk that only
 *                deletes adds no range: no line of it is left to mutate.
 */
export function hunkRanges(diff) {
  const ranges = [];
  for (const line of diff.split("\n")) {
    // A line of content starts with "+", "-", " " or "\": never with "@".
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const first = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) ranges.push([first, first + count - 1]);
  }
  return ranges;
}

/** The names among `names` that are production code. */
export function productionFiles(names, production) {
  const isProduction = new RegExp(production);
  return names.filter((name) => isProduction.test(name));
}

/**
 * The names the gate will not hand to the mutation tool: it reads its file
 * arguments as patterns, split on commas, so `[id].ts` or `a,b.ts` would be
 * mutated as something else, or as nothing, without an error.
 */
export function unsafeNames(names) {
  return names.filter((name) => !/^[\w@./-]+$/.test(name));
}

/**
 * postcondition: the lines of `source` that turn mutation off for more than
 *                the next line (the tool's directive to disable, for `all`
 *                or for a mutator, without `next-line`): 1-based, in order.
 *                The gate accepts a mark on one line with its reason; a mark
 *                over a file or a block would give every mutant under it
 *                that one reason. The words are looked for anywhere in a
 *                line, a comment that only quotes them included: this file
 *                does not write them out for that reason.
 */
export function blanketDisables(source) {
  return source.split("\n").flatMap((line, index) => (/\bStryker\s+disable\b(?!\s+next-line\b)/.test(line) ? [index + 1] : []));
}

// ─── The mutants of a change ────────────────────────────────────────────────

/**
 * The statuses that say a test saw the mutant. RuntimeError and CompileError
 * are among them: the mutated code did not load or did not compile, which no
 * run of the suite survives. Every other status, one a later version of the
 * tool adds included, is undetected.
 */
const DETECTED = new Set(["Killed", "Timeout", "RuntimeError", "CompileError"]);
const EQUIVALENT = /^equivalent: \S/;

/**
 * precondition:  `report` is a mutation-testing-report-schema document, its
 *                file paths relative to the repository; `changes` maps each
 *                changed production file to its hunkRanges.
 * postcondition: `judged` counts the mutants that touch a changed line;
 *                `undetected` lists those no test saw, as { file, line,
 *                mutator, status, replacement }, in report order. A mutant
 *                touches a line when its span overlaps a changed range, so
 *                an expression written on several lines is judged when any
 *                of its lines changed. A mutant the source marks is passed
 *                only when its reason starts with "equivalent: ": a blanket
 *                disable, or one without a reason, is undetected.
 */
export function judgeMutants(report, changes) {
  const undetected = [];
  let judged = 0;
  for (const [file, { mutants }] of Object.entries(report.files)) {
    const ranges = changes.get(file);
    if (!ranges) continue;
    for (const mutant of mutants) {
      const { start, end } = mutant.location;
      if (!ranges.some(([first, last]) => start.line <= last && end.line >= first)) continue;
      judged += 1;
      const passed =
        DETECTED.has(mutant.status) ||
        (mutant.status === "Ignored" && EQUIVALENT.test(mutant.statusReason));
      if (!passed) {
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

// ─── Sandbox profiles ───────────────────────────────────────────────────────

/**
 * precondition:  `path` is a PATH value; `separator` the one of the
 *                platform; `isAbsolute(dir)` says whether an entry is
 *                absolute; `inside(dir)` whether it lies in a tree that is
 *                judged or that an operation writes.
 * postcondition: PATH for the sandbox runtime and for the operation: the
 *                absolute entries that are in none of those trees, in order
 *                (an empty entry, which stands for the current directory, is
 *                not absolute).
 *                The runtime starts programs by name before the sandbox is
 *                up; an entry a check can write, or a relative one read from
 *                the copy, would hand it a program of the judged tree to run
 *                outside the sandbox.
 */
export function safePath(path, separator, { isAbsolute, inside }) {
  return path
    .split(separator)
    .filter((dir) => isAbsolute(dir) && !inside(dir))
    .join(separator);
}

/**
 * precondition:  `value` is JSON; `vars` gives each `${name}` a string, or a
 *                list of strings.
 * postcondition: `value` with every `${name}` of every string replaced. An
 *                element of a list that is exactly `${name}` of a list
 *                variable becomes the elements of that list. Throws a Refusal
 *                on a name `vars` does not define, and on a list variable
 *                used inside a longer string: a path left with its
 *                placeholder would name nothing, and so protect nothing.
 */
export function fill(value, vars) {
  const lookup = (name) => {
    if (!Object.hasOwn(vars, name)) throw new Refusal(`variable \${${name}} is not defined`);
    return vars[name];
  };
  if (typeof value === "string") {
    return value.replace(/\$\{(\w+)\}/g, (_, name) => {
      const found = lookup(name);
      if (Array.isArray(found)) throw new Refusal(`variable \${${name}} is a list: it stands alone in a list`);
      return found;
    });
  }
  if (Array.isArray(value)) {
    return value.flatMap((element) => {
      const whole = /^\$\{(\w+)\}$/.exec(element);
      if (whole && Array.isArray(lookup(whole[1]))) return lookup(whole[1]);
      return [fill(element, vars)];
    });
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner, vars)]));
  }
  return value;
}

/**
 * postcondition: { srt, env }: the settings handed to the sandbox runtime and
 *                the whole environment of the operation. The environment
 *                holds the variables of `env.pass` that `hostEnv` defines,
 *                then those of `env.set`; nothing else of the host crosses.
 */
export function resolveProfile(profile, vars, hostEnv) {
  const env = {};
  for (const name of profile.env.pass) {
    if (hostEnv[name] !== undefined) env[name] = hostEnv[name];
  }
  Object.assign(env, fill(profile.env.set, vars));
  return { srt: fill(profile.srt, vars), env };
}

/**
 * precondition:  `srt` is the resolved settings of a profile; `kindOf(path)`
 *                is "dir", "file" or null for a path that is not there;
 *                `keep` lists directories no operation may write (the tree
 *                that is judged, the git directory, the gate, a directory
 *                outside everything); `hostPort` is a port of the host with
 *                a listener; `mark` is a name no file has yet.
 * postcondition: the attempts the canary makes inside the sandbox, one per
 *                promise that can be put to the test, as its arguments, with
 *                what they prove: a write in each directory of `keep` and in
 *                each path the profile denies that is there; a read of each
 *                path it denies that is there; and the host's port, when the
 *                profile does not grant the loopback. `created` lists the
 *                files a sandbox that does not hold would leave behind;
 *                `expected` is the line the canary prints when every attempt
 *                was refused.
 */
export function canaryPlan(srt, { kindOf, keep, hostPort, mark }) {
  const args = [];
  const created = [];
  let writes = 0;
  let reads = 0;
  for (const path of [...keep, ...srt.filesystem.denyWrite]) {
    const kind = kindOf(path);
    if (kind === null) continue;
    // In a directory, a new file; on a file, an append of nothing.
    const target = kind === "dir" ? `${path}/${mark}` : path;
    args.push(kind === "dir" ? "--write" : "--append", target);
    if (kind === "dir") created.push(target);
    writes += 1;
  }
  for (const path of srt.filesystem.denyRead) {
    const kind = kindOf(path);
    if (kind === null) continue;
    args.push(kind === "dir" ? "--list" : "--read", path);
    reads += 1;
  }
  const port = srt.network.allowLocalBinding !== true;
  if (port) args.push("--connect", String(hostPort));
  // What the canary prints when every attempt was refused: the gate reads
  // that line, not a status alone, which the runtime also gives a command
  // that was ended before it finished.
  const expected = `canary: ${args.length / 2} attempt(s), all refused`;
  return { args, created, expected, proves: { writes, reads, port } };
}

// ─── Verdicts ───────────────────────────────────────────────────────────────

/**
 * postcondition: null when `verdict` is a passed verdict of this gate for
 *                this tree; else the reason it is not, in words. A verdict
 *                written by another gate (other code, other configuration,
 *                other profiles) is not one. The hook that calls this runs
 *                the gate of the base revision, so the verdict of a gate a
 *                commit brought with it is refused here.
 */
export function verdictRefusal(verdict, tree, gateHash) {
  if (verdict === null) return "it has no verdict of the delivery gate";
  if (verdict.passed !== true || verdict.tree !== tree) return "its verdict is not a passed verdict for this tree";
  if (verdict.gate !== gateHash) return "its verdict was written by another gate than the one of the base revision";
  return null;
}

/**
 * precondition:  `input` is what git writes to a pre-push hook: one line per
 *                ref, `<local ref> <local sha> <remote ref> <remote sha>`.
 * postcondition: the tip of each ref the push sends, as { ref, sha }. A deletion
 *                (local sha all zeros) sends nothing. A line that is not in
 *                that form is a Refusal: nothing is let through unread.
 */
export function pushedCommits(input) {
  const out = [];
  for (const line of input.split("\n")) {
    if (line.trim() === "") continue;
    const parts = /^(\S+) ([0-9a-f]{40,64}) \S+ [0-9a-f]{40,64}$/.exec(line.trim());
    if (!parts) throw new Refusal(`unreadable line from git: ${line}`);
    if (/^0+$/.test(parts[2])) continue;
    out.push({ ref: parts[1], sha: parts[2] });
  }
  return out;
}

/**
 * The pre-push hook of git: the tip of every ref a push sends has a tree
 * with a passed verdict of this gate. Git names what is pushed, whatever
 * wrote the command: an alias, a script, a variable, another tool. The tip
 * is what the ref will be; a commit below it is not judged on its own.
 *
 * ports: treeOf(sha), readVerdict(tree), gateHash, log(line).
 * postcondition: 0 when every pushed tip holds; 1, with one line per tip
 *                that does not, otherwise.
 */
export function prePush(input, ports) {
  const refusals = pushedCommits(input).flatMap(({ ref, sha }) => {
    const tree = ports.treeOf(sha);
    const reason = verdictRefusal(ports.readVerdict(tree), tree, ports.gateHash);
    return reason === null ? [] : [`[gate] push refused: ${ref} (tree ${tree}): ${reason}. Commit the work and run the gate (pnpm gate).`];
  });
  refusals.forEach(ports.log);
  return refusals.length === 0 ? 0 : 1;
}

// ─── The guard of the session (PreToolUse hook) ─────────────────────────────

/**
 * The words an expression of the guard may use: `${start}`, where a command
 * starts, after the assignments and the wrappers before it; `${git}`, git
 * with its own options, up to its subcommand.
 */
function guardWords(guard) {
  const start = guard.start;
  return { start, git: fill(guard.git, { start }) };
}

/** What stands for a quoted string in a command the guard reads. */
const QUOTED = '""';

/**
 * precondition:  `text` is what a tool hands to a shell.
 * postcondition: the commands of `text`, one string each, as the guard reads
 *                them: split where the shell starts a new command (`;`, `&`,
 *                `|`, a line end, a parenthesis), with every quoted string
 *                replaced by `""` and every here-document left out. So the
 *                guard reads commands, never the text they carry: the body of
 *                a comment, a commit message or a script that names a refused
 *                command is not that command. What the shell runs inside a
 *                string is read as commands of its own: a command
 *                substitution (`$(…)`, backquotes), and the here-documents it
 *                opens, so `"$(cat <<'EOF' … EOF)"` is a `cat` and its text.
 *                A command a program is handed as a string (`sh -c '…'`) is
 *                not read. Text that is not closed runs to the end.
 */
export function commandsOf(text) {
  // Each expression is tried at one place of the text (sticky), never searched for.
  const single = /'[^']*'?/y;
  const hereDocument = /<<-?\s*(['"]?)([\w.-]+)\1/y;
  const arithmetic = /\$\(\([^)]*\)\)/y;
  const out = [];
  const pending = []; // the end words of the here-documents opened on the current line
  let i = 0;
  const here = (expression) => {
    expression.lastIndex = i;
    return expression.exec(text);
  };
  /** Past the bodies of the here-documents the line opened: text, not commands. */
  const skipBodies = () => {
    while (pending.length > 0) {
      const word = pending.shift();
      let closed = false;
      while (!closed && i < text.length) {
        const end = text.indexOf("\n", i);
        const line = text.slice(i, end === -1 ? text.length : end);
        i += line.length + 1;
        closed = line.trim() === word;
      }
    }
  };
  /** The commands up to `close` (or the end), which is consumed. */
  const commands = (close) => {
    let current = "";
    const flush = () => {
      const command = current.trim().replace(/\s+/g, " ");
      if (command !== "") out.push(command);
      current = "";
    };
    /** A double-quoted string: text, but for the commands the shell runs inside it. */
    const doubleQuoted = () => {
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i += 2;
        else if (text.startsWith("$(", i) && here(arithmetic) === null) {
          i += 2;
          commands(")");
        } else if (text[i] === "`") {
          i += 1;
          commands("`");
        } else if (text[i] === "\n") {
          i += 1;
          skipBodies();
        } else i += 1;
      }
      i += 1;
    };
    while (i < text.length && text[i] !== close) {
      const ch = text[i];
      const quoted = here(single);
      const opened = here(hereDocument);
      const sum = here(arithmetic);
      if (ch === "\\") {
        // An escaped character is a character of a word; an escaped line end joins two lines.
        if (text[i + 1] !== "\n") current += "_";
        i += 2;
      } else if (quoted !== null) {
        current += QUOTED;
        i += quoted[0].length;
      } else if (ch === '"') {
        current += QUOTED;
        doubleQuoted();
      } else if (sum !== null) {
        // `$((1<<2))`: a number, with no here-document in it.
        current += "0";
        i += sum[0].length;
      } else if (text.startsWith("<<<", i)) {
        // A here-string: a word follows, not a body.
        current += "<<<";
        i += 3;
      } else if (opened !== null) {
        pending.push(opened[2]);
        i += opened[0].length;
      } else if (ch === "\n") {
        flush();
        i += 1;
        skipBodies();
      } else if (ch === "(" || ch === "`") {
        // A subshell, a command substitution: commands of their own, up to what closes them.
        flush();
        i += 1;
        commands(ch === "(" ? ")" : "`");
      } else if (";&|)".includes(ch)) {
        flush();
        i += 1;
      } else {
        current += ch;
        i += 1;
      }
    }
    flush();
    i += 1;
  };
  while (i < text.length) commands(undefined);
  return out;
}

/**
 * precondition:  `call` is the JSON a PreToolUse hook receives; `guard` is
 *                the `guard` object of delivery-gate.json.
 * postcondition: what the guard does with the call:
 *                  { kind: "refuse", reason }  a tool that sends content the
 *                    gate cannot judge, or a command one of the rules of
 *                    `guard.refuse` matches, with the rule's reason;
 *                  { kind: "push" }  a command that pushes: the caller lets
 *                    it through only when the pre-push hook is in place;
 *                  { kind: "allow" }  anything else.
 *                The command is read from any tool that carries one, not
 *                from one tool by its name, and as commands (commandsOf),
 *                not as text. The verdict is not judged here: git does it at
 *                the push, on the tips really sent.
 */
export function guardDecision(call, guard) {
  if (guard.refusedTools.includes(call?.tool_name)) {
    return {
      kind: "refuse",
      reason: `${call.tool_name} sends content the delivery gate cannot judge. Commit, run the gate, and push with git.`,
    };
  }
  const command = call?.tool_input?.command;
  if (typeof command !== "string") return { kind: "allow" };
  // Each command of the text on its own, whatever its case.
  const commands = commandsOf(command);
  const words = guardWords(guard);
  const matches = (source) => {
    const expressionOf = new RegExp(fill(source, words), "i");
    return commands.some((one) => expressionOf.test(one));
  };
  const rule = guard.refuse.find(({ pattern }) => matches(pattern));
  if (rule !== undefined) return { kind: "refuse", reason: rule.why };
  if (guard.push.some(matches)) return { kind: "push" };
  return { kind: "allow" };
}

/**
 * ports: hookProblem() — null when the pre-push hook of the gate is the one
 *        git will run, else why not; env — the environment of the session;
 *        log(line).
 * postcondition: 0 to let the call through, 2 to block it (the exit code a
 *                PreToolUse hook blocks on). A refusal holds everywhere. A
 *                push needs the pre-push hook in place, except in a session
 *                that runs on the hosted pipeline (a variable of
 *                `guard.hosted` is "true"): the checkout of a runner has no
 *                hook and no verdict, and what it pushes is judged by the
 *                pipeline before it can merge.
 */
export function guardHook(call, guard, ports) {
  const decision = guardDecision(call, guard);
  if (decision.kind === "allow") return 0;
  if (decision.kind === "refuse") {
    ports.log(`Refused: ${decision.reason}`);
    return 2;
  }
  if (guard.hosted.some((name) => ports.env[name] === "true")) return 0;
  const problem = ports.hookProblem();
  if (problem === null) return 0;
  ports.log(`Push refused: the pre-push hook of the delivery gate is not in place (${problem}). Run \`pnpm gate:install\`.`);
  return 2;
}

// ─── The run ────────────────────────────────────────────────────────────────

/**
 * The gate: the checks, then mutation testing of the production lines the
 * change touches, each operation in its sandbox, on a disposable copy of the
 * committed tree; then a verdict for that tree.
 *
 * The tree that is judged is never written: what a check leaves behind (a
 * build, a cache, a planted file) is in the copy, which is removed. So the
 * verdict is for the tree the checks ran on, by construction, and nothing a
 * check wrote is there to be run later outside the sandbox.
 *
 * ports:
 *   log(line)
 *   headTree()                    the hash of the tree of HEAD
 *   status()                      `git status --porcelain`, "" when clean
 *   changedFiles(base)            the files the commits add or modify
 *   fileDiff(base, file)          `git diff -U0` of one file
 *   prepare()                     make the copy of the committed tree
 *   dispose()                     remove it
 *   proveIsolation(profile)       resolves to what the canary proved; rejects
 *                                 with a Refusal when the sandbox does not hold
 *   sandboxed(argv, profile)      true when the command ran to its end with
 *                                 status 0, in the copy
 *   readSource(file)              a file of the copy
 *   removeReport(path), readReport(path)   the report in the copy, or null
 *   recordVerdict(tree, verdict)
 *   gateHash, now(), vars         `vars` fills `${name}` in a command
 *
 * postcondition: 0 passed and recorded; 1 a check failed, a mutant is
 *                undetected, a file turns mutation off, or the report is
 *                missing. A Refusal (exit 2) leaves before a verdict: work
 *                that is not committed, a sandbox that does not hold, a file
 *                name the mutation tool would misread.
 */
export async function runGate(config, ports) {
  const { log } = ports;
  const dirty = ports.status();
  if (dirty !== "") {
    throw new Refusal(`the gate judges the committed tree, and this work is not committed:\n${dirty}`);
  }
  const tree = ports.headTree();
  const files = productionFiles(ports.changedFiles(config.base), config.mutation.production);
  const unsafe = unsafeNames(files);
  if (unsafe.length > 0) {
    throw new Refusal(`the mutation tool cannot be given these file names: ${unsafe.join(", ")}`);
  }

  ports.prepare();
  try {
    const profiles = [...new Set([...config.checks.map((check) => check.profile), config.mutation.profile])];
    for (const profile of profiles) {
      log(`[gate] sandbox ${profile}: ${await ports.proveIsolation(profile)}`);
    }

    for (const check of config.checks) {
      log(`[gate] ${check.name}: ${check.command.join(" ")}  (sandbox: ${check.profile})`);
      if (ports.sandboxed(fill(check.command, ports.vars), check.profile) !== true) {
        log(`[gate] FAILED: ${check.name}`);
        return 1;
      }
    }

    let judged = 0;
    if (files.length === 0) {
      log("[gate] mutation: the change touches no production line");
    } else {
      const blanket = files.flatMap((file) => blanketDisables(ports.readSource(file)).map((line) => `${file}:${line}`));
      if (blanket.length > 0) {
        log(`[gate] FAILED: mutation is turned off for more than one line at ${blanket.join(", ")}. Only \`// Stryker disable next-line <Mutator>: equivalent: <why>\` is accepted.`);
        return 1;
      }
      // The tool mutates the changed files whole; the verdict is on the
      // mutants that touch a changed line. A line filter given to the tool
      // would drop the mutants of an expression that starts above the line.
      ports.removeReport(config.mutation.report);
      const command = [...fill(config.mutation.command, ports.vars), "--mutate", files.join(",")];
      log(`[gate] mutation: ${command.join(" ")}  (sandbox: ${config.mutation.profile})`);
      const ran = ports.sandboxed(command, config.mutation.profile);
      const report = ports.readReport(config.mutation.report);
      if (ran !== true || report === null) {
        log("[gate] FAILED: mutation testing did not run to its report");
        return 1;
      }
      const changes = new Map(files.map((file) => [file, hunkRanges(ports.fileDiff(config.base, file))]));
      const verdict = judgeMutants(report, changes);
      judged = verdict.judged;
      for (const mutant of verdict.undetected) {
        log(`[gate] ${mutant.status}: ${mutant.file}:${mutant.line} ${mutant.mutator} -> ${mutant.replacement.split("\n")[0].slice(0, 80)}`);
      }
      if (verdict.undetected.length > 0) {
        log(
          `[gate] FAILED: mutation, ${verdict.undetected.length} of ${judged} mutant(s) on the changed lines undetected. ` +
            "Each needs a test that kills it, or, when no test can tell it from the original, " +
            "`// Stryker disable next-line <Mutator>: equivalent: <why>` on the line above.",
        );
        return 1;
      }
      log(`[gate] mutation: ${judged} mutant(s) on the changed lines, all detected`);
      // A changed file the report does not name has nothing the tool mutates
      // (types, re-exports), or was left out by the tool: it is said, so
      // that the second case is seen.
      const unreported = files.filter((file) => !Object.hasOwn(report.files, file));
      if (unreported.length > 0) log(`[gate] mutation: no mutant in ${unreported.join(", ")}`);
    }

    ports.recordVerdict(tree, {
      tree,
      passed: true,
      gate: ports.gateHash,
      at: ports.now(),
      checks: config.checks.map((check) => check.name),
      mutated_files: files,
      mutants_judged: judged,
    });
    log(`[gate] passed, recorded for tree ${tree}`);
    return 0;
  } finally {
    ports.dispose();
  }
}
