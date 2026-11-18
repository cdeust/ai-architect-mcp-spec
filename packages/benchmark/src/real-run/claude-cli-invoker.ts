import { spawn } from "node:child_process";
import { z } from "zod";
import type { Ports, Settings } from "./types.js";

// source: the recorded Haiku result in __tests__/fixtures/claude-cli-result.json.
const tokens = z.number().int().nonnegative();
const envelope = z.object({
  type: z.literal("result"), subtype: z.string(), is_error: z.boolean(), result: z.string(),
  duration_ms: z.number().nonnegative(), total_cost_usd: z.number().nonnegative().nullish(),
  usage: z.object({ input_tokens: tokens, output_tokens: tokens, cache_read_input_tokens: tokens,
    cache_creation_input_tokens: tokens }),
  modelUsage: z.record(z.string(), z.unknown()),
});

export function parseClaudeResult(stdout: string) {
  const parsed = envelope.safeParse(JSON.parse(stdout));
  if (!parsed.success) throw new Error("Claude CLI returned an incomplete result envelope");
  const r = parsed.data;
  const models = Object.keys(r.modelUsage);
  if (!models.length) throw new Error("Claude CLI did not report a model");
  const error = r.is_error || r.subtype !== "success" ? "Claude CLI reported an unsuccessful result" : undefined;
  return { text: error ? "" : r.result, error, usage: {
    input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens,
    cache_read_tokens: r.usage.cache_read_input_tokens, cache_creation_tokens: r.usage.cache_creation_input_tokens,
    duration_ms: r.duration_ms, cost_usd: r.total_cost_usd ?? null, model_reported: models.join(", "),
  } };
}

export function claudeArgs(settings: Settings): string[] {
  const args = ["-p", "--output-format", "json"];
  if (settings.model !== "session") args.push("--model", settings.model);
  if (settings.effort !== "session") args.push("--effort", settings.effort);
  return [...args, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", ""];
}

export const claudeInvoke: Ports["invoke"] = (inv, settings) => new Promise((resolve, reject) => {
  const child = spawn("claude", claudeArgs(settings), { stdio: ["pipe", "pipe", "ignore"] });
  let stdout = "";
  let writeError: Error | undefined;
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.on("error", reject);
  child.stdin.on("error", error => { writeError = error; });
  child.on("close", (code, signal) => {
    const failure = code !== 0 ? `Claude CLI exited with ${signal ?? code}` : writeError?.message;
    try {
      const result = parseClaudeResult(stdout);
      resolve({ ...result, error: failure ?? result.error });
    } catch {
      reject(new Error(failure ?? "Claude CLI returned invalid or incomplete JSON"));
    }
  });
  child.stdin.end(inv.prompt);
});
