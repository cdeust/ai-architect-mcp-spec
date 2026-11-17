// Judge selection
export {
  PANELS,
  selectJudges,
  getPanel,
  type JudgePanel,
} from "./judge-selector.js";

// Claim extraction
export {
  extractClaims,
  extractClaimsFromDocument,
} from "./claim-extractor.js";

// Claim verification tiering
export { classifyClaimTier, type ClaimTier } from "./claim-tier.js";
export {
  buildMechanicalVerdict,
  buildMechanicalVerdicts,
  RULE_TIER_JUDGE,
} from "./mechanical-verdict.js";

// Consensus
export {
  consensus,
  agentKey,
  type ConsensusVerdict,
  type ConsensusStrategy,
  type ConsensusConfig,
  type ReliabilityLookup,
} from "./consensus.js";

// Orchestrator
export {
  planSectionVerification,
  planDocumentVerification,
  concludeSection,
  concludeDocument,
  type VerificationPlan,
  type VerificationReport,
  type PlanOptions,
  type ConcludeOptions,
  type ClaimObservationFlushed,
  type ObservationFlusher,
} from "./orchestrator.js";

// Judge prompt construction
export {
  buildJudgePrompt,
  buildBatchedJudgePrompt,
  claimIdsInJudgePrompt,
  type BuiltJudgePrompt,
} from "./judge-prompt.js";
