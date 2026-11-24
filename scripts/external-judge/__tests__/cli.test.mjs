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
  for (const args of [["--debug", "-k", "fixture"], ["--"], ["stray"], ["--api-key-extra"], ["--xapi-key"]]) {
    assert.throws(() => parseFlags(args), { constructor: ConfigError, message: "Unknown option." });
  }
  assert.equal(parseFlags(["--model=-one"]).model, "-one");
});
