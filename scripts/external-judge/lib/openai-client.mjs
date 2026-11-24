/**
 * Minimal OpenAI-compatible chat.completions client — native fetch only,
 * zero npm dependencies (task constraint).
 *
 * Precondition: `config.baseUrl` and `config.model` are non-empty;
 * `config.apiKey` is non-empty (callers must check for "no credentials"
 * before invoking this — see judge-core.mjs `runJudge`, which is the only
 * caller and owns that branch, keeping this module I/O-only per §5 SRP).
 * Postcondition: on success, returns the first choice's message content as
 * a string. On a persistent 429, retries with `computeBackoffDelayMs` up to
 * `MAX_ATTEMPTS` (backoff.mjs), honoring the server's `Retry-After` header
 * when present. On timeout, aborts the request and throws.
 *
 * Errors carry locally generated diagnostics. HTTP error bodies, redirect
 * locations and network exception messages never become diagnostics.
 */

import { computeBackoffDelayMs, MAX_ATTEMPTS, MIN_INTERVAL_MS } from "./backoff.mjs";
import { chatCompletionsUrl } from "./config.mjs";
import { redact } from "./redact.mjs";

const TEMPERATURE = 0; // deterministic verdicts — source: task requirement "temperature 0"

/** @type {Map<string, number>} last request timestamp per provider, module-level throttle state */
const lastRequestAt = new Map();

async function sleep(ms) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Client-side proactive throttle — waits out any remaining floor interval
 * for this provider before sending, independent of 429s. Required for
 * Mistral's ~2 req/min free-tier ceiling (config.mjs source note).
 *
 * @param {string} provider
 */
async function respectMinInterval(provider) {
  const floor = MIN_INTERVAL_MS[provider] ?? 0;
  if (floor <= 0) return;
  const last = lastRequestAt.get(provider);
  if (last !== undefined) {
    const elapsed = Date.now() - last;
    if (elapsed < floor) {
      await sleep(floor - elapsed);
    }
  }
  lastRequestAt.set(provider, Date.now());
}

/**
 * @param {import("./config.mjs").Config} config
 * @param {string} promptText
 * @returns {Promise<{content: string, httpModel: string}>}
 */
export async function callChatCompletions(config, promptText) {
  const url = chatCompletionsUrl(config);
  const body = JSON.stringify({
    model: config.model,
    temperature: TEMPERATURE,
    messages: [{ role: "user", content: promptText }],
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await respectMinInterval(config.provider);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`callChatCompletions: request timed out after ${config.timeoutMs}ms`);
      }
      throw new Error("callChatCompletions: network error");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) await response.body?.cancel().catch(() => {});

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after") ?? undefined;
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`callChatCompletions: rate limited (429) after ${MAX_ATTEMPTS} attempts`);
      }
      await sleep(computeBackoffDelayMs(attempt, retryAfter));
      continue;
    }

    if (!response.ok) {
      throw new Error(`callChatCompletions: HTTP ${response.status}`);
    }

    const json = await response.json().catch(() => {
      throw new Error("callChatCompletions: response was not valid JSON");
    });
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("callChatCompletions: response missing choices[0].message.content");
    }
    const httpModel = typeof json?.model === "string" ? json.model : config.model;
    return { content, httpModel: redact(httpModel, config) };
  }
  // Unreachable — loop always returns or throws — but keep TS/JSDoc happy.
  throw new Error("callChatCompletions: exhausted retries without a terminal response");
}
