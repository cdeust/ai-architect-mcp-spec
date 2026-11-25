import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFlags, writeCliError } from "../lib/cli.mjs";
import { API_KEY_FLAG_ERROR, ConfigError } from "../lib/config.mjs";

test("CLI accepts documented options in both forms and keeps the two entry points distinct", () => {
  assert.deepEqual({ ...parseFlags(["--base-url=url", "--model", "model=one", "--debug", "--provider=custom", "--timeout-ms", "12"]) },
    { baseUrl: "url", model: "model=one", debug: "true", provider: "custom", timeoutMs: "12" });
  assert.deepEqual({ ...parseFlags(["--min-agreement=0.8"], "calibrate") }, { minAgreement: "0.8" });
  for (const [arg, entry] of [["--min-agreement", "judge"], ["--debug", "calibrate"], ["--constructor", "judge"], ["-x", "judge"]]) {
    assert.throws(() => parseFlags([arg], entry), { constructor: ConfigError, message: "Unknown option." });
  }
  for (const option of ["--APIKEY", "--api_KEY", "--api-key", "--apiKey"]) {
    assert.throws(() => parseFlags([option + "=fixture"]), { constructor: ConfigError, message: API_KEY_FLAG_ERROR });
  }
});

test("CLI diagnostics print safe config messages and suppress unexpected error details", (t) => {
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });
  const writes = t.mock.method(process.stderr, "write", () => true);
  writeCliError("judge.mjs", new ConfigError("invalid Bearer fixture"));
  writeCliError("judge.mjs", new Error("fixture private detail"));
  assert.deepEqual(writes.mock.calls.map(call => call.arguments[0]), [
    "judge.mjs: invalid Bearer ***REDACTED***\n", "judge.mjs: unexpected failure\n",
  ]);
  assert.equal(process.exitCode, 2);
});

test("an option following a flag or a bare option terminator cannot hide an unknown argument", () => {
  for (const args of [["--debug", "-k", "fixture"], ["--"], ["stray"], ["xxmodel"], ["--api-key-extra"], ["--xapi-key"]]) {
    assert.throws(() => parseFlags(args), { constructor: ConfigError, message: "Unknown option." });
  }
  assert.equal(parseFlags(["--model=-one"]).model, "-one");
  assert.equal(parseFlags(["--debug"]).debug, "true");
});

test("a flag takes no value and an option requires one: a stray or missing argument is refused, never absorbed", () => {
  // A positional after --debug used to be swallowed and silently turn --debug off.
  for (const args of [["--debug", "stray"], ["--debug=false"], ["--debug=true"], ["--debug", "--model=m", "stray"]]) {
    assert.throws(() => parseFlags(args), { constructor: ConfigError, message: /^(Unknown option|Unexpected option value)\.$/ });
  }
  // A bare --model used to become the model "true"; every valued option needs its value.
  for (const option of ["--provider", "--base-url", "--model", "--timeout-ms"]) {
    for (const args of [[option], [option + "="], [option, "--debug"], [option, "-x"]]) {
      assert.throws(() => parseFlags(args), { constructor: ConfigError, message: "Option requires a value." });
    }
  }
  assert.throws(() => parseFlags(["--min-agreement"], "calibrate"), { constructor: ConfigError, message: "Option requires a value." });
  assert.deepEqual({ ...parseFlags(["--debug", "--model", "m", "--debug"]) }, { debug: "true", model: "m" });
});

test("diagnostics for a stray argument or a missing value never repeat the value", () => {
  for (const args of [["--debug", "SECRET-ARG"], ["--debug=SECRET-ARG"], ["--model", "--debug=SECRET-ARG"], ["--min-agreement=SECRET-ARG"]]) {
    for (const entry of ["judge", "calibrate"]) {
      try {
        parseFlags(args, entry);
      } catch (error) {
        assert.ok(error instanceof ConfigError);
        assert.ok(!error.message.includes("SECRET-ARG"));
      }
    }
  }
});

test("--min-agreement accepts only a ratio from 0 to 1, because it sets the admission gate", () => {
  for (const value of ["0", "0.7", "1", "1.0", ".5", "0.", "00.5"]) {
    assert.equal(parseFlags([`--min-agreement=${value}`], "calibrate").minAgreement, value);
  }
  for (const value of ["", " ", "abc", "-1", "+0.5", "1.01", "2", "1e0", "0x1", "Infinity", "NaN", "0.5 ", "1.5.2"]) {
    assert.throws(() => parseFlags([`--min-agreement=${value}`], "calibrate"), { constructor: ConfigError });
  }
  assert.throws(() => parseFlags(["--min-agreement=2"], "calibrate"),
    { constructor: ConfigError, message: "Option --min-agreement must be a number from 0 to 1." });
});
