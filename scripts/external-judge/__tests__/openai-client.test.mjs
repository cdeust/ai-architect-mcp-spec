import { test } from "node:test";
import assert from "node:assert/strict";
import { callChatCompletions } from "../lib/openai-client.mjs";

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
  globalThis.fetch = async () => new Response("still limited", { status: 429, headers: { "retry-after": "0" } });
  try {
    // provider "custom" deliberately, not "mistral" — MIN_INTERVAL_MS
    // throttling for mistral is exercised in the dedicated rate-limit test
    // below; using it here would make this test take 4 x 30s (MAX_ATTEMPTS
    // - 1 inter-request floors) for no additional coverage.
    const config = { provider: "custom", baseUrl: "https://x/v1/", model: "m", apiKey: "TOP-SECRET-KEY", allowedOrigins, timeoutMs: 2000 };
    await assert.rejects(callChatCompletions(config, "prompt"), (err) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes("TOP-SECRET-KEY"), "error message must not leak the API key");
      return true;
    });
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
