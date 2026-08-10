// Contracts (type-only at consumer level; zod schemas exported for runtime use).
export * from "./contracts/codebase.js";
export * from "./contracts/memory.js";
export * from "./contracts/subagent.js";

// Transport
export {
  StdioMcpClient,
  type StdioMcpClientConfig,
} from "./transport/stdio-mcp-client.js";

// Clients
export {
  AiArchitectCodebaseClient,
  type AiArchitectCodebaseClientConfig,
} from "./clients/ai-architect-codebase-client.js";

export {
  CortexClient,
  type CortexClientConfig,
} from "./clients/cortex-client.js";

export {
  buildJudgePrompt,
  type BuiltJudgePrompt,
} from "./clients/judge-prompt.js";

export {
  HostQueueSubagentClient,
  type SubagentClient,
  type PendingInvocation,
  type PendingJudgeInvocation,
  type PendingFreeformInvocation,
} from "./clients/subagent-client.js";

// Re-export from core for backward compatibility (Phase 3+4 cross-audit
// closure — code-reviewer H1). New code should import from @prd-gen/core.
export { extractJsonObject } from "@prd-gen/core";
