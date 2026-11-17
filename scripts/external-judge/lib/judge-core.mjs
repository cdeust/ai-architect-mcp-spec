/**
 * `runJudge` — the single entry point both judge.mjs (CLI) and
 * calibrate.mjs (harness) call. Owns the "no credentials → skip, never
 * fabricate" contract.
 *
 * Precondition: `config` is a resolved Config (lib/config.mjs); `promptText`
 * is the full judge prompt (self-contained, no external context needed).
 * Postcondition: returns exactly one of:
 *   - {status:"skipped", reason}      — no apiKey; NEVER calls the network.
 *   - {status:"ok", verdict, model, provider, latency_ms}
 *   - {status:"error", reason}        — network/parse/timeout failure.
 * Invariant: a "skipped" or "error" result never carries a `verdict` field —
 * callers must not synthesize a fallback verdict from an absent one (that
 * would be exactly the "fabricated verdict" this module exists to prevent).
 */

import { callChatCompletions } from "./openai-client.mjs";
import { extractVerdicts } from "./verdict-extract.mjs";

/**
 * @typedef {{status: "skipped", reason: string}} SkippedResult
 * @typedef {{status: "ok", model: string, provider: string, latency_ms: number} & ({verdict: import("./verdict-extract.mjs").ClaimVerdict} | {verdicts: import("./verdict-extract.mjs").ClaimVerdict[]})} OkResult
 * @typedef {{status: "error", reason: string}} ErrorResult
 * @typedef {SkippedResult|OkResult|ErrorResult} JudgeResult
 */

/**
 * @param {import("./config.mjs").Config} config
 * @param {string} promptText
 * @returns {Promise<JudgeResult>}
 */
export async function runJudge(config, promptText) {
  if (!config.apiKey) {
    return {
      status: "skipped",
      reason: `no credentials — set EXTERNAL_JUDGE_API_KEY (or provider-specific ${config.provider === "gemini" ? "GEMINI_API_KEY" : config.provider === "mistral" ? "MISTRAL_API_KEY" : "EXTERNAL_JUDGE_API_KEY"})`,
    };
  }
  if (!config.baseUrl || !config.model) {
    return {
      status: "error",
      reason: `missing config — baseUrl=${config.baseUrl || "(empty)"} model=${config.model || "(empty)"}`,
    };
  }

  const startedAt = Date.now();
  try {
    const { content } = await callChatCompletions(config, promptText);
    // A batched judge prompt (issue #119) is answered with an array: `verdicts`
    // keeps every element and its claim_id; a single object stays `verdict`.
    const extracted = extractVerdicts(content);
    return {
      status: "ok",
      ...extracted,
      model: config.model,
      provider: config.provider,
      latency_ms: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
