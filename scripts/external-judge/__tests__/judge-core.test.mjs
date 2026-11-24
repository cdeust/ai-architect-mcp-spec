import { test } from "node:test";
import assert from "node:assert/strict";
import { runJudge } from "../lib/judge-core.mjs";

const allowedOrigins = ["https://x"];

/**
 * fetch is monkey-patched here strictly for test isolation (mocking network
 * I/O without a real request) — the one justified exception documented in
 * coding-standards.md §7.2 ("Test teardown only"). Every test restores the
 * original fetch in a `finally` so no state leaks between tests (§7.2's
 * override condition).
 */

test("runJudge: no apiKey -> status skipped, never calls fetch", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("fetch should not have been called");
  };
  try {
    const result = await runJudge(
      { provider: "gemini", baseUrl: "https://x/", model: "m", apiKey: "", timeoutMs: 1000 },
      "prompt text",
    );
    assert.equal(result.status, "skipped");
    assert.match(result.reason, /no credentials/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runJudge: success path returns ok with parsed verdict, model, provider, latency_ms", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        model: "gemini-2.0-flash",
        choices: [
          {
            message: {
              content: '{"verdict":"PASS","rationale":"looks fine","caveats":[],"confidence":0.9}',
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const result = await runJudge(
      { provider: "gemini", baseUrl: "https://x/v1/", model: "gemini-2.0-flash", apiKey: "k", allowedOrigins, timeoutMs: 5000 },
      "prompt text",
    );
    assert.equal(result.status, "ok");
    assert.equal(result.verdict.verdict, "PASS");
    assert.equal(result.model, "gemini-2.0-flash");
    assert.equal(result.provider, "gemini");
    assert.equal(typeof result.latency_ms, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runJudge: never fabricates a verdict on network error — returns status error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("simulated network failure");
  };
  try {
    const result = await runJudge(
      { provider: "mistral", baseUrl: "https://x/v1/", model: "mistral-small-latest", apiKey: "fixture-key", allowedOrigins, timeoutMs: 1000 },
      "prompt text",
    );
    assert.equal(result.status, "error");
    assert.ok(!("verdict" in result));
    assert.match(result.reason, /network error/);
    assert.doesNotMatch(result.reason, /simulated network failure/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runJudge: never fabricates a verdict when the model reply has no parseable JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "I cannot comply with JSON-only output." } }] }),
      { status: 200 },
    );
  try {
    const result = await runJudge(
      { provider: "gemini", baseUrl: "https://x/v1/", model: "m", apiKey: "k", allowedOrigins, timeoutMs: 1000 },
      "prompt text",
    );
    assert.equal(result.status, "error");
    assert.ok(!("verdict" in result));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runJudge: a batched reply (issue #119) returns every verdict with its claim_id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        model: "gemini-2.0-flash",
        choices: [
          {
            message: {
              content:
                '[{"claim_id":"FR-001","verdict":"PASS","rationale":"a","caveats":[],"confidence":0.9},' +
                '{"claim_id":"FR-002","verdict":"NEEDS-RUNTIME","rationale":"b","caveats":[],"confidence":0.6}]',
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const result = await runJudge(
      { provider: "gemini", baseUrl: "https://x/v1/", model: "gemini-2.0-flash", apiKey: "k", allowedOrigins, timeoutMs: 5000 },
      "prompt text",
    );
    assert.equal(result.status, "ok");
    assert.equal(result.verdict, undefined);
    assert.deepEqual(result.verdicts.map((v) => [v.claim_id, v.verdict]), [["FR-001", "PASS"], ["FR-002", "NEEDS-RUNTIME"]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
