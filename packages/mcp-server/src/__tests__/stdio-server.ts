/**
 * The built server over stdio, for the tests that must see what a host
 * receives from the tools registered in index.ts (the process entry point,
 * which cannot be imported: it connects a transport when loaded).
 *
 * Needs `pnpm build` first, as every CI command runs it before the tests.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(__dirname, "..", "..", "dist", "index.js");

// A cold start of dist/index.js loads the orchestration, validation and
// verification trees, which scales with runner load (see
// check-health-stdio.test.ts); a validator call on a 100,000-char section is
// far below it.
const RESPONSE_TIMEOUT_MS = 30_000;

export interface ToolResponse {
  /** The text of the tool result, as the host receives it. */
  readonly text: string;
  readonly isError: boolean;
}

export interface StdioServer {
  listTools(): Promise<string[]>;
  call(name: string, args: Record<string, unknown>): Promise<ToolResponse>;
  /** Stops the server and removes its scratch directory. */
  close(): Promise<void>;
}

interface RpcMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

export interface StdioServerOptions {
  /** The entry point to start instead of the workspace build. */
  readonly entry?: string;
  /** Variables removed from the server's environment. */
  readonly unset?: readonly string[];
}

/**
 * precondition:  `prepare`, when given, writes what the server must find at
 *                start in the evidence database whose path it receives.
 * postcondition: a started and initialized server whose evidence database
 *                lives in a scratch directory of its own.
 */
export async function startStdioServer(
  prepare?: (evidenceDbPath: string) => void,
  options: StdioServerOptions = {},
): Promise<StdioServer> {
  const scratch = mkdtempSync(join(tmpdir(), "prd-gen-stdio-"));
  const evidenceDbPath = join(scratch, "evidence.db");
  prepare?.(evidenceDbPath);
  const env: NodeJS.ProcessEnv = { ...process.env, PRD_GEN_EVIDENCE_DB: evidenceDbPath };
  for (const name of options.unset ?? []) delete env[name];
  const child = spawn(process.execPath, [options.entry ?? ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (m: RpcMessage) => void; reject: (e: Error) => void }>();
  let stderr = "";
  let buffer = "";
  let nextId = 1;

  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on("error", failAll);
  child.on("exit", (code) => failAll(new Error(`server exited (code ${code}): ${stderr}`)));
  // setEncoding decodes across chunk boundaries: a multi-byte character cut
  // by a pipe read (the em dash of a story line, say) would otherwise come
  // out as two U+FFFD (review of #235).
  child.stderr!.setEncoding("utf8");
  child.stdout!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        continue;
      }
      const waiter = message.id === undefined ? undefined : pending.get(message.id);
      if (waiter === undefined) continue;
      pending.delete(message.id!);
      waiter.resolve(message);
    }
  });

  const send = (message: object) => child.stdin!.write(JSON.stringify(message) + "\n");
  const request = (method: string, params: object): Promise<RpcMessage> => {
    const id = nextId++;
    return new Promise<RpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no answer to ${method} within ${RESPONSE_TIMEOUT_MS} ms: ${stderr}`));
      }, RESPONSE_TIMEOUT_MS);
      pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };
  const resultOf = async (method: string, params: object): Promise<unknown> => {
    const message = await request(method, params);
    if (message.error) throw new Error(`${method} failed: ${message.error.message}`);
    return message.result;
  };

  await resultOf("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stdio-server-test", version: "0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  return {
    async listTools() {
      const result = (await resultOf("tools/list", {})) as { tools: Array<{ name: string }> };
      return result.tools.map((tool) => tool.name);
    },
    async call(name, args) {
      const result = (await resultOf("tools/call", { name, arguments: args })) as {
        content: Array<{ text?: string }>;
        isError?: boolean;
      };
      return { text: result.content.map((part) => part.text ?? "").join(""), isError: result.isError === true };
    },
    async close() {
      // kill() only sends the signal; wait for the exit, or Windows still
      // holds evidence.db locked and the delete fails with EBUSY (#126).
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill();
        await exited;
      }
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
