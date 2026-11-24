import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCompletionsUrl, ConfigError, PROVIDER_PRESETS, resolveConfig } from "../lib/config.mjs";

test("resolveConfig: gemini preset fills base URL and default model from GEMINI_API_KEY", () => {
  const config = resolveConfig({ provider: "gemini" }, { GEMINI_API_KEY: "g-key" });
  assert.equal(config.provider, "gemini");
  assert.equal(config.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai/");
  assert.equal(config.model, "gemini-2.0-flash");
  assert.equal(config.apiKey, "g-key");
});

test("resolveConfig: mistral preset fills base URL and default model from MISTRAL_API_KEY", () => {
  const config = resolveConfig({ provider: "mistral" }, { MISTRAL_API_KEY: "m-key" });
  assert.equal(config.baseUrl, "https://api.mistral.ai/v1/");
  assert.equal(config.model, "mistral-small-latest");
  assert.equal(config.apiKey, "m-key");
});

test("resolveConfig: explicit flags override provider preset", () => {
  const config = resolveConfig(
    { provider: "gemini", model: "gemini-custom" },
    { GEMINI_API_KEY: "env-key" },
  );
  assert.equal(config.model, "gemini-custom");
  assert.equal(config.apiKey, "env-key");
});

test("resolveConfig: EXTERNAL_JUDGE_* env vars work without a provider preset", () => {
  const config = resolveConfig(
    {},
    {
      EXTERNAL_JUDGE_BASE_URL: "https://example.com/v1/",
      EXTERNAL_JUDGE_MODEL: "custom-model",
      EXTERNAL_JUDGE_API_KEY: "raw-key",
      EXTERNAL_JUDGE_ALLOWED_ORIGINS: "https://example.com",
    },
  );
  assert.equal(config.baseUrl, "https://example.com/v1/");
  assert.equal(config.model, "custom-model");
  assert.equal(config.apiKey, "raw-key");
  assert.equal(chatCompletionsUrl(config).href, "https://example.com/v1/chat/completions");
});

test("resolveConfig: no credentials anywhere -> apiKey is empty string, never undefined", () => {
  const config = resolveConfig({ provider: "gemini" }, {});
  assert.equal(config.apiKey, "");
});

test("resolveConfig refuses a key passed in parsed flags without echoing it", () => {
  assert.throws(() => resolveConfig({ apiKey: "fixture-key-option" }, {}), {
    message: "Set the API key in the environment. The --api-key option is forbidden.",
  });
});

test("resolveConfig: unknown provider throws", () => {
  assert.throws(() => resolveConfig({ provider: "openai" }, {}), /Unknown --provider/);
  assert.throws(() => resolveConfig({ provider: "constructor" }, {}), /Unknown --provider/);
});

test("a preset key stays bound to its preset even with additional origins configured", () => {
  const env = { GEMINI_API_KEY: "preset-key", EXTERNAL_JUDGE_ALLOWED_ORIGINS: "https://custom.example" };
  const preset = resolveConfig({ provider: "gemini" }, env);
  assert.equal(chatCompletionsUrl(preset).origin, "https://generativelanguage.googleapis.com");
  const flags = { provider: "gemini", baseUrl: "https://custom.example/v1" };
  assert.throws(() => chatCompletionsUrl(resolveConfig(flags, env)), /origin is not authorized/);
  const custom = resolveConfig(flags, { ...env, EXTERNAL_JUDGE_API_KEY: "explicit-key" });
  assert.equal(custom.apiKey, "explicit-key");
  assert.equal(chatCompletionsUrl(custom).origin, "https://custom.example");
});

test("selecting a preset does not extend authorization for a generic key", () => {
  const flags = { provider: "gemini" };
  const env = { EXTERNAL_JUDGE_API_KEY: "generic-key", EXTERNAL_JUDGE_ALLOWED_ORIGINS: "https://custom.example" };
  assert.throws(() => chatCompletionsUrl(resolveConfig(flags, env)), /origin is not authorized/);
  const optedIn = { ...env, EXTERNAL_JUDGE_ALLOWED_ORIGINS: "https://generativelanguage.googleapis.com" };
  assert.equal(chatCompletionsUrl(resolveConfig(flags, optedIn)).origin, "https://generativelanguage.googleapis.com");
});

test("origins are canonicalized independently of the base path", () => {
  const config = resolveConfig({ baseUrl: "https://judge.example:443/v1//", model: "m" }, {
    EXTERNAL_JUDGE_ALLOWED_ORIGINS: " https://other.example ,\u00a0HTTPS://JUDGE.EXAMPLE/\u00a0",
  });
  assert.equal(chatCompletionsUrl(config).href, "https://judge.example/v1/chat/completions");
});

test("malformed and unsupported endpoint URLs receive fixed diagnostics without their values", () => {
  for (const value of ["http://[fixture", "ftp://judge.example", "ws://judge.example"]) {
    assert.throws(() => chatCompletionsUrl({ baseUrl: value, allowedOrigins: [value] }), {
      constructor: ConfigError, message: "Base URL must be an absolute HTTP(S) URL.",
    });
    assert.throws(() => resolveConfig({}, { EXTERNAL_JUDGE_ALLOWED_ORIGINS: value }), {
      constructor: ConfigError, message: "EXTERNAL_JUDGE_ALLOWED_ORIGINS entry must be an absolute HTTP(S) URL.",
    });
  }
});

test("origins exclude paths, credentials, queries, fragments and non-HTTP schemes", () => {
  for (const value of ["https://judge.example/v1", "https://user@judge.example", "https://judge.example?", "https://judge.example#", "file:///fixture"]) {
    assert.throws(() => resolveConfig({}, { EXTERNAL_JUDGE_ALLOWED_ORIGINS: value }), /EXTERNAL_JUDGE_ALLOWED_ORIGINS/);
  }
  for (const baseUrl of ["https://judge.example/v1?detail", "https://user@judge.example/v1", "https://judge.example/v1#detail"]) {
    assert.throws(() => chatCompletionsUrl({ baseUrl, allowedOrigins: ["https://judge.example"] }), /user information, a query or a fragment/);
  }
});

test("empty allowlists and missing authorization deny even a valid HTTPS URL", () => {
  for (const value of [undefined, "", " \t "]) {
    const flags = { baseUrl: "https://judge.example" };
    const config = resolveConfig(flags, { EXTERNAL_JUDGE_API_KEY: "generic-key", EXTERNAL_JUDGE_ALLOWED_ORIGINS: value });
    assert.deepEqual(config.allowedOrigins, []);
    assert.throws(() => chatCompletionsUrl(config), /origin is not authorized/);
  }
  assert.throws(() => chatCompletionsUrl({ baseUrl: "https://judge.example" }), /origin is not authorized/);
});

test("cleartext exception is limited to numeric loopback addresses", () => {
  for (const hostname of ["127.0.0.1", "127.1.2.3", "[::1]"]) {
    const origin = `http://${hostname}:8080`;
    assert.equal(chatCompletionsUrl({ baseUrl: origin, allowedOrigins: [origin] }).origin, origin);
  }
  for (const hostname of ["localhost", "127.example.invalid", "192.0.2.1", "[::ffff:127.0.0.1]"]) {
    const origin = `http://${hostname}:8080`;
    assert.throws(() => chatCompletionsUrl({ baseUrl: origin, allowedOrigins: [origin] }), /must use HTTPS/);
  }
});

test("resolveConfig: default timeout applies when unset or invalid", () => {
  assert.equal(resolveConfig({}, {}).timeoutMs, 30_000);
  assert.equal(resolveConfig({ timeoutMs: "not-a-number" }, {}).timeoutMs, 30_000);
  assert.equal(resolveConfig({ timeoutMs: "5000" }, {}).timeoutMs, 5000);
});

test("library authorization requires an array and exact canonical origin membership", () => {
  const baseUrl = "https://judge.example/api";
  const origin = new URL(baseUrl).origin;
  const rejected = { constructor: ConfigError, message: "Base URL origin is not authorized for the configured API key." };
  for (const allowedOrigins of [origin, null, 1, new Set([origin]), { includes: () => true }]) {
    assert.throws(() => chatCompletionsUrl({ baseUrl, allowedOrigins }), rejected);
  }
  for (const other of ["https://judge", origin + ".example", "https://sub.judge.example",
    "https://otherjudge.example", origin + ":8443", origin + "."]) {
    assert.throws(() => chatCompletionsUrl({ baseUrl, allowedOrigins: [other] }), rejected);
    assert.throws(() => chatCompletionsUrl({ baseUrl: other, allowedOrigins: [origin] }), rejected);
  }
});

test("preset selection requires a name and only obtains that preset's key", () => {
  const origin = "https://custom.example";
  for (const [name, envKey] of [["gemini", "GEMINI_API_KEY"], ["mistral", "MISTRAL_API_KEY"]]) {
    const env = { [envKey]: "fixture-secret", EXTERNAL_JUDGE_ALLOWED_ORIGINS: origin };
    assert.throws(() => resolveConfig({ provider: [name] }, env), ConfigError);
    for (const provider of [undefined, "custom", name === "gemini" ? "mistral" : "gemini"]) {
      assert.equal(resolveConfig({ provider, baseUrl: origin }, env).apiKey, "");
    }
    const bound = resolveConfig({ provider: name, baseUrl: origin }, env);
    assert.equal(bound.apiKey, "fixture-secret");
    assert.throws(() => chatCompletionsUrl(bound), /origin is not authorized/);
  }
});

test("a preset's own credential ignores the generic key's unused origin list", () => {
  const config = resolveConfig({ provider: "gemini" }, { GEMINI_API_KEY: "fixture", EXTERNAL_JUDGE_ALLOWED_ORIGINS: "invalid" });
  assert.equal(chatCompletionsUrl(config).origin, "https://generativelanguage.googleapis.com");
});

test("preset metadata distinguishes provider-enforced quota from the local Mistral throttle", () => {
  assert.match(PROVIDER_PRESETS.gemini.rateLimitNote, /provider-enforced quota/);
  assert.match(PROVIDER_PRESETS.mistral.rateLimitNote, /~2 req\/min.*enforced client-side/);
});

test("missing values use custom defaults and non-positive, infinite and blank timeout values are rejected", () => {
  assert.deepEqual(resolveConfig({}, {}), { provider: "custom", baseUrl: "", model: "", apiKey: "", allowedOrigins: [], timeoutMs: 30_000 });
  for (const timeoutMs of [0, -1, "Infinity", ""]) assert.equal(resolveConfig({ timeoutMs }, {}).timeoutMs, 30_000);
  assert.equal(resolveConfig({}, { EXTERNAL_JUDGE_TIMEOUT_MS: "123" }).timeoutMs, 123);
});
