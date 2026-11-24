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

function cli(script, args, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
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
    child.stdin.end(prompt);
  });
}

async function endpoint(t, respond) {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    respond(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, baseUrl: `${origin}/v1/`, received };
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
