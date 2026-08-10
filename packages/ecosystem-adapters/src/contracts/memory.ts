/**
 * Contracts for the Cortex MCP.
 * Cortex owns persistent memory; we never store anything ourselves.
 *
 * Tool names match the Cortex MCP plugin (mcp__plugin_hypermnesia-mcp_cortex__*).
 * The prefix carries both the plugin name and the server key; Cortex v4.15.0
 * renamed the plugin cortex -> hypermnesia-mcp and kept the server key cortex.
 */

import { z } from "zod";

// ─── recall ─────────────────────────────────────────────────────────────────

export const RecallRequestSchema = z.object({
  query: z.string(),
  domain: z.string().optional(),
  directory: z.string().optional(),
  agent_topic: z.string().optional(),
  max_results: z.number().int().min(1).max(50).default(10),
  min_heat: z.number().min(0).max(1).default(0.05),
});
export type RecallRequest = z.infer<typeof RecallRequestSchema>;

export const RecalledMemorySchema = z.object({
  memory_id: z.union([z.number(), z.string()]),
  content: z.string(),
  score: z.number(),
  heat: z.number().optional(),
  domain: z.string().optional(),
  created_at: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
});
export type RecalledMemory = z.infer<typeof RecalledMemorySchema>;

/**
 * Wire schema matches Cortex's canonical response keys (`memories`/`count`/
 * `intent`). The legacy `results`/`total` aliases were removed from Cortex
 * on 2026-06-10 — they byte-duplicated every memory on the wire (measured:
 * 815KB response for 15 memories, 50% pure duplication).
 *
 * The transform preserves this project's internal `{results, total}`
 * shape so downstream consumers (production-dispatcher, section-generation)
 * stay untouched.
 */
export const RecallResponseSchema = z
  .object({
    memories: z.array(RecalledMemorySchema),
    count: z.number().int().nonnegative(),
    intent: z.string().optional(),
  })
  .transform(({ memories, count, intent }) => ({
    results: memories,
    total: count,
    query_intent: intent,
  }));
export type RecallResponse = z.infer<typeof RecallResponseSchema>;

// ─── remember ───────────────────────────────────────────────────────────────

export const RememberRequestSchema = z.object({
  content: z.string(),
  tags: z.array(z.string()).default([]),
  source: z.string().optional(),
  domain: z.string().optional(),
});
export type RememberRequest = z.infer<typeof RememberRequestSchema>;

export const RememberResponseSchema = z.object({
  memory_id: z.union([z.number(), z.string()]),
  stored: z.boolean(),
});
export type RememberResponse = z.infer<typeof RememberResponseSchema>;

// ─── query_methodology ──────────────────────────────────────────────────────

export const QueryMethodologyRequestSchema = z.object({
  cwd: z.string().nullable().default(null),
  first_message: z.string().nullable().default(null),
  project: z.string().nullable().default(null),
});
export type QueryMethodologyRequest = z.infer<
  typeof QueryMethodologyRequestSchema
>;

// ─── codebase_analyze ───────────────────────────────────────────────────────

export const CodebaseAnalyzeRequestSchema = z.object({
  directory: z.string(),
  refresh: z.boolean().default(false),
});
export type CodebaseAnalyzeRequest = z.infer<typeof CodebaseAnalyzeRequestSchema>;

// ─── ingest_prd ─────────────────────────────────────────────────────────────

export const IngestPrdRequestSchema = z.object({
  prd_path: z.string(),
  domain: z.string().optional(),
});
export type IngestPrdRequest = z.infer<typeof IngestPrdRequestSchema>;
