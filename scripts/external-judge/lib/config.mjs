/**
 * Provider/config resolution for the external-judge OpenAI-compatible client.
 *
 * Concern: turn (env, flags) into a single resolved {baseUrl, model, apiKey,
 * provider, timeoutMs} object. Pure — no I/O, no fetch. Split out from
 * judge.mjs per coding-standards.md §5 (SRP: config resolution is a distinct
 * reason to change from HTTP dispatch or CLI parsing).
 *
 * Precondition: `flags` is a plain object of already-parsed CLI flags
 *   (--provider, --base-url, --model, --timeout-ms); `env` is a
 *   process.env-shaped object.
 * Postcondition: returns a fully-resolved Config; apiKey is "" (not
 *   undefined) when absent so callers can do a single falsy check.
 *
 * source (provider defaults):
 * - Gemini OpenAI-compatible endpoint + example model name:
 *   https://ai.google.dev/gemini-api/docs/openai (accessed 2026-07-15).
 *   Google documents the base URL as stable; the example model name
 *   ("gemini-flash" family) rotates with releases — override via --model
 *   or EXTERNAL_JUDGE_MODEL when Google ships a newer default.
 * - Mistral La Plateforme base URL + "-latest" model alias convention:
 *   https://docs.mistral.ai/getting-started/models/ (accessed 2026-07-15).
 * - Mistral Experiment (free) tier rate limit ~2 req/min: user-provided
 *   constraint for this task (no published SLA found at time of writing;
 *   treated as a hard operational limit, not a documented API guarantee).
 */

import { isIPv4 } from "node:net";

/** @typedef {"gemini"|"mistral"|"custom"} Provider */

/**
 * @typedef {object} Config
 * @property {Provider} provider
 * @property {string} baseUrl
 * @property {string} model
 * @property {string} apiKey
 * @property {string[]} allowedOrigins
 * @property {number} timeoutMs
 */

const PROVIDER_PRESETS = /** @type {const} */ ({
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    // source: https://ai.google.dev/gemini-api/docs/openai (accessed 2026-07-15) — example model.
    defaultModel: "gemini-2.0-flash",
    apiKeyEnv: "GEMINI_API_KEY",
    // source: task constraint — no published hard number found; treated as informational only.
    rateLimitNote: "free tier, provider-enforced quota (not locally rate-limited by this client)",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1/",
    // source: https://docs.mistral.ai/getting-started/models/ (accessed 2026-07-15) — "-latest" alias.
    defaultModel: "mistral-small-latest",
    apiKeyEnv: "MISTRAL_API_KEY",
    // source: user-provided constraint for this task (Mistral "Experiment" free tier).
    rateLimitNote: "~2 req/min — enforced client-side, see lib/backoff.mjs MIN_INTERVAL_MS",
  },
});

const DEFAULT_TIMEOUT_MS = 30_000; // source: measured — generous headroom over p99 chat-completion latency for small models.

export class ConfigError extends Error {}
export const API_KEY_FLAG_ERROR = "Set the API key in the environment. The --api-key option is forbidden.";

export function providerPreset(name) {
  return typeof name === "string" && Object.hasOwn(PROVIDER_PRESETS, name) ? PROVIDER_PRESETS[name] : undefined;
}

function parseEndpoint(value, label) {
  if (!URL.canParse(value)) throw new ConfigError(`${label} must be an absolute HTTP(S) URL.`);
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (url.href !== `${url.origin}${url.pathname}`) {
    throw new ConfigError(`${label} must not contain user information, a query or a fragment.`);
  }
  return url;
}

function readAllowedOrigins(value) {
  if (!value?.trim()) return [];
  return value.split(",").map((entry) => {
    const url = parseEndpoint(entry.trim(), "EXTERNAL_JUDGE_ALLOWED_ORIGINS entry");
    if (url.pathname !== "/") {
      throw new ConfigError("EXTERNAL_JUDGE_ALLOWED_ORIGINS entries must be origins without a path.");
    }
    return url.origin;
  });
}

/** Validate the exact destination used by fetch, including direct library calls. */
export function chatCompletionsUrl({ baseUrl, allowedOrigins }) {
  const url = parseEndpoint(baseUrl, "Base URL");
  // IPv4 127/8 (RFC 1122 §3.2.1.3) and IPv6 ::1 (RFC 4291 §2.5.3) need no DNS lookup.
  const loopback = url.hostname === "[::1]" || (isIPv4(url.hostname) && url.hostname.startsWith("127."));
  if (url.protocol === "http:" && !loopback) {
    throw new ConfigError("Base URL must use HTTPS except for numeric loopback addresses.");
  }
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.includes(url.origin)) {
    throw new ConfigError("Base URL origin is not authorized for the configured API key.");
  }
  const path = url.pathname;
  let end = path.length;
  while (path[end - 1] === "/") end--;
  url.pathname = `${path.slice(0, end)}/chat/completions`;
  return url;
}

/**
 * Resolve flags and environment before opening a connection.
 * Provider-specific environment keys are scoped to the matching preset origin.
 *
 * @param {{provider?: string, baseUrl?: string, model?: string, apiKey?: string, timeoutMs?: string|number}} flags
 * @param {Record<string, string|undefined>} env
 * @returns {Config}
 */
export function resolveConfig(flags, env) {
  if (Object.hasOwn(flags, "apiKey")) {
    throw new ConfigError(API_KEY_FLAG_ERROR);
  }
  const providerName = /** @type {Provider|undefined} */ (flags.provider);
  const preset = providerPreset(providerName);

  if (providerName !== undefined && providerName !== "custom" && !preset) {
    throw new ConfigError("Unknown --provider. Known providers are gemini, mistral and custom.");
  }

  const baseUrl = flags.baseUrl || preset?.baseUrl || env.EXTERNAL_JUDGE_BASE_URL || "";
  const model = flags.model || env.EXTERNAL_JUDGE_MODEL || preset?.defaultModel || "";
  const genericKey = env.EXTERNAL_JUDGE_API_KEY;
  const apiKey = genericKey || (preset ? env[preset.apiKeyEnv] : undefined) || "";
  const allowedOrigins = genericKey || !preset
    ? readAllowedOrigins(env.EXTERNAL_JUDGE_ALLOWED_ORIGINS) : [new URL(preset.baseUrl).origin];
  const timeoutMs = Number(flags.timeoutMs ?? env.EXTERNAL_JUDGE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  return {
    provider: providerName ?? "custom",
    baseUrl,
    model,
    apiKey,
    allowedOrigins,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

export { PROVIDER_PRESETS, DEFAULT_TIMEOUT_MS };
