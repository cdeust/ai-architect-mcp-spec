// Domain types
export {
  PRDContextSchema,
  PRD_CONTEXT_DEFAULT,
  PRD_CONTEXT_CONFIGS,
  type PRDContext,
  type PRDContextConfig,
} from "./domain/prd-context.js";

export {
  SectionTypeSchema,
  SECTION_DISPLAY_NAMES,
  SECTION_ORDER,
  type SectionType,
} from "./domain/section-type.js";

export {
  HardOutputRuleSchema,
  isCriticalRule,
  scorePenalty,
  isDeterministicRule,
  type HardOutputRule,
} from "./domain/hard-output-rule.js";

export {
  ThinkingStrategySchema,
  STRATEGY_TIERS,
  getStrategyTier,
  type ThinkingStrategy,
  type StrategyTier,
} from "./domain/thinking-strategy.js";

export {
  ClarificationAnswerSchema,
  ClarificationStateSchema,
  getAnswersByPriority,
  type ClarificationAnswer,
  type ClarificationState,
} from "./domain/clarification.js";

export {
  VerdictSchema,
  EXPECTED_VERDICT_DISTRIBUTION,
  isDistributionSuspicious,
  type Verdict,
} from "./domain/verdict.js";

export {
  CAPABILITIES,
  type Capabilities,
} from "./domain/capabilities.js";

export {
  PRDSectionSchema,
  PRDDocumentSchema,
  type PRDSection,
  type PRDDocument,
} from "./domain/prd-document.js";

export {
  HardOutputRuleViolationSchema,
  isBlockingViolation,
  ValidationReportSchema,
  CrossRefValidationResultSchema,
  type HardOutputRuleViolation,
  type ValidationReport,
  type CrossRefValidationResult,
} from "./domain/validation-result.js";

export {
  ChangeKindSchema,
  AffectedSymbolSchema,
  ScopeClaimSchema,
  AffectedSymbolsDocumentSchema,
  AFFECTED_SYMBOLS_MARKER,
  parseAffectedSymbolsBlock,
  stripAffectedSymbolsBlock,
  type ChangeKind,
  type AffectedSymbol,
  type ScopeClaim,
  type AffectedSymbolsDocument,
} from "./domain/affected-symbols.js";

// Agent / judge domain
export {
  GeniusAgentSchema,
  TeamAgentSchema,
  AgentIdentitySchema,
  agentSubagentType,
  ExternalGroundingTypeSchema,
  ClaimSchema,
  JudgeVerdictSchema,
  JudgeRequestSchema,
  SubagentInvocationSchema,
  SubagentResponseSchema,
  type GeniusAgent,
  type TeamAgent,
  type AgentIdentity,
  type ExternalGroundingType,
  type Claim,
  type JudgeVerdict,
  type JudgeRequest,
  type SubagentInvocation,
  type SubagentResponse,
} from "./domain/agent.js";

// Utils
export { extractJsonObject } from "./utils/json-extract.js";

// Persistence
export {
  EvidenceRepository,
  tryCreateEvidenceRepository,
  MAX_EVIDENCE_ROWS,
  type StrategyExecution,
  type PRDQualityScore,
  type AdaptiveThreshold,
  type StrategyPerformanceSummary,
} from "./persistence/evidence-repository.js";

// Reliability persistence — port (interface + types only; no SQLite import)
export {
  RELIABILITY_SCHEMA_VERSION,
  DEFAULT_RELIABILITY_PRIOR,
  RELIABILITY_PRIOR_ESS,
  type BetaParamsCore,
  type ReliabilityRepository,
  type JudgeReliabilityRecord,
  type ReliabilityObservation,
  type VerdictDirection,
} from "./persistence/reliability-repository.js";

// Reliability persistence — SQLite adapter (infrastructure; optional native dep)
export {
  SqliteReliabilityRepository,
  tryCreateReliabilityRepository,
} from "./persistence/sqlite-reliability-repository.js";

// Consensus reliability port — core declares, benchmark implements, verification consumes.
export type { ConsensusReliabilityProvider } from "./persistence/consensus-reliability-provider.js";
