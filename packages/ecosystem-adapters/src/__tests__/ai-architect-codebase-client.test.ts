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

import { AiArchitectCodebaseClient } from "../clients/ai-architect-codebase-client.js";

describe("AiArchitectCodebaseClient", () => {
  let c: AiArchitectCodebaseClient;
  beforeEach(() => {
    vi.clearAllMocks();
    c = new AiArchitectCodebaseClient({ command: "ai-architect" });
  });

  it("names the server and delegates lifecycle", async () => {
    expect(ctor).toHaveBeenCalledWith({ command: "ai-architect", serverName: "ai-architect" });
    await c.connect();
    await c.close();
    expect(connect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("health_check parses the status and rejects a malformed reply", async () => {
    callTool.mockResolvedValue({ status: "ok", version: "1.2.3", extra: 1 });
    expect(await c.healthCheck()).toEqual({ status: "ok", version: "1.2.3" });
    expect(callTool).toHaveBeenCalledWith("health_check", {});
    callTool.mockResolvedValue({ version: "1" });
    await expect(c.healthCheck()).rejects.toThrow();
  });

  it("applies request defaults for validated calls", async () => {
    callTool.mockResolvedValue({});
    await c.queryGraph({ graph_path: "/g", query: "MATCH (n)" });
    expect(callTool).toHaveBeenLastCalledWith("query_graph", { graph_path: "/g", query: "MATCH (n)" });
    await c.getContext({ graph_id: "g", symbol_fqn: "a::b" } as never);
    expect(callTool).toHaveBeenLastCalledWith("get_context", { graph_id: "g", symbol_fqn: "a::b", hops: 2 });
  });

  it("rejects out-of-range requests before calling the server", async () => {
    await expect(c.getContext({ graph_id: "g", symbol_fqn: "x", hops: 9 } as never)).rejects.toThrow();
    await expect(c.searchCodebase({ graph_id: "g", query: "q", limit: 0 } as never)).rejects.toThrow();
    await expect(c.getImpact({ graph_id: "g", changed_symbols: [] } as never)).rejects.toThrow();
    await expect(c.preparePrdInput({ graph_id: "g" } as never)).rejects.toThrow();
    await expect(c.validatePrdAgainstGraph({ graph_id: "g" } as never)).rejects.toThrow();
    await expect(c.verifySemanticDiff({ pre_graph_id: "a" } as never)).rejects.toThrow();
    await expect(c.indexCodebase({ path: "/p" } as never)).rejects.toThrow();
    await expect(c.analyzeCodebase({ path: "/p" } as never)).rejects.toThrow();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("searchCodebase accepts either a bare array or a { hits } envelope", async () => {
    const hit = { symbol: "s", file: "f.ts", line: 3, score: 0.9, snippet: "code" };
    callTool.mockResolvedValue([hit]);
    const bare = await c.searchCodebase({ graph_id: "g", query: "q" } as never);
    expect(bare).toEqual([expect.objectContaining(hit)]);
    expect(callTool).toHaveBeenLastCalledWith("search_codebase", { graph_id: "g", query: "q", mode: "hybrid", limit: 10 });

    callTool.mockResolvedValue({ hits: [hit] });
    expect(await c.searchCodebase({ graph_id: "g", query: "q" } as never)).toHaveLength(1);
    callTool.mockResolvedValue({});
    expect(await c.searchCodebase({ graph_id: "g", query: "q" } as never)).toEqual([]);
    callTool.mockResolvedValue([{ symbol: "s" }]);
    await expect(c.searchCodebase({ graph_id: "g", query: "q" } as never)).rejects.toThrow();
  });

  it("getImpact accepts either a bare array or an { impacted } envelope", async () => {
    const sym = { fqn: "a::b", distance: 1 };
    callTool.mockResolvedValue({ impacted: [sym] });
    expect(await c.getImpact({ graph_id: "g", changed_symbols: ["a"] } as never)).toEqual([sym]);
    expect(callTool).toHaveBeenLastCalledWith("get_impact", { graph_id: "g", changed_symbols: ["a"], depth: 2 });
    callTool.mockResolvedValue([sym]);
    expect(await c.getImpact({ graph_id: "g", changed_symbols: ["a"] } as never)).toEqual([sym]);
    callTool.mockResolvedValue({});
    expect(await c.getImpact({ graph_id: "g", changed_symbols: ["a"] } as never)).toEqual([]);
    callTool.mockResolvedValue({ impacted: [{ fqn: "a", distance: -1 }] });
    await expect(c.getImpact({ graph_id: "g", changed_symbols: ["a"] } as never)).rejects.toThrow();
  });

  it("forwards the raw-result tools with their snake_case argument names", async () => {
    callTool.mockResolvedValue("raw");
    expect(await c.getSymbol("g", "a::b")).toBe("raw");
    expect(callTool).toHaveBeenLastCalledWith("get_symbol", { graph_id: "g", fqn: "a::b" });
    await c.resolveGraph("g");
    expect(callTool).toHaveBeenLastCalledWith("resolve_graph", { graph_id: "g" });
    await c.clusterGraph("g");
    expect(callTool).toHaveBeenLastCalledWith("cluster_graph", { graph_id: "g" });
    await c.checkSecurityGates("g");
    expect(callTool).toHaveBeenLastCalledWith("check_security_gates", { graph_id: "g", diff_path: undefined });
    await c.checkSecurityGates("g", "/d.patch");
    expect(callTool).toHaveBeenLastCalledWith("check_security_gates", { graph_id: "g", diff_path: "/d.patch" });
  });

  it("validatePrdAgainstGraph and verifySemanticDiff reject malformed server replies", async () => {
    callTool.mockResolvedValue({ verdict: "maybe" });
    await expect(
      c.validatePrdAgainstGraph({ graph_id: "g", prd_path: "/p.md" }),
    ).rejects.toThrow();
    await expect(
      c.verifySemanticDiff({ pre_graph_id: "a", post_graph_id: "b" }),
    ).rejects.toThrow();
    expect(callTool).toHaveBeenCalledWith("validate_prd_against_graph", { graph_id: "g", prd_path: "/p.md" });
    expect(callTool).toHaveBeenCalledWith("verify_semantic_diff", { pre_graph_id: "a", post_graph_id: "b" });
  });

  it("indexCodebase, analyzeCodebase and preparePrdInput send validated requests", async () => {
    callTool.mockResolvedValue({});
    await expect(c.indexCodebase({ path: "/p", output_dir: "/o" } as never)).rejects.toThrow();
    expect(callTool).toHaveBeenLastCalledWith("index_codebase", { path: "/p", output_dir: "/o", language: "auto" });
    await expect(c.analyzeCodebase({ path: "/p", output_dir: "/o" } as never)).rejects.toThrow();
    expect(callTool).toHaveBeenLastCalledWith("analyze_codebase", expect.objectContaining({ path: "/p", output_dir: "/o" }));
    await expect(
      c.preparePrdInput({ graph_id: "g", finding_id: "f", output_path: "/x.json" }),
    ).rejects.toThrow();
    expect(callTool).toHaveBeenLastCalledWith("prepare_prd_input", { graph_id: "g", finding_id: "f", output_path: "/x.json" });
  });
});
