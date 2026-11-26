import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../lib/config.mjs";
import { runJudge } from "../lib/judge-core.mjs";

const key = "fixture-judge-credential";
const prompt = "Synthetic claim for contract testing";
const marker = "***REDACTED***";
const scripts = {
  judge: fileURLToPath(new URL("../judge.mjs", import.meta.url)),
  calibrate: fileURLToPath(new URL("../calibrate.mjs", import.meta.url)),
};

function cli(script, args, extraEnv = {}, input = prompt) {
  const env = {
    PATH: process.env.PATH,
    ...(process.env.__STRYKER_ACTIVE_MUTANT__ && { __STRYKER_ACTIVE_MUTANT__: process.env.__STRYKER_ACTIVE_MUTANT__ }),
    EXTERNAL_JUDGE_API_KEY: key,
    EXTERNAL_JUDGE_MODEL: "fixture-model",
    ...extraEnv,
  };
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [scripts[script], ...args], { env, timeout: 5000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(input);
  });
}

async function endpoint(t, respond) {
  const received = [];
  let connections = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    respond(req, res);
  });
  server.on("connection", () => { connections++; });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, baseUrl: `${origin}/v1/`, received, connections: () => connections };
}

function sendVerdict(res, rationale = "The synthetic claim is consistent.") {
  const content = JSON.stringify({ verdict: "PASS", rationale, confidence: 0.9 });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
}

test("SEC-029: both CLIs refuse separated and equals-form key options", async (t) => {
  const server = await endpoint(t, (_req, res) => sendVerdict(res));
  for (const script of Object.keys(scripts)) {
    for (const keyOption of [["--api-key", key], [`--apiKey=${key}`], [`--api_key=${key}`], ["--api-key"]]) {
      const output = await cli(script, ["--base-url", server.baseUrl, ...keyOption], {
        EXTERNAL_JUDGE_ALLOWED_ORIGINS: server.origin,
      });
      assert.equal(output.code, 2);
      assert.equal(output.stdout, "");
      assert.match(output.stderr, /API key.*environment/i);
      assert.ok(!output.stderr.includes(key));
    }
  }
  assert.equal(server.received.length, 0);
});

test("SEC-031: refuses cleartext for a non-loopback hostname before the transport", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("fixture", { status: 400 }));
  const config = resolveConfig({ baseUrl: "http://judge.example.invalid/v1", model: "fixture" }, {
    EXTERNAL_JUDGE_API_KEY: key,
    EXTERNAL_JUDGE_ALLOWED_ORIGINS: "http://judge.example.invalid",
  });
  const result = await runJudge(config, prompt);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(result.status, "error");
  assert.match(result.reason, /HTTPS.*loopback/);
});

test("SEC-028: a different port on loopback has a separate, unauthorized origin", async (t) => {
  const authorized = await endpoint(t, (_req, res) => sendVerdict(res));
  const unauthorized = await endpoint(t, (_req, res) => sendVerdict(res));
  const output = await cli("judge", ["--base-url", unauthorized.baseUrl], {
    EXTERNAL_JUDGE_ALLOWED_ORIGINS: authorized.origin,
  });
  assert.equal(unauthorized.received.length, 0);
  assert.equal(authorized.received.length, 0);
  assert.equal(output.code, 0);
  const result = JSON.parse(output.stdout);
  assert.equal(result.status, "error");
  assert.match(result.reason, /origin is not authorized/);
});

test("SEC-028/031: an authorized origin cannot redirect a request to another endpoint", async (t) => {
  const target = await endpoint(t, (_req, res) => sendVerdict(res));
  const source = await endpoint(t, (_req, res) => {
    res.writeHead(307, { Location: `${target.baseUrl}chat/completions` });
    res.end();
  });
  const output = await cli("judge", ["--base-url", source.baseUrl], {
    EXTERNAL_JUDGE_ALLOWED_ORIGINS: source.origin,
  });
  assert.equal(source.received.length, 1);
  assert.equal(target.received.length, 0);
  assert.equal(output.code, 0);
  assert.match(JSON.parse(output.stdout).reason, /HTTP 307/);
});

