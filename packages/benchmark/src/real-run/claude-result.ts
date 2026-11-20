import { z } from "zod";

// source: the recorded Haiku result in __tests__/fixtures/claude-cli-result.json.
const tokens = z.number().int().nonnegative();
const accounting = z.object({
  input_tokens: tokens,
  output_tokens: tokens,
  cache_read_input_tokens: tokens,
  cache_creation_input_tokens: tokens,
});
const modelAccounting = z.object({
  inputTokens: tokens,
  outputTokens: tokens,
  cacheReadInputTokens: tokens,
  cacheCreationInputTokens: tokens,
  costUSD: z.number().nonnegative(),
}).partial();
const envelope = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  error: z.union([z.string(), z.object({ message: z.string() })]).optional(),
  duration_ms: z.number().nonnegative().nullish(),
  total_cost_usd: z.number().nonnegative().nullish(),
  usage: accounting.partial().nullish(),
  modelUsage: z.record(z.string(), modelAccounting).nullish(),
});

export function parseClaudeResult(stdout: string) {
  const r = envelope.parse(JSON.parse(stdout));
  const models = Object.keys(r.modelUsage ?? {});
  const failed = r.is_error || r.subtype !== "success";
  if (!failed && (r.result === undefined || r.duration_ms == null || !models.length || !accounting.safeParse(r.usage).success)) {
    throw new Error("Claude CLI returned an incomplete success envelope");
  }
  const detail = typeof r.error === "string" ? r.error : r.error?.message;
  const error = failed ? [r.subtype, detail, ...(r.errors ?? []), r.result].filter(Boolean).join(": ") : undefined;
  const usage = r.usage || r.total_cost_usd != null || models.length || r.duration_ms != null ? {
    input_tokens: r.usage?.input_tokens ?? null,
    output_tokens: r.usage?.output_tokens ?? null,
    cache_read_tokens: r.usage?.cache_read_input_tokens ?? null,
    cache_creation_tokens: r.usage?.cache_creation_input_tokens ?? null,
    duration_ms: r.duration_ms ?? null,
    cost_usd: r.total_cost_usd ?? null,
    model_reported: models.join(", "),
    ...(models.length > 1 ? { per_model: r.modelUsage! } : {}),
  } : null;
  return { text: failed ? "" : r.result!, error, usage };
}

// Same diagnostic excerpt budget as scripts/check-health-stdio.mjs.
const STDERR_LIMIT = 4_000;

export function readResult(stdout: string, stderr: string, failure?: string) {
  let result;
  try {
    result = parseClaudeResult(stdout);
  } catch {
    throw new Error([failure, "Claude CLI returned invalid or incomplete JSON", stderr].filter(Boolean).join(": "));
  }
  const error = [result.error, failure].filter(Boolean);
  if (error.length && stderr) {
    error.push(stderr);
  }
  return { ...result, error: error.join(": ") || undefined };
}

export function appendStderr(stderr: string, chunk: string): string {
  return stderr + chunk.slice(0, STDERR_LIMIT - stderr.length);
}

export function settleOutput(stdout: string, stderr: string, failure: string | undefined, final: boolean) {
  try {
    return readResult(stdout, stderr.trim(), failure);
  } catch (error) {
    if (final) return error as Error;
  }
}
