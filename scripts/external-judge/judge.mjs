#!/usr/bin/env node
/**
 * judge.mjs — host-side executor for cross-vendor (non-Anthropic) judge
 * slots in the self-check jury's model-diversity panel.
 *
 * The pipeline is host-driven: when a spawn_subagents invocation names a
 * `model` that is not an Anthropic model, the host cannot dispatch it via
 * the Agent tool — it must call an external OpenAI-compatible API directly.
 * This script is that executor, invoked as a subprocess by the host.
 *
 * Usage:
 *   node judge.mjs --provider gemini < /tmp/prompt.txt
 *   node judge.mjs --provider mistral --model mistral-small-latest < prompt.txt
 *   node judge.mjs --base-url https://... --model my-model < p.txt
 *
 * Env (used when the matching flag is absent):
 *   EXTERNAL_JUDGE_BASE_URL, EXTERNAL_JUDGE_MODEL, EXTERNAL_JUDGE_API_KEY,
 *   EXTERNAL_JUDGE_ALLOWED_ORIGINS, EXTERNAL_JUDGE_TIMEOUT_MS,
 *   GEMINI_API_KEY, MISTRAL_API_KEY.
 *
 * Precondition: prompt text arrives on stdin (`… < prompt.txt`). This script
 * opens no files. Prompt text is opaque to it — it is not validated as a
 * "judge prompt" beyond being non-empty.
 * Postcondition: prints exactly one JSON object to stdout, one of:
 *   {status:"ok", verdict:{...}, model, provider, latency_ms}
 *   {status:"skipped", reason}
 *   {status:"error", reason}
 * and exits 0 in all three cases — "skipped"/"error" are expected, callable
 * outcomes, not process failures (a missing API key is not a bug). The one
 * exception is a CLI usage error (bad flags, empty stdin), which exits 2
 * and prints to stderr, never stdout.
 *
 * Invariant: the API key is never printed, in --debug output or otherwise
 * (see lib/redact.mjs — every debug object routes through it).
 */

import { resolveConfig } from "./lib/config.mjs";
import { parseFlags, writeCliError } from "./lib/cli.mjs";
import { runJudge } from "./lib/judge-core.mjs";
import { redact } from "./lib/redact.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const config = resolveConfig(flags, process.env);

  // Prompt text arrives on stdin ONLY. `--prompt-file <p>` used to read the
  // path itself and post the bytes to a third-party endpoint — an
  // unconstrained file named on the command line whose contents leave the
  // machine (CodeQL js/file-access-to-http). `< p` is byte-for-byte the same
  // invocation with the shell doing the open, so nothing is lost by removing
  // it: what goes is a second way to do one thing (§9) that happened to be
  // the exfiltration primitive.
  const promptText = await readStdin();

  if (!promptText || !promptText.trim()) {
    process.stderr.write(`${redact("judge.mjs: empty prompt (pass the prompt as `judge.mjs … < prompt.txt`)")}\n`);
    process.exitCode = 2;
    return;
  }

  const debug = flags.debug === "true";
  if (debug) {
    process.stderr.write(`judge.mjs debug config: ${JSON.stringify(redact(config, config))}\n`);
  }

  const result = await runJudge(config, promptText);
  if (debug && result.status === "error") {
    process.stderr.write(`judge.mjs debug error: ${result.reason}\n`);
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch((err) => writeCliError("judge.mjs", err));
