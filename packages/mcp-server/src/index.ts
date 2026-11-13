#!/usr/bin/env node

import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRD_CONTEXT_CONFIGS,
  CAPABILITIES,
  STRATEGY_TIERS,
  SectionTypeSchema,
  type PRDContext,
} from "@prd-gen/core";

import { getEvidenceRepo } from "./evidence-db-path.js";

import { validateSection, validateDocument } from "@prd-gen/validation";
import { KnownSymbolsSchema, withSymbolCheck } from "./symbol-check.js";
import { REPORT_PAGING_DESCRIPTION, reportPageResult } from "./page-validation-report.js";
import { registerBudgetTools } from "./budget-tools.js";
import { registerPipelineTools } from "./pipeline-tools.js";
import { registerPrompts, PROMPT_STEP_TOOLS } from "./mcp-prompts.js";
import {
  resolveProfile,
  instructions as profileInstructions,
  isAllowed,
  type ToolProfile,
} from "./tool-profiles.js";
import {
  checkReliabilityHealth,
  closeReliabilityRepo,
} from "./reliability-wiring.js";
import { resolveServerVersion } from "./server-version.js";
import { healthStatus } from "./health-status.js";
import { resolvePluginRoot } from "./plugin-root.js";

// ─── Reliability wiring (D2.4 / D2.6) ───────────────────────────────────────
// Re-exported so pipeline-tools and other callers can inject the provider into
// ConsensusConfig.reliabilityProvider without importing benchmark directly.
export { getConsensusReliabilityProvider } from "./reliability-wiring.js";

/**
 * PRD Generator MCP Server — native TypeScript.
 *
 * 17 tools: 5 diagnostics + 2 validation + 2 evidence + 8 pipeline/verification/budget.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config Loading ──────────────────────────────────────────────────────────

const PLUGIN_ROOT = resolvePluginRoot(__dirname, process.env);

// Marks the fallback config. The fallback also carries `version`, so
// check_health tests this marker, not `version` (#124).
const CONFIG_NOT_FOUND = "config_not_found";

function loadSkillConfig(): Record<string, unknown> {
  const configPaths = [
    process.env.PRD_GEN_SKILL_CONFIG,
    join(PLUGIN_ROOT, "skill-config.json"),
    join(PLUGIN_ROOT, "packages", "skill", "skill-config.json"),
  ].filter(Boolean) as string[];

  for (const p of configPaths) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8"));
    }
  }

  return { version: "2.0.0", status: CONFIG_NOT_FOUND };
}

function loadSkillMd(): string {
  const skillPaths = [join(PLUGIN_ROOT, "packages", "skill", "SKILL.md")];

  for (const p of skillPaths) {
    if (existsSync(p)) {
      return readFileSync(p, "utf-8");
    }
  }

  return "SKILL.md not found";
}

// ─── Server Setup ────────────────────────────────────────────────────────────

// Active tool profile (issue #28). Resolved once at startup from --profile /
// PRD_GEN_PROFILE, defaulting to `full`. The portable host manifests select the
// narrow `verifier` profile explicitly; Claude passes no profile and therefore
// retains the default. Shrinking that default would be a breaking change — see
// tool-profiles.ts + CHANGELOG.md.
const ACTIVE_PROFILE: ToolProfile = resolveProfile(process.argv.slice(2), process.env);

const server = new McpServer(
  {
    name: "prd-gen",
    // Read from the shipped package.json, never written down here — the
    // literal that used to sit on this line drifted to 0.4.0 while the
    // released artifact was 0.6.1. See server-version.ts.
    version: resolveServerVersion(__dirname, PLUGIN_ROOT),
  },
  {
    // Per-profile initialize instructions (issue #28 criterion 4).
    instructions: profileInstructions(ACTIVE_PROFILE),
  },
);

// resources/list interop shim (issue #28 criterion 6). The MCP TS SDK only
// answers resources/list once a resource is registered; with none registered
// it returns -32601, which some clients surface as a failed connection
// regardless of declared capabilities (CBM upstream #958). We register the
// resources capability and empty list handlers so probing clients get an
// interoperable empty answer. Rationale recorded here at the use site per §8.
// source: DeusData/codebase-memory-mcp src/mcp/mcp.c:10810-10816 (#958).
server.server.registerCapabilities({ resources: {} });
server.server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
  resourceTemplates: [],
}));

// ─── Tool 1: get_config ──────────────────────────────────────────────────────

const toolGetConfig = server.tool(
  "get_config",
  "Get the full skill configuration",
  {},
  { readOnlyHint: true },
  async () => {
    const config = loadSkillConfig();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(config, null, 2) }],
    };
  },
);

// ─── Tool 2: read_skill_config ───────────────────────────────────────────────

const toolReadSkillConfig = server.tool(
  "read_skill_config",
  "Read the SKILL.md content that drives PRD generation",
  {},
  { readOnlyHint: true },
  async () => {
    const skillMd = loadSkillMd();
    return {
      content: [{ type: "text" as const, text: skillMd }],
    };
  },
);

// ─── Tool 3: check_health ────────────────────────────────────────────────────

const toolCheckHealth = server.tool(
  "check_health",
  "Check system health — verify all components are accessible",
  {},
  { readOnlyHint: true },
  async () => {
    const configAvailable = loadSkillConfig().status !== CONFIG_NOT_FOUND;
    const skillAvailable = loadSkillMd() !== "SKILL.md not found";

    let dbHealthy = false;
    try {
      const repo = getEvidenceRepo();
      if (repo) {
        repo.getQualityHistory(1);
        dbHealthy = true;
      }
    } catch {
      dbHealthy = false;
    }

    const components = { configAvailable, skillAvailable, evidenceDbHealthy: dbHealthy };
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ...healthStatus(components),
              ...components,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool 4: get_prd_context_info ────────────────────────────────────────────

const toolGetPrdContextInfo = server.tool(
  "get_prd_context_info",
  "Get configuration for a specific PRD context type",
  {
    context: z
      .enum([
        "proposal",
        "feature",
        "bug",
        "incident",
        "poc",
        "mvp",
        "release",
        "cicd",
      ])
      .describe("The PRD context type"),
  },
  { readOnlyHint: true },
  async ({ context }) => {
    const config = PRD_CONTEXT_CONFIGS[context as PRDContext];
    return {
      content: [{ type: "text" as const, text: JSON.stringify(config, null, 2) }],
    };
  },
);

// ─── Tool 5: list_available_strategies ───────────────────────────────────────

const toolListStrategies = server.tool(
  "list_available_strategies",
  "List thinking strategies available to the pipeline.",
  {},
  { readOnlyHint: true },
  async () => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              strategies: CAPABILITIES.allowedStrategies,
              tiers: STRATEGY_TIERS,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool 6: validate_prd_section ────────────────────────────────────────────

/** Page of a validation report: see page-validation-report.ts (#125). */
const ItemOffsetSchema = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Index of the first report item (violations, then unresolved symbols) of the page to return");

