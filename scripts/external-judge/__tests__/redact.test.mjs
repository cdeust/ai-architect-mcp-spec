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

test("redact: masks the endpoint field without a separate config", () => {
  assert.deepEqual(redact({ baseUrl: "https://judge.example/private/", model: "fixture-model" }), {
    baseUrl: "***REDACTED***",
    model: "fixture-model",
  });
});

test("redact: masks the literal of a malformed endpoint", () => {
  const baseUrl = "http://[fixture";
  assert.equal(redact(`Request to ${baseUrl}`, { baseUrl }), "Request to ***REDACTED***");
});

test("redact: masks the canonical origin when the diagnostic omits the path", () => {
  const baseUrl = "https://JUDGE.example:443/private/";
  assert.equal(redact("Request to https://judge.example", { baseUrl }), "Request to ***REDACTED***");
});

test("redact: preserves ordinary null text beside an opaque endpoint", () => {
  const baseUrl = "about:blank";
  assert.equal(redact(`Null result: null at ${baseUrl}`, { baseUrl }), "Null result: null at ***REDACTED***");
});

test("redact: consumes the full endpoint when a credential is its prefix", () => {
  const apiKey = "https://judge.example";
  const baseUrl = `${apiKey}/private/`;
  const text = `Request to ${baseUrl} with credential ${apiKey}`;
  assert.equal(redact(text, { apiKey, baseUrl }), "Request to ***REDACTED*** with credential ***REDACTED***");
});

test("redact: matches scheme and authority without case, preserves case in paths and keys", () => {
  const context = { baseUrl: "https://Judge.EXAMPLE:443/Tenant/v1/", apiKey: "Secret+/=:@" };
  const hidden = "***REDACTED***";
  for (const baseUrl of [context.baseUrl, context.baseUrl.slice(0, -1)]) {
    for (const host of ["HTTPS://jUdGe.eXaMpLe:443", "hTtPs://JUDGE.ExAmPlE"]) {
      assert.equal(redact(`${host}/Tenant/v1 / ${host}/Tenant/v1/`, { ...context, baseUrl }), `${hidden} / ${hidden}`);
    }
  }
  assert.equal(redact("SECRET+/=:@ Secret%2B%2F%3D%3A%40", context), `SECRET+/=:@ ${hidden}`);
  assert.equal(redact("https://judge.example/tenant/v1", context), `${hidden}tenant/v1`);
  assert.equal(redact("https://judge.example/", { baseUrl: "https://judge.example" }), hidden);
});

test("redact: sensitive snake_case fields are private without configuration", () => {
  assert.deepEqual(redact({ BASE_URL: "one", allowed_origins: ["two"] }),
    { BASE_URL: "***REDACTED***", allowed_origins: "***REDACTED***" });
});

test("redact: repeated trailing slashes and shared key prefixes preserve the longest complete literal", () => {
  const baseUrl = "http://j.example/Path///";
  const apiKey = "http://j.example/PathKey";
  for (const text of [baseUrl, "HTTP://J.EXAMPLE/Path", "HTTP://J.EXAMPLE/Path/", apiKey]) {
    assert.equal(redact(text, { apiKey, baseUrl }), "***REDACTED***");
  }
});

test("redact: literal regex punctuation has no wildcard meaning in either the key or the endpoint", () => {
  const baseUrl = "https://[::1]:8443/tenant.$+/";
  assert.equal(redact("https://[::1]:8443/tenant.$+/", { baseUrl }), "***REDACTED***");
  assert.equal(redact("x fooQaBar foo.aBar y", { apiKey: "foo.aBar" }), "x fooQaBar ***REDACTED*** y");
  assert.equal(redact("bearer token BEARER other ordinary", {}), "Bearer ***REDACTED*** Bearer ***REDACTED*** ordinary");
});

test("unvalidated non-HTTP endpoint literals survive parsing as a whole secret", () => {
  for (const baseUrl of ["ftp://files.example/private", "blob:https://judge.example/fixture"]) {
    assert.equal(redact("unvalidated " + baseUrl, { baseUrl }), "unvalidated ***REDACTED***");
  }
});

test("redact: recognizes case variants of a raw internationalized host and its ASCII serialization", () => {
  const baseUrl = "https://éCole.example/Privé/";
  for (const text of ["HTTPS://ÉCOLE.EXAMPLE/Privé", new URL(baseUrl).href]) {
    assert.equal(redact(text, { baseUrl }), "***REDACTED***");
  }
});

test("redact: a percent-encoded credential is masked in either hex case, per character, and as form encoding", () => {
  const apiKey = "sk-sec+ret/val=123:abc@xyz é";
  const encoded = encodeURIComponent(apiKey);
  assert.notEqual(encoded, encoded.toLowerCase());
  const forms = [
    encoded, encoded.toLowerCase(), encoded.replace(/%[0-9A-F]{2}/g, (m, i) => i % 2 ? m.toLowerCase() : m),
    "sk-sec%2bret%2fval%3d123%3aabc%40xyz+%c3%a9", "%73k-sec%2Bret/val=123:abc@xyz é", "sk-sec+ret/val=123:abc@xyz+é",
  ];
  for (const form of forms) assert.equal(redact(`k=${form};`, { apiKey }), "k=***REDACTED***;", form);
  // Only the credential's own characters are folded: a different key is not masked.
  assert.equal(redact("sk-sec%2bret%2fval%3d123%3aabc%40xyz2", { apiKey: "sk-sec+ret/val=123:abc@xyz" }), "***REDACTED***2");
  assert.equal(redact("sk-sec%2bret", { apiKey: "sk-sec+ret/val" }), "sk-sec%2bret");
});

test("redact: an origin is masked with its default port written or omitted, and other ports stay exact", () => {
  const hidden = "***REDACTED***";
  for (const [scheme, port] of [["https", 443], ["http", 80]]) {
    const origin = `${scheme}://judge.example`;
    for (const baseUrl of [`${origin}/v1/`, `${origin}:${port}/v1/`, `${origin}:${port}`, origin, origin.toUpperCase() + `:${port}/v1`]) {
      const texts = [origin, `${origin}:${port}`, `${origin}:0${port}`];
      if (baseUrl.includes("/v1")) texts.push(`${origin}/v1`, `${origin}:${port}/v1/`);
      for (const text of texts) assert.equal(redact(text, { baseUrl }), hidden, `${baseUrl} / ${text}`);
      // A different port is a different origin: only the host part is masked and the port stays visible.
      assert.equal(redact(`${origin}:${port}0`, { baseUrl }), `${hidden}:${port}0`);
    }
  }
  const explicit = { baseUrl: "https://judge.example:8443/v1" };
  assert.equal(redact("https://judge.example:8443/v1 https://judge.example:8443", explicit), `${hidden} ${hidden}`);
  assert.equal(redact("https://judge.example:443", explicit), "https://judge.example:443");
  assert.equal(redact("https://[::1]:443/ https://[::1]", { baseUrl: "https://[::1]/" }), `${hidden} ${hidden}`);
});
