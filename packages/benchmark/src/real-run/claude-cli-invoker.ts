import { spawn } from "node:child_process";
import { z } from "zod";
import type { Ports, Row, Settings } from "./types.js";

// source: the recorded Haiku result in __tests__/fixtures/claude-cli-result.json.
const tokens = z.number().int().nonnegative();
const accounting = z.object({
  input_tokens: tokens,
  output_tokens: tokens,
  cache_read_input_tokens: tokens,
  cache_creation_input_tokens: tokens,
});
const modelAccounting = z.object({
  inputTokens: tokens, outputTokens: tokens, cacheReadInputTokens: tokens,
  cacheCreationInputTokens: tokens, costUSD: z.number().nonnegative(),
}).partial();
const envelope = z.object({
  type: z.literal("result"), subtype: z.string(), is_error: z.boolean(),
  result: z.string().optional(), errors: z.array(z.string()).optional(),
  error: z.union([z.string(), z.object({ message: z.string() })]).optional(),
  duration_ms: z.number().nonnegative().nullish(), total_cost_usd: z.number().nonnegative().nullish(),
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
    ...(models.length > 1 && r.modelUsage ? { per_model: r.modelUsage } : {}),
  } : null;
  return { text: failed ? "" : r.result!, error, usage };
}

export function claudeArgs(settings: Settings): string[] {
  const args = ["-p", "--output-format", "json"];
  if (settings.model !== "session") args.push("--model", settings.model);
  if (settings.effort !== "session") args.push("--effort", settings.effort);
  return [...args, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", ""];
}

// Same diagnostic excerpt budget as scripts/check-health-stdio.mjs.
const STDERR_LIMIT = 4_000;

function readResult(stdout: string, stderr: string, failure?: string) {
  let result;
  try {
    result = parseClaudeResult(stdout);
  } catch {
    throw new Error([failure, "Claude CLI returned invalid or incomplete JSON", stderr].filter(Boolean).join(": "));
  }
  const error = [result.error, failure].filter(Boolean);
  if (error.length && stderr) error.push(stderr);
  return { ...result, error: error.join(": ") || undefined };
}

function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

type TrackCall = (row: Row, kill: () => void) => () => void;

export function makeClaudeInvoker(timeoutMs: number, program = "claude", track?: TrackCall): Ports["invoke"] {
  return (inv, settings, row) => new Promise((resolve, reject) => {
    const child = spawn(program, claudeArgs(settings), { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const kill = () => {
      if (child.pid !== undefined) killGroup(child.pid);
    };
    const release = track?.(row, kill);
    let stdout = "";
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => {
      stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
    });
    let failure: string | undefined;
    const timer = setTimeout(() => {
      failure = `Claude CLI timed out after ${timeoutMs} ms`;
      kill();
      release?.();
      reject(new Error([failure, stderr.trim()].filter(Boolean).join(": ")));
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
      release?.();
      if (code !== 0) failure ??= `Claude CLI exited with ${signal ?? code}`;
      try {
        resolve(readResult(stdout, stderr.trim(), failure));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(inv.prompt);
  });
}