const toolValidateSection = server.tool(
  "validate_prd_section",
  "Run deterministic Hard Output Rules validation on a single PRD section. Returns violations found — zero LLM calls, pure regex/parsing." +
    REPORT_PAGING_DESCRIPTION,
  {
    content: z.string().describe("The markdown content of the PRD section"),
    section_type: SectionTypeSchema.describe(
      "The type of PRD section being validated",
    ),
    known_symbols: KnownSymbolsSchema,
    item_offset: ItemOffsetSchema,
  },
  { readOnlyHint: true },
  async ({ content, section_type, known_symbols, item_offset }) => {
    // section_type is already validated by SectionTypeSchema at the MCP
    // boundary above. No cast required (cross-audit code-reviewer H5,
    // Phase 3+4, 2026-04).
    const report = withSymbolCheck(validateSection(content, section_type), content, known_symbols);
    // Paged under MAX_RESPONSE_CHARS (#125). source: page-validation-report.ts.
    return reportPageResult(report, item_offset);
  },
);

// ─── Tool 7: validate_prd_document ───────────────────────────────────────────

const toolValidateDocument = server.tool(
  "validate_prd_document",
  "Run full document validation including cross-section checks (SP arithmetic, AC numbering, FR-AC coverage, test traceability). Returns comprehensive validation report." +
    REPORT_PAGING_DESCRIPTION,
  {
    sections: z
      .array(
        z.object({
          // Validate at MCP boundary so the cast at the call site is
          // unnecessary. Pre-fix: `z.string()` + `s.type as SectionType`.
          // Cross-audit code-reviewer H5 (Phase 3+4, 2026-04).
          type: SectionTypeSchema.describe("Section type"),
          content: z.string().describe("Section content"),
        }),
      )
      .describe("Array of PRD sections to validate"),
    known_symbols: KnownSymbolsSchema,
    item_offset: ItemOffsetSchema,
  },
  { readOnlyHint: true },
  async ({ sections, known_symbols, item_offset }) => {
    const contents = sections.map((s) => s.content);
    const report = withSymbolCheck(validateDocument(sections), contents, known_symbols);
    // Paged under MAX_RESPONSE_CHARS (#125). source: page-validation-report.ts.
    return reportPageResult(report, item_offset);
  },
);

// ─── Tool 8: get_quality_history ─────────────────────────────────────────────

