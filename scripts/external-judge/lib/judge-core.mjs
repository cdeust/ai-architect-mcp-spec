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
import { PROVIDER_PRESETS } from "./config.mjs";
import { redact } from "./redact.mjs";
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
    const presetKey = PROVIDER_PRESETS[config.provider]?.apiKeyEnv;
    const sources = presetKey ? `EXTERNAL_JUDGE_API_KEY or ${presetKey}` : "EXTERNAL_JUDGE_API_KEY";
    return {
      status: "skipped",
      reason: redact(`no credentials — set ${sources}`, config),
    };
  }
  if (!config.baseUrl || !config.model) {
    return {
      status: "error",
      reason: redact("missing config — a base URL and model are required", config),
    };
  }

  const startedAt = Date.now();
  try {
    const { content } = await callChatCompletions(config, promptText);
    // A batched judge prompt (issue #119) is answered with an array: `verdicts`
    // keeps every element and its claim_id; a single object stays `verdict`.
    const extracted = extractVerdicts(content);
    const redactVerdict = ({ verdict, ...textAndConfidence }) => ({ verdict, ...redact(textAndConfidence, config) });
    const verdicts = "verdicts" in extracted
      ? { verdicts: extracted.verdicts.map(redactVerdict) }
      : { verdict: redactVerdict(extracted.verdict) };
    return {
      status: "ok",
      ...verdicts,
      model: redact(config.model, config),
      provider: redact(config.provider, config),
      latency_ms: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      status: "error",
      reason: redact(err instanceof Error ? err.message : "unexpected judge failure", config),
    };
  }
}
