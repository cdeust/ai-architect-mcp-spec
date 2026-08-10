/**
 * Typed client for the ai-architect-mcp-codebase MCP.
 *
 * One method per pipeline stage this project needs from ai-architect-mcp-codebase. Tool names
 * are canonical — see /Users/cdeust/Developments/anthropic/ai-architect-mcp-codebase/NOTES.md.
 *
 * We do NOT reimplement any pipeline logic; we type the requests and parse
 * the responses, delegating execution to the Rust MCP server.
 */

import { StdioMcpClient, type StdioMcpClientConfig } from "../transport/stdio-mcp-client.js";
import {
  IndexCodebaseRequestSchema,
  IndexCodebaseResponseSchema,
  AnalyzeCodebaseRequestSchema,
  AnalyzeCodebaseResponseSchema,
  QueryGraphRequestSchema,
  SearchCodebaseRequestSchema,
  SearchCodebaseHitSchema,
  GetContextRequestSchema,
  GetImpactRequestSchema,
  ImpactedSymbolSchema,
  PreparePrdInputRequestSchema,
  PrdInputBundleSchema,
  ValidatePrdAgainstGraphRequestSchema,
  PrdGraphValidationReportSchema,
  VerifySemanticDiffRequestSchema,
  SemanticDiffReportSchema,
  type IndexCodebaseRequest,
  type IndexCodebaseResponse,
  type AnalyzeCodebaseRequest,
  type AnalyzeCodebaseResponse,
  type QueryGraphRequest,
  type SearchCodebaseRequest,
  type SearchCodebaseHit,
  type GetContextRequest,
  type GetImpactRequest,
  type ImpactedSymbol,
  type PreparePrdInputRequest,
  type PrdInputBundle,
  type ValidatePrdAgainstGraphRequest,
  type PrdGraphValidationReport,
  type VerifySemanticDiffRequest,
  type SemanticDiffReport,
} from "../contracts/codebase.js";
import { z } from "zod";

const HealthResponseSchema = z.object({
  status: z.string(),
  uptime_s: z.number().optional(),
  version: z.string().optional(),
});

export interface AiArchitectCodebaseClientConfig
  extends Omit<StdioMcpClientConfig, "serverName"> {}

export class AiArchitectCodebaseClient {
  private readonly client: StdioMcpClient;

  constructor(config: AiArchitectCodebaseClientConfig) {
    this.client = new StdioMcpClient({
      ...config,
      serverName: "ai-architect",
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  // ─── Stage 0 ─────────────────────────────────────────────────────────────

  async healthCheck(): Promise<{ status: string; version?: string }> {
    const raw = await this.client.callTool("health_check", {});
    return HealthResponseSchema.parse(raw);
  }

  // ─── Stage 3a ────────────────────────────────────────────────────────────

  async indexCodebase(req: IndexCodebaseRequest): Promise<IndexCodebaseResponse> {
    const validated = IndexCodebaseRequestSchema.parse(req);
    const raw = await this.client.callTool("index_codebase", validated);
    return IndexCodebaseResponseSchema.parse(raw);
  }

  async queryGraph(req: QueryGraphRequest): Promise<unknown> {
    const validated = QueryGraphRequestSchema.parse(req);
    return this.client.callTool("query_graph", validated);
  }

  async getSymbol(graphId: string, fqn: string): Promise<unknown> {
    return this.client.callTool("get_symbol", { graph_id: graphId, fqn });
  }

  // ─── Stage 3b ────────────────────────────────────────────────────────────

  async resolveGraph(graphId: string): Promise<unknown> {
    return this.client.callTool("resolve_graph", { graph_id: graphId });
  }

  // ─── Stage 3c ────────────────────────────────────────────────────────────

  async getImpact(req: GetImpactRequest): Promise<readonly ImpactedSymbol[]> {
    const validated = GetImpactRequestSchema.parse(req);
    const raw = await this.client.callTool<typeof validated, { impacted: unknown[] }>(
      "get_impact",
      validated,
    );
    const arr = Array.isArray(raw) ? raw : (raw.impacted ?? []);
    return z.array(ImpactedSymbolSchema).parse(arr);
  }

  async clusterGraph(graphId: string): Promise<unknown> {
    return this.client.callTool("cluster_graph", { graph_id: graphId });
  }

  // ─── Stage 3d ────────────────────────────────────────────────────────────

  async searchCodebase(
    req: SearchCodebaseRequest,
  ): Promise<readonly SearchCodebaseHit[]> {
    const validated = SearchCodebaseRequestSchema.parse(req);
    const raw = await this.client.callTool<typeof validated, { hits: unknown[] }>(
      "search_codebase",
      validated,
    );
    const arr = Array.isArray(raw) ? raw : (raw.hits ?? []);
    return z.array(SearchCodebaseHitSchema).parse(arr);
  }

  async getContext(req: GetContextRequest): Promise<unknown> {
    const validated = GetContextRequestSchema.parse(req);
    return this.client.callTool("get_context", validated);
  }

  /**
   * Stage 3 all-in-one: index_codebase + resolve_graph + cluster_graph in
   * one call. Prefer this over indexCodebase() when the caller needs
   * resolved/clustered graph state (e.g. before prepare_prd_input) — a
   * bare index_codebase graph has zero communities/processes because it
   * skips Stage 3b/3c (see input-analysis.ts module doc for the measured
   * regression this fixes: memory 4263670).
   *
   * source: ai-architect-mcp-codebase/src/tool_schemas.rs:522
   * analyze_codebase_schema — required { path, output_dir }, NOT
   * { directory } (pre-fix signature was wrong and never matched the
   * live binary's schema).
   */
  async analyzeCodebase(
    req: AnalyzeCodebaseRequest,
  ): Promise<AnalyzeCodebaseResponse> {
    const validated = AnalyzeCodebaseRequestSchema.parse(req);
    const raw = await this.client.callTool("analyze_codebase", validated);
    return AnalyzeCodebaseResponseSchema.parse(raw);
  }

  // ─── Stage 4 ─────────────────────────────────────────────────────────────

  async preparePrdInput(req: PreparePrdInputRequest): Promise<PrdInputBundle> {
    const validated = PreparePrdInputRequestSchema.parse(req);
    const raw = await this.client.callTool("prepare_prd_input", validated);
    return PrdInputBundleSchema.parse(raw);
  }

  // ─── Stage 6 ─────────────────────────────────────────────────────────────

  async validatePrdAgainstGraph(
    req: ValidatePrdAgainstGraphRequest,
  ): Promise<PrdGraphValidationReport> {
    const validated = ValidatePrdAgainstGraphRequestSchema.parse(req);
    const raw = await this.client.callTool("validate_prd_against_graph", validated);
    return PrdGraphValidationReportSchema.parse(raw);
  }

  // ─── Stage 8 ─────────────────────────────────────────────────────────────

  async checkSecurityGates(graphId: string, diffPath?: string): Promise<unknown> {
    return this.client.callTool("check_security_gates", {
      graph_id: graphId,
      diff_path: diffPath,
    });
  }

  // ─── Stage 9 ─────────────────────────────────────────────────────────────

  async verifySemanticDiff(
    req: VerifySemanticDiffRequest,
  ): Promise<SemanticDiffReport> {
    const validated = VerifySemanticDiffRequestSchema.parse(req);
    const raw = await this.client.callTool("verify_semantic_diff", validated);
    return SemanticDiffReportSchema.parse(raw);
  }
}