const toolQualityHistory = server.tool(
  "get_quality_history",
  "Get historical PRD quality scores from the evidence repository",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(20)
      .describe("Maximum number of records to return"),
  },
  { readOnlyHint: true },
  async ({ limit }) => {
    const repo = getEvidenceRepo();
    if (!repo) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Evidence repository unavailable (better-sqlite3 not loaded, or the database could not be opened; see stderr)",
            }),
          },
        ],
        isError: true,
      };
    }
    const history = repo.getQualityHistory(limit);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(history, null, 2) },
      ],
    };
  },
);

// ─── Tool 9: get_strategy_effectiveness ──────────────────────────────────────

const toolStrategyEffectiveness = server.tool(
  "get_strategy_effectiveness",
  "Get strategy performance data — actual vs expected improvement, compliance rate",
  {
    min_executions: z
      .number()
      .int()
      .min(1)
      .default(5)
      .describe("Minimum executions required to include a strategy"),
  },
  { readOnlyHint: true },
  async ({ min_executions }) => {
    const repo = getEvidenceRepo();
    if (!repo) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Evidence repository unavailable (better-sqlite3 not loaded, or the database could not be opened; see stderr)",
            }),
          },
        ],
        isError: true,
      };
    }
    const performance = repo.getStrategyPerformance(min_executions);
    const adjustments = repo.getHistoricalAdjustments(min_executions);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              performance,
              adjustments: Object.fromEntries(adjustments),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Budget + feedback tools (extracted to budget-tools.ts) ──────────────────

const budgetHandles = registerBudgetTools(server);

// Legacy tools (initialize_pipeline / update_pipeline_state) were removed
// in v3.0.0. The pipeline tools (start_pipeline / submit_action_result /
// get_pipeline_state, registered below via registerPipelineTools) are the
// canonical surface.

// ─── Pipeline / verification tools (orchestration + verification) ────────────

const pipelineHandles = registerPipelineTools(server);

// ─── Prompts + profile enforcement (issue #28) ───────────────────────────────
//
// Every registered tool by name — one map, the single source of truth for both
// the prompt step summaries (criterion 2) and the profile gate (criterion 5).
const ALL_TOOL_HANDLES: Record<string, RegisteredTool> = {
  get_config: toolGetConfig,
  read_skill_config: toolReadSkillConfig,
  check_health: toolCheckHealth,
  get_prd_context_info: toolGetPrdContextInfo,
  list_available_strategies: toolListStrategies,
  validate_prd_section: toolValidateSection,
  validate_prd_document: toolValidateDocument,
  get_quality_history: toolQualityHistory,
  get_strategy_effectiveness: toolStrategyEffectiveness,
  ...budgetHandles,
  ...pipelineHandles,
};

// Prompt bodies pull each step's one-line summary from the live tool
// description — the same schema tools/list advertises, never a hand-copy.
const promptHandles = registerPrompts(
  server,
  (toolName) => ALL_TOOL_HANDLES[toolName]?.description,
);

// Apply the active profile: disable (hide AND reject-on-call) every tool the
// profile excludes, and every prompt that drives an excluded tool. `.disable()`
// removes the tool from tools/list AND makes tools/call throw — a hidden tool
// is not merely absent from the list, it is rejected on call (criterion 5).
// Under `full` this loop is a no-op.
if (ACTIVE_PROFILE !== "full") {
  for (const [name, handle] of Object.entries(ALL_TOOL_HANDLES)) {
    if (!isAllowed(ACTIVE_PROFILE, name)) handle.disable();
  }
  for (const [name, handle] of Object.entries(promptHandles)) {
    const steps = PROMPT_STEP_TOOLS[name] ?? [];
    if (!steps.every((tool) => isAllowed(ACTIVE_PROFILE, tool))) handle.disable();
  }
}

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  // D2.6 — reliability DB health check at startup.
  // FAILS_ON: better-sqlite3 missing, schema_version mismatch, file locked.
  // A failed health check is NOT fatal — consensus falls back to the Beta(7,3)
  // prior for all cells, preserving backward-compat (pre-Wave-D behaviour).
  const reliabilityHealth = checkReliabilityHealth();
  if (!reliabilityHealth.healthy) {
    console.error(
      `[prd-gen] reliability.db health check FAILED: ${reliabilityHealth.message}`,
    );
    // Log only; do not exit. Degraded mode (prior fallback) is acceptable.
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP server failed to start:", error);
  process.exit(1);
});

// ─── Graceful shutdown — release DB connections (Wave D2.C teardown) ─────────
// source: Wave D2.C step 4 — "Add a teardown path: repository.close() on graceful shutdown."
process.on("SIGTERM", () => {
  closeReliabilityRepo();
  process.exit(0);
});
process.on("SIGINT", () => {
  closeReliabilityRepo();
  process.exit(0);
});