test("SEC-030: provider errors expose status on stdout and debug, without payload or config secrets", async (t) => {
  const detail = "fixture-provider-diagnostic";
  const server = await endpoint(t, (_req, res) => {
    res.writeHead(400);
    res.end(`${detail} ${key} ${server.baseUrl}`);
  });
  const output = await cli("judge", ["--base-url", server.baseUrl, "--debug"], {
    EXTERNAL_JUDGE_ALLOWED_ORIGINS: server.origin,
  });
  const result = JSON.parse(output.stdout);
  assert.equal(server.received.length, 1);
  assert.equal(output.code, 0);
  assert.equal(result.status, "error");
  assert.match(result.reason, /HTTP 400/);
  assert.match(output.stderr, /HTTP 400/);
  assert.ok(output.stderr.includes(marker));
  for (const secret of [key, server.origin, detail]) {
    assert.ok(!output.stdout.includes(secret), "result contains private diagnostic data");
    assert.ok(!output.stderr.includes(secret), "debug contains private diagnostic data");
  }
});

test("authorized numeric loopback preserves the request and successful verdict", async (t) => {
  const server = await endpoint(t, (_req, res) => sendVerdict(res));
  const output = await cli("judge", ["--base-url", server.baseUrl], {
    EXTERNAL_JUDGE_ALLOWED_ORIGINS: server.origin,
  });
  assert.equal(output.code, 0);
  assert.equal(output.stderr, "");
  assert.equal(server.received.length, 1);
  assert.deepEqual(server.received[0], {
    path: "/v1/chat/completions",
    authorization: `Bearer ${key}`,
    body: { model: "fixture-model", temperature: 0, messages: [{ role: "user", content: prompt }] },
  });
  const result = JSON.parse(output.stdout);
  assert.equal(result.status, "ok");
  assert.equal(result.verdict.verdict, "PASS");
  assert.equal(result.verdict.rationale, "The synthetic claim is consistent.");
});

test("successful provider text is also masked before the host sees it", async (t) => {
  const server = await endpoint(t, (_req, res) => sendVerdict(res, `Reference ${server.baseUrl} and value ${key}`));
  const output = await cli("judge", ["--base-url", server.baseUrl], {
    EXTERNAL_JUDGE_ALLOWED_ORIGINS: server.origin,
  });
  assert.equal(output.code, 0);
  const result = JSON.parse(output.stdout);
  assert.equal(result.status, "ok");
  assert.equal(result.verdict.rationale, `Reference ${marker} and value ${marker}`);
});

test("calibration reports rejected requests as errors and never prints provider diagnostics", async (t) => {
  const server = await endpoint(t, (_req, res) => {
    res.writeHead(400);
    res.end(`Fixture detail ${server.baseUrl} ${key}`);
  });
  const output = await cli("calibrate", ["--base-url", server.baseUrl], {
    EXTERNAL_JUDGE_ALLOWED_ORIGINS: server.origin,
  });
  assert.ok(server.received.length > 0);
  assert.equal(output.code, 1);
  assert.equal(output.stderr, "");
  assert.match(output.stdout, /HTTP 400/);
  assert.match(output.stdout, /Admission gate: FAIL/);
  assert.doesNotMatch(output.stdout, /Nothing to calibrate|Fixture detail/);
  assert.ok(!output.stdout.includes(key));
  assert.ok(!output.stdout.includes(server.origin));
});

test("unknown options on both CLIs fail before transport with a fixed diagnostic", async () => {
  for (const script of Object.keys(scripts)) {
    for (const args of [[`--unknown-${key}=${key}`], ["--unknown", key], ["-x"]]) {
      assert.deepEqual(await cli(script, args), { code: 2, stdout: "", stderr: `${script}.mjs: Unknown option.\n` });
    }
  }
});

test("a stray argument or a missing option value exits 2 on both CLIs without reaching the network or echoing it", async (t) => {
  const server = await endpoint(t, (req, res) => res.end("{}"));
  const base = ["--base-url", server.origin];
  const cases = [
    ["judge", [...base, "--debug", `STRAY-${key}`], "Unknown option."],
    ["judge", [...base, `--debug=${key}`], "Unexpected option value."],
    ["judge", [...base, "--model"], "Option requires a value."],
    ["calibrate", [...base, "--timeout-ms"], "Option requires a value."],
    ["calibrate", [...base, "--min-agreement", "2"], "Option --min-agreement must be a number from 0 to 1."],
    ["calibrate", [...base, `--min-agreement=${key}`], "Option --min-agreement must be a number from 0 to 1."],
  ];
  for (const [script, args, message] of cases) {
    assert.deepEqual(await cli(script, args), { code: 2, stdout: "", stderr: `${script}.mjs: ${message}\n` });
  }
  assert.equal(server.connections(), 0);
});

