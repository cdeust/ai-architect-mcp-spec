import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendStderr, settleOutput, type readResult } from "./claude-result.js";
export { parseClaudeResult } from "./claude-result.js";
import type { Ports, Row, Settings } from "./types.js";

export function claudeArgs(settings: Settings): string[] {
  const args = ["-p", "--output-format", "json"];
  if (settings.model !== "session") {
    args.push("--model", settings.model);
  }
  if (settings.effort !== "session") {
    args.push("--effort", settings.effort);
  }
  return [...args, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", ""];
}

function groupKiller(child: ChildProcessWithoutNullStreams, row: Row) {
  let killed = false;
  return () => {
    if (killed || child.pid === undefined) return;
    killed = true;
    try {
      // The leader can be reaped before inherited pipes close. Probe for surviving
      // group members before signalling. PID reuse cannot be excluded, but for
      // a complete result we signal immediately after leader exit, leaving a negligible window.
      if (child.exitCode !== null || child.signalCode !== null) process.kill(-child.pid, 0);
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        (row.notes ??= []).push(`Process group cleanup failed: ${String(error)}`);
      }
    }
  };
}

type TrackCall = (row: Row, kill: () => void, cleanup: () => void) => void;

export function collectOutput(child: ChildProcessWithoutNullStreams, timeoutMs: number, kill: () => void) {
  return new Promise<ReturnType<typeof readResult>>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let failure: string | undefined;
    let settled = false;
    let exited = false;
    function finish(result: ReturnType<typeof readResult> | Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      if (result instanceof Error) reject(result);
      else resolve(result);
    }
    function read(final: boolean) {
      if (settled) return;
      const result = settleOutput(stdout, stderr, failure, final);
      if (result) finish(result);
    }
    const timer = setTimeout(() => {
      finish(new Error([`Claude CLI timed out after ${timeoutMs} ms`, stderr.trim()].filter(Boolean).join(": ")));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", chunk => {
      stdout += chunk;
      if (exited) read(false);
    });
    child.stderr.setEncoding("utf8").on("data", chunk => {
      stderr = appendStderr(stderr, chunk);
    });
    child.once("error", finish);
    child.stdin.on("error", error => {
      failure ??= error.message;
    });
    child.once("exit", (code, signal) => {
      exited = true;
      if (code !== 0) failure = [`Claude CLI exited with ${signal ?? code}`, failure].filter(Boolean).join(": ");
      read(false);
    });
    child.once("close", () => read(true));
  });
}

export function makeClaudeInvoker(timeoutMs: number, directory: string, program = "claude", track?: TrackCall, env = process.env, remove = rmSync): Ports["invoke"] {
  return async (inv, settings, row) => {
    const cwd = mkdtempSync(resolve(realpathSync(directory), "call-"));
    const cleanup = () => {
      try {
        remove(cwd, { recursive: true, force: true });
      } catch (error) {
        row.workspace_kept = true;
        row.workspace_path = cwd;
        row.workspace_removal_error = String(error);
      }
    };
    let tracked = false;
    try {
      const child = spawn(program, claudeArgs(settings), {
        cwd,
        detached: true,
        env: {
          ...env,
          CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        },
      });
      const kill = groupKiller(child, row);
      if (track) {
        track(row, kill, cleanup);
        tracked = true;
      }
      const result = collectOutput(child, timeoutMs, kill);
      child.stdin.end(inv.prompt);
      return await result;
    } finally {
      if (!tracked) cleanup();
    }
  };
}
