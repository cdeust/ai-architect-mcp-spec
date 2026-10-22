import { describe, it, expect, vi, beforeEach } from "vitest";

const callTool = vi.fn();
const connect = vi.fn();
const close = vi.fn();
const ctor = vi.fn();

vi.mock("../transport/stdio-mcp-client.js", () => ({
  StdioMcpClient: class {
    constructor(cfg: unknown) {
      ctor(cfg);
    }
    connect = connect;
    close = close;
    callTool = callTool;
  },
}));

import { CortexClient } from "../clients/cortex-client.js";

describe("CortexClient", () => {
  let c: CortexClient;
  beforeEach(() => {
    vi.clearAllMocks();
    c = new CortexClient({ command: "cortex", args: ["serve"] });
  });

  it("names the underlying server 'cortex' and delegates lifecycle", async () => {
    expect(ctor).toHaveBeenCalledWith({ command: "cortex", args: ["serve"], serverName: "cortex" });
    await c.connect();
    await c.close();
    expect(connect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("recall applies request defaults and maps the response shape", async () => {
    callTool.mockResolvedValue({ memories: [{ memory_id: 1, content: "x", score: 0.5 }], count: 1, intent: "lookup" });
    const out = await c.recall({ query: "auth" } as never);
    expect(callTool).toHaveBeenCalledWith("recall", { query: "auth", max_results: 10, min_heat: 0.05 });
    expect(out).toEqual({
      results: [{ memory_id: 1, content: "x", score: 0.5 }],
      total: 1,
      query_intent: "lookup",
    });
  });

  it("recall rejects invalid requests before calling the server", async () => {
    await expect(c.recall({ query: "q", max_results: 0 } as never)).rejects.toThrow();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("recall rejects a malformed server response", async () => {
    callTool.mockResolvedValue({ nope: true });
    await expect(c.recall({ query: "q" } as never)).rejects.toThrow();
  });

  it("remember validates both directions", async () => {
    callTool.mockResolvedValue({ memory_id: "m1", stored: true });
    expect(await c.remember({ content: "fact" } as never)).toEqual({ memory_id: "m1", stored: true });
    expect(callTool).toHaveBeenCalledWith("remember", { content: "fact", tags: [] });
    callTool.mockResolvedValue({ stored: true });
    await expect(c.remember({ content: "fact" } as never)).rejects.toThrow();
  });

  it("forwards methodology, codebase and ingest requests with defaults", async () => {
    callTool.mockResolvedValue("ok");
    await c.queryMethodology({} as never);
    expect(callTool).toHaveBeenLastCalledWith("query_methodology", { cwd: null, first_message: null, project: null });
    await c.codebaseAnalyze({ directory: "/repo" } as never);
    expect(callTool).toHaveBeenLastCalledWith("codebase_analyze", { directory: "/repo", refresh: false });
    await c.ingestPrd({ prd_path: "p.md" } as never);
    expect(callTool).toHaveBeenLastCalledWith("ingest_prd", { prd_path: "p.md" });
  });

  it("forwards detect_domain, narrative and navigate_memory", async () => {
    callTool.mockResolvedValue("ok");
    await c.detectDomain("/x");
    expect(callTool).toHaveBeenLastCalledWith("detect_domain", { cwd: "/x" });
    await c.narrative("story");
    expect(callTool).toHaveBeenLastCalledWith("narrative", { query: "story", limit: 20 });
    await c.navigateMemory(7);
    expect(callTool).toHaveBeenLastCalledWith("navigate_memory", { seed_memory_id: 7, hops: 2 });
    await c.navigateMemory("a", 4);
    expect(callTool).toHaveBeenLastCalledWith("navigate_memory", { seed_memory_id: "a", hops: 4 });
  });

  it("rejects invalid codebase_analyze requests", async () => {
    await expect(c.codebaseAnalyze({} as never)).rejects.toThrow();
    expect(callTool).not.toHaveBeenCalled();
  });
});
