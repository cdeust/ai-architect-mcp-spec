import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../lib/redact.mjs";

test("redact: masks an apiKey field", () => {
  const out = redact({ apiKey: "sk-super-secret", model: "gemini-2.0-flash" });
  assert.equal(out.apiKey, "***REDACTED***");
  assert.equal(out.model, "gemini-2.0-flash");
});

test("redact: masks an authorization header value regardless of case", () => {
  const out = redact({ headers: { Authorization: "Bearer sk-secret", "content-type": "application/json" } });
  assert.equal(out.headers.Authorization, "***REDACTED***");
  assert.equal(out.headers["content-type"], "application/json");
});

test("redact: masks a Bearer token embedded in a plain string", () => {
  const out = redact("Request Authorization: Bearer \t sk-abc123 with a token");
  assert.equal(out, "Request Authorization: Bearer ***REDACTED*** with a token");
});

test("redact: recurses into nested objects and arrays without mutating the original", () => {
  const original = { config: { apiKey: "secret", nested: [{ api_key: "also-secret" }] } };
  const clone = JSON.parse(JSON.stringify(original));
  const out = redact(original);
  assert.equal(out.config.apiKey, "***REDACTED***");
  assert.equal(out.config.nested[0].api_key, "***REDACTED***");
  assert.deepEqual(original, clone, "redact must not mutate its input");
});

test("redact: leaves non-sensitive primitives untouched", () => {
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
  assert.equal(redact(true), true);
});

test("redact: treats keys as literal text and masks canonical URL forms", () => {
  const apiKey = "fixture.$[key]";
  const baseUrl = "https://JUDGE.example:443/private/";
  const canonical = "https://judge.example/private/";
  const value = { baseUrl, allowedOrigins: ["https://judge.example"], nested: [`key=${apiKey} endpoint=${canonical}`] };
  assert.deepEqual(redact(value, { apiKey, baseUrl }), {
    baseUrl: "***REDACTED***",
    allowedOrigins: "***REDACTED***",
    nested: ["key=***REDACTED*** endpoint=***REDACTED***"],
  });
});
