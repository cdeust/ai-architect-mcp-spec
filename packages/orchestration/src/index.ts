// Re-export core domain types consumed by the benchmark layer.
// The benchmark must depend on orchestration, not directly on core (§2.2).
// source: B3 layer-compliance fix — Wave C integration.
export { type SectionType, SectionTypeSchema } from "@prd-gen/core";

// Types
export {
  PipelineStepSchema,
  SectionStatusSchema,
  ClarificationTurnSchema,
  PipelineStateSchema,
  newPipelineState,
  touch,
  appendError,
  MAX_CLARIFICATION_TURNS,
  MAX_PIPELINE_ERRORS,
  MAX_RESPONSE_CHARS,
  PostSpecsStateSchema,
  ImpactQueryResultSchema,
  initialPostSpecs,
  type PipelineStep,
  type SectionStatus,
  type ClarificationTurn,
  type PipelineState,
  type PostSpecsState,
  type ImpactQueryResult,
} from "./types/state.js";

export {
  AskUserActionSchema,
  CallPipelineToolActionSchema,
  CallCortexToolActionSchema,
  SpawnSubagentsActionSchema,
  WriteFileActionSchema,
  EmitMessageActionSchema,
  DoneActionSchema,
  DoneOutcomeSchema,
  FailedActionSchema,
  NextActionSchema,
  UserAnswerSchema,
  ToolResultSchema,
  SubagentBatchResultSchema,
  FileWrittenSchema,
  ActionResultSchema,
  type AskUserAction,
  type CallPipelineToolAction,
  type CallCortexToolAction,
  type SpawnSubagentsAction,
  type WriteFileAction,
  type EmitMessageAction,
  type DoneAction,
  type DoneOutcome,
  type FailedAction,
  type NextAction,
  type UserAnswer,
  type ToolResult,
  type SubagentBatchResult,
  type FileWritten,
  type ActionResult,
} from "./types/actions.js";

// Section plan
export {
  SECTIONS_BY_CONTEXT,
  SECTION_RECALL_TEMPLATES,
} from "./section-plan.js";

// Runner
export { step, type StepInput, type StepOutput, type StepHandler } from "./runner.js";

// Run store (bounded-I/O Phase 3: TTL + max-runs eviction of terminal runs)
export {
  InMemoryRunStore,
  type RunStore,
  type RunStoreOptions,
  type Clock,
  RUN_STORE_RESIDENT_CHAR_CEILING,
} from "./run-store.js";

// Section-generation constants (exported for benchmark layer — benchmark → orchestration direction per §2.2)
export { MAX_ATTEMPTS } from "./handlers/section-generation.js";

// Canned dispatcher (test/benchmark utility — not for production host wiring)
export {
  makeCannedDispatcher,
  type CannedDispatcher,
  type CannedDispatcherOptions,
} from "./canned-dispatcher.js";
export { defaultFakeSectionDraft } from "./canned-responses.js";

// Wave F2 — production-mode dispatcher (real subagents via AgentInvoker).
// Companion to makeCannedDispatcher; consumed by
// @prd-gen/benchmark calibrate-gates-production.ts.
export {
  makeProductionDispatcher,
  makeStubAgentInvoker,
  type AgentInvoker,
  type AgentInvocationRequest,
  type AgentInvocationResponse,
  type CortexRecallRequest,
  type CortexRecallResponse,
  type CortexRecallHit,
  type ProductionDispatcher,
  type ProductionDispatcherOptions,
  type StubAgentInvokerOptions,
} from "./production-dispatcher.js";
