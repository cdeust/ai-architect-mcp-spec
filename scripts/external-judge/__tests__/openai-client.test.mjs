import { test } from "node:test";
import assert from "node:assert/strict";
import { callChatCompletions } from "../lib/openai-client.mjs";
import { MAX_ATTEMPTS } from "../lib/backoff.mjs";

const allowedOrigins = ["https://x"];

// fetch is monkey-patched for test isolation only (§7.2 exception); every
// test restores the original in `finally`.

test("callChatCompletions: retries a 429 honoring Retry-After, then succeeds", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    return new Response(
      JSON.stringify({ model: "m", choices: [{ message: { content: '{"verdict":"PASS","rationale":"ok","confidence":0.9}' } }] }),
      { status: 200 },
    );
  };
  try {
    const config = { provider: "custom", baseUrl: "https://x/v1/", model: "m", apiKey: "secret-key", allowedOrigins, timeoutMs: 2000 };
    const { content } = await callChatCompletions(config, "prompt");
    assert.equal(calls, 2);
    assert.match(content, /PASS/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callChatCompletions: throws after exhausting retries on persistent 429, error never leaks the API key", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response("still limited", { status: 429, headers: { "retry-after": "0" } });
  };
  try {
    // provider "custom" deliberately, not "mistral" — MIN_INTERVAL_MS
    // throttling for mistral is exercised in the dedicated rate-limit test
    // below; using it here would make this test take 4 x 30s (MAX_ATTEMPTS
    // - 1 inter-request floors) for no additional coverage.
    const config = { provider: "custom", baseUrl: "https://x/v1/", model: "m", apiKey: "TOP-SECRET-KEY", allowedOrigins, timeoutMs: 2000 };
    await assert.rejects(callChatCompletions(config, "prompt"), (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, `callChatCompletions: rate limited (429) after ${MAX_ATTEMPTS} attempts`);
      assert.ok(!err.message.includes("TOP-SECRET-KEY"), "error message must not leak the API key");
      return true;
    });
    assert.equal(requests, MAX_ATTEMPTS);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callChatCompletions: throws a descriptive error on a non-2xx, non-429 response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad request detail", { status: 400 });
  try {
    const config = { provider: "custom", baseUrl: "https://x/v1/", model: "m", apiKey: "k", allowedOrigins, timeoutMs: 2000 };
    await assert.rejects(callChatCompletions(config, "prompt"), /HTTP 400/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callChatCompletions: throws when the response is missing choices[0].message.content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });
  try {
    const config = { provider: "custom", baseUrl: "https://x/v1/", model: "m", apiKey: "k", allowedOrigins, timeoutMs: 2000 };
    await assert.rejects(callChatCompletions(config, "prompt"), /missing choices/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("timeout remains active after headers until the response body is read", async (t) => {
  let reading = false;
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => ({
    ok: true, status: 200,
    json() {
      reading = true;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  }));
  const config = { provider: "custom", baseUrl: "https://x", allowedOrigins, model: "m", apiKey: "k", timeoutMs: 10 };
  await assert.rejects(callChatCompletions(config, "prompt"), { message: "callChatCompletions: request timed out after 10ms" });
  assert.equal(reading, true);
});

test("client returns only content even when the provider supplies model metadata", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ model: "provider", choices: [{ message: { content: "text" } }] }));
  assert.deepEqual(await callChatCompletions({ provider: "custom", baseUrl: "https://x", allowedOrigins,
    model: "m", apiKey: "k", timeoutMs: 1000 }, "prompt"), { content: "text" });
});

const fixture = { provider: "custom", baseUrl: "https://x/v1/", model: "m", apiKey: "k", allowedOrigins, timeoutMs: 2000 };
const success = () => Response.json({ choices: [{ message: { content: "ok" } }] });

test("post sends the configured model, prompt and headers to the validated URL, without following redirects", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => success());
  await callChatCompletions(fixture, "synthetic prompt");
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url.href, "https://x/v1/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  assert.deepEqual(init.headers, { "content-type": "application/json", authorization: "Bearer k" });
  assert.deepEqual(JSON.parse(init.body), { model: "m", temperature: 0, messages: [{ role: "user", content: "synthetic prompt" }] });
  assert.ok(init.signal instanceof AbortSignal);
});

test("HTTP error bodies are cancelled, and cancellation failure cannot expose remote diagnostics", async (t) => {
  const cancel = t.mock.fn(async () => { throw new Error("private"); });
  for (const body of [{ cancel }, null]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 403, body }));
    await assert.rejects(callChatCompletions(fixture, ""), { message: "callChatCompletions: HTTP 403" });
    fetch.mock.restore();
  }
  assert.equal(cancel.mock.callCount(), 1);
});

test("invalid JSON, a missing message and a transport rejection have distinct local diagnostics", async (t) => {
  for (const [respond, message] of [
    [() => new Response("private detail"), "response was not valid JSON"],
    ...[null, {}, { choices: [null] }, { choices: [{ message: null }] }].map(payload => [
      () => Response.json(payload), "response missing choices[0].message.content",
    ]),
    [() => { throw new Error("private detail"); }, "network error"],
  ]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => respond());
    await assert.rejects(callChatCompletions(fixture, ""), { message: "callChatCompletions: " + message });
    fetch.mock.restore();
  }
});

test("Mistral waits only for the remaining provider interval across requests", async (t) => {
  let now = 100_000;
  const waits = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (fn, ms) => {
    if (ms !== fixture.timeoutMs) { waits.push(ms); now += ms; queueMicrotask(fn); }
    return {};
  });
  t.mock.method(globalThis, "fetch", async () => success());
  const mistral = { ...fixture, provider: "mistral" };
  await callChatCompletions(mistral, "");
  now += 5000;
  await callChatCompletions(mistral, "");
  now += 30_000;
  await callChatCompletions(mistral, "");
  await callChatCompletions(fixture, "");
  assert.deepEqual(waits, [25_000]);
});

test("each retry respects Retry-After or the fallback and releases its request timer", async (t) => {
  const waits = [];
  const timers = [];
  const cleared = [];
  t.mock.method(globalThis, "setTimeout", (fn, ms) => {
    const timer = {};
    if (ms === fixture.timeoutMs + 1) timers.push(timer);
    else { waits.push(ms); queueMicrotask(fn); }
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", timer => { cleared.push(timer); });
  const responses = [
    new Response(null, { status: 429, headers: { "retry-after": "3" } }), new Response(null, { status: 429 }),
    new Response(null, { status: 429, headers: { "retry-after": "0" } }), success(),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  await callChatCompletions({ ...fixture, timeoutMs: fixture.timeoutMs + 1 }, "");
  assert.deepEqual(waits, [3000, 2000]);
  assert.equal(timers.length, 4);
  assert.deepEqual(cleared, timers);
});
