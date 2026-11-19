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

function readResult(stdout: string, failure?: string) {
  try {
    const result = parseClaudeResult(stdout);
    return { ...result, error: failure ?? result.error };
  } catch {
    throw new Error(failure ?? "Claude CLI returned invalid or incomplete JSON");
  }
}

function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export function makeClaudeInvoker(timeoutMs: number, program = "claude"): Ports["invoke"] {
  return (inv, settings) => new Promise((resolve, reject) => {
    const child = spawn(program, claudeArgs(settings), { detached: true, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let failure: string | undefined;
    const timer = setTimeout(() => {
      failure = `Claude CLI timed out after ${timeoutMs} ms`;
      if (child.pid !== undefined) killGroup(child.pid);
      reject(new Error(failure));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", chunk => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.stdin.on("error", error => {
      failure ??= error.message;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) failure ??= `Claude CLI exited with ${signal ?? code}`;
      try {
        resolve(readResult(stdout, failure));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(inv.prompt);
  });
}
