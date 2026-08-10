/**
 * Typed client for the Cortex MCP.
 *
 * One method per Cortex tool this project needs. Cortex owns
 * persistent memory; we never store anything ourselves.
 *
 * Tool names match the cortex MCP plugin (callable as raw `recall`, `remember`,
 * etc., when this client speaks to the Cortex server directly via stdio).
 */

import { StdioMcpClient, type StdioMcpClientConfig } from "../transport/stdio-mcp-client.js";
import {
  RecallRequestSchema,
  RecallResponseSchema,
  RememberRequestSchema,
  RememberResponseSchema,
  QueryMethodologyRequestSchema,
  CodebaseAnalyzeRequestSchema,
  IngestPrdRequestSchema,
  type RecallRequest,
  type RecallResponse,
  type RememberRequest,
  type RememberResponse,
  type QueryMethodologyRequest,
  type CodebaseAnalyzeRequest,
  type IngestPrdRequest,
} from "../contracts/memory.js";

export interface CortexClientConfig
  extends Omit<StdioMcpClientConfig, "serverName"> {}

export class CortexClient {
  private readonly client: StdioMcpClient;

  constructor(config: CortexClientConfig) {
    this.client = new StdioMcpClient({ ...config, serverName: "cortex" });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  // ─── recall / remember ───────────────────────────────────────────────────

  async recall(req: RecallRequest): Promise<RecallResponse> {
    const validated = RecallRequestSchema.parse(req);
    const raw = await this.client.callTool("recall", validated);
    return RecallResponseSchema.parse(raw);
  }

  async remember(req: RememberRequest): Promise<RememberResponse> {
    const validated = RememberRequestSchema.parse(req);
    const raw = await this.client.callTool("remember", validated);
    return RememberResponseSchema.parse(raw);
  }

  // ─── methodology / domain ────────────────────────────────────────────────

  async queryMethodology(req: QueryMethodologyRequest): Promise<unknown> {
    const validated = QueryMethodologyRequestSchema.parse(req);
    return this.client.callTool("query_methodology", validated);
  }

  async detectDomain(cwd?: string): Promise<unknown> {
    return this.client.callTool("detect_domain", { cwd });
  }

  // ─── codebase / PRD ingestion ────────────────────────────────────────────

  async codebaseAnalyze(req: CodebaseAnalyzeRequest): Promise<unknown> {
    const validated = CodebaseAnalyzeRequestSchema.parse(req);
    return this.client.callTool("codebase_analyze", validated);
  }

  async ingestPrd(req: IngestPrdRequest): Promise<unknown> {
    const validated = IngestPrdRequestSchema.parse(req);
    return this.client.callTool("ingest_prd", validated);
  }

  // ─── narrative / navigation (read-only) ──────────────────────────────────

  async narrative(query: string, limit = 20): Promise<unknown> {
    return this.client.callTool("narrative", { query, limit });
  }

  async navigateMemory(seedMemoryId: number | string, hops = 2): Promise<unknown> {
    return this.client.callTool("navigate_memory", {
      seed_memory_id: seedMemoryId,
      hops,
    });
  }
}