test("judge empty-input and calibration output mask literals from their configuration", async () => {
  const empty = await cli("judge", [], { EXTERNAL_JUDGE_API_KEY: "prompt" }, " \t");
  assert.deepEqual(empty, { code: 2, stdout: "",
    stderr: "judge.mjs: empty ***REDACTED*** (pass the ***REDACTED*** as `judge.mjs … < ***REDACTED***.txt`)\n" });
  const report = await cli("calibrate", ["--base-url", "gemini", "--provider", "gemini"], { EXTERNAL_JUDGE_API_KEY: "" });
  assert.equal(report.code, 0);
  assert.ok(report.stdout.includes('provider "***REDACTED***"'));
  const failed = await cli("calibrate", [], { EXTERNAL_JUDGE_API_KEY: "agreement" });
  assert.equal(failed.code, 1);
  assert.doesNotMatch(failed.stdout, /agreement/);
  assert.match(failed.stdout, /\*\*\*REDACTED\*\*\* rate/);
});

test("200 verdict masks mixed-case endpoint, slashless tenant path and URL-encoded credential", async (t) => {
  const credential = "fixture secret+/=";
  const server = await endpoint(t, (_req, res) => sendVerdict(res,
    `${server.origin.toUpperCase()}/Tenant/v1 and ${encodeURIComponent(credential)}`));
  const output = await cli("judge", ["--base-url", server.origin + "/Tenant/v1/"], {
    EXTERNAL_JUDGE_API_KEY: credential, EXTERNAL_JUDGE_ALLOWED_ORIGINS: server.origin,
  });
  assert.equal(server.received.length, 1);
  assert.equal(output.code, 0);
  assert.equal(JSON.parse(output.stdout).verdict.rationale, `${marker} and ${marker}`);
});

test("judge terminates a real loopback response stalled after its headers", async (t) => {
  const server = await endpoint(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
  });
  const output = await cli("judge", ["--base-url", server.baseUrl, "--timeout-ms=500"], {
    EXTERNAL_JUDGE_ALLOWED_ORIGINS: server.origin,
  });
  assert.equal(server.received.length, 1);
  assert.equal(output.code, 0);
  assert.deepEqual(JSON.parse(output.stdout), { status: "error", reason: "callChatCompletions: request timed out after 500ms" });
});

test("custom providers never use either preset credential, including an environment-selected endpoint", async (t) => {
  const server = await endpoint(t, (_req, res) => sendVerdict(res));
  for (const presetKey of ["GEMINI_API_KEY", "MISTRAL_API_KEY"]) {
    for (const args of [["--provider", "custom", "--base-url", server.baseUrl], []]) {
      const output = await cli("judge", args, { [presetKey]: key, EXTERNAL_JUDGE_API_KEY: "",
        EXTERNAL_JUDGE_BASE_URL: server.baseUrl, EXTERNAL_JUDGE_ALLOWED_ORIGINS: server.origin });
      assert.equal(output.code, 0);
      assert.equal(JSON.parse(output.stdout).status, "skipped");
      assert.equal(server.connections(), 0);
      assert.equal(server.received.length, 0);
    }
  }
});

test("an authorized prefix of the destination port grants no access", async (t) => {
  const server = await endpoint(t, (_req, res) => sendVerdict(res));
  const output = await cli("judge", ["--base-url", server.baseUrl], { EXTERNAL_JUDGE_ALLOWED_ORIGINS: server.origin.slice(0, -1) });
  assert.equal(JSON.parse(output.stdout).status, "error");
  assert.match(JSON.parse(output.stdout).reason, /origin is not authorized/);
  assert.equal(server.connections(), 0);
});

test("debug success prints the scrubbed configuration and a single newline-terminated verdict", async (t) => {
  const server = await endpoint(t, (_req, res) => sendVerdict(res));
  const output = await cli("judge", ["--debug", "--base-url", server.baseUrl], { EXTERNAL_JUDGE_ALLOWED_ORIGINS: server.origin });
  const config = { provider: "custom", baseUrl: marker, model: "fixture-model", apiKey: marker, allowedOrigins: marker, timeoutMs: 30000 };
  const diagnostic = /^judge\.mjs debug config: (.+)\n$/.exec(output.stderr);
  assert.ok(diagnostic);
  assert.deepEqual(JSON.parse(diagnostic[1]), config);
  assert.equal(output.code, 0);
  assert.equal(JSON.parse(output.stdout).status, "ok");
  assert.equal(output.stdout, JSON.stringify(JSON.parse(output.stdout)) + "\n");
});
