/**
 * StdioMcpClient behaviour once connected, with the MCP SDK replaced by a
 * scripted fake so no child process is spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sdk = vi.hoisted(() => ({
  clientConnect: vi.fn(),
  clientCallTool: vi.fn(),
  clientClose: vi.fn(),
  transportCfg: vi.fn(),
  clientInfo: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    constructor(info: unknown) {
      sdk.clientInfo(info);
    }
    connect = sdk.clientConnect;
    callTool = sdk.clientCallTool;
    close = sdk.clientClose;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(cfg: unknown) {
      sdk.transportCfg(cfg);
    }
  },
}));

import { StdioMcpClient } from "../transport/stdio-mcp-client.js";

const text = (t: string) => ({ content: [{ type: "text", text: t }] });

describe("StdioMcpClient — connected", () => {
  let c: StdioMcpClient;
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.clientConnect.mockResolvedValue(undefined);
    c = new StdioMcpClient({
      serverName: "srv",
      command: "bin",
      args: ["--x"],
      env: { A: "1" },
      cwd: "/w",
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns the transport with the configured command, args, env and cwd", async () => {
    await c.connect();
    expect(sdk.transportCfg).toHaveBeenCalledWith({ command: "bin", args: ["--x"], env: { A: "1" }, cwd: "/w" });
    expect(sdk.clientInfo).toHaveBeenCalledWith({ name: "prd-gen-adapter-srv", version: "0.1.0" });
  });

  it("defaults args to empty and env to undefined", async () => {
    await new StdioMcpClient({ serverName: "s", command: "b" }).connect();
    expect(sdk.transportCfg).toHaveBeenCalledWith({ command: "b", args: [], env: undefined, cwd: undefined });
  });

  it("connect() is idempotent and shares an in-flight connection", async () => {
    await Promise.all([c.connect(), c.connect()]);
    await c.connect();
    expect(sdk.clientConnect).toHaveBeenCalledTimes(1);
  });

  it("surfaces a connect failure and allows a retry", async () => {
    sdk.clientConnect.mockRejectedValueOnce(new Error("spawn ENOENT"));
    await expect(c.connect()).rejects.toThrow("spawn ENOENT");
    await expect(c.connect()).resolves.toBeUndefined();
  });

  it("times out when the handshake never completes", async () => {
    vi.useFakeTimers();
    sdk.clientConnect.mockReturnValue(new Promise(() => {}));
    const p = c.connect();
    const assertion = expect(p).rejects.toThrow(/srv: connect\(\) timed out after 10000 ms/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("prefers structuredContent over text", async () => {
    await c.connect();
    sdk.clientCallTool.mockResolvedValue({ structuredContent: { a: 1 }, ...text("ignored") });
    expect(await c.callTool("t", { q: 1 })).toEqual({ a: 1 });
    expect(sdk.clientCallTool).toHaveBeenCalledWith({ name: "t", arguments: { q: 1 } });
  });

  it("parses JSON text and falls back to the raw string", async () => {
    await c.connect();
    sdk.clientCallTool.mockResolvedValueOnce(text('{"ok":true}'));
    expect(await c.callTool("t", {})).toEqual({ ok: true });
    sdk.clientCallTool.mockResolvedValueOnce(text("plain words"));
    expect(await c.callTool("t", {})).toBe("plain words");
  });

  it("joins multiple text blocks and ignores non-text blocks", async () => {
    await c.connect();
    sdk.clientCallTool.mockResolvedValue({
      content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
    });
    expect(await c.callTool("t", {})).toBe("a\nb");
  });

  it("throws when the result has no text content", async () => {
    await c.connect();
    sdk.clientCallTool.mockResolvedValue({ content: [] });
    await expect(c.callTool("t", {})).rejects.toThrow("srv.t returned no text content");
    sdk.clientCallTool.mockResolvedValue({});
    await expect(c.callTool("t", {})).rejects.toThrow("returned no text content");
  });

  it("turns an isError result into an exception carrying the server's text", async () => {
    await c.connect();
    sdk.clientCallTool.mockResolvedValue({ isError: true, ...text("bad input") });
    await expect(c.callTool("t", {})).rejects.toThrow("srv.t returned error: bad input");
  });

  it("close() releases the client so callTool needs a fresh connect", async () => {
    await c.connect();
    await c.close();
    expect(sdk.clientClose).toHaveBeenCalledOnce();
    await expect(c.callTool("t", {})).rejects.toThrow(/before connect\(\)/);
    await c.close();
    expect(sdk.clientClose).toHaveBeenCalledOnce();
  });
});
