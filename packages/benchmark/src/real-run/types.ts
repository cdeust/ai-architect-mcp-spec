import type { PRDContext, RequestSize } from "@prd-gen/core";
import type { DoneAction, FailedAction, SectionStatus, SpawnSubagentsAction, UserAnswer } from "@prd-gen/orchestration";

export type Purpose = SpawnSubagentsAction["purpose"];
export type Invocation = SpawnSubagentsAction["invocations"][number] & { purpose: Purpose };
export interface Settings {
  model: string;
  effort: NonNullable<Invocation["effort"]> | "session";
}
export interface Limits {
  max_invocations: number;
  max_cost_usd: number;
  max_unmetered_calls: number;
  max_steps: number;
}
export interface Stopped {
  kind: "stopped";
  reason: keyof Limits | `unregistered question: ${string}`;
}
export interface RunPlan {
  limits: Limits;
  call_timeout_ms: number;
  description: string;
  prd_context: PRDContext;
  request_size: RequestSize;
  policy: "as-emitted" | Partial<Record<Purpose, Settings>>;
  mode: "sequential" | "parallel";
  answers: Record<string, Pick<UserAnswer, "selected" | "freeform">>;
}
export interface Usage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  per_model?: Record<string, Partial<Record<"inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "costUSD", number>>>;
  duration_ms: number | null;
  model_reported: string;
}
export interface Ports {
  invoke(invocation: Invocation, settings: Settings, row: Row): Promise<{ text: string; usage: Usage | null; error?: string }>;
  abortBatch?(): void;
  record(row: Row): void | Promise<void>;
  clock(): number;
}
export interface Row {
  workspace_kept: boolean;
  /** Absolute physical path of the retained workspace, with symlinks resolved. */
  workspace_path?: string;
  workspace_removal_error?: string;
  notes?: string[];
  batch_id: string;
  invocation_id: string;
  purpose: Purpose;
  agent_type: string;
  isolation: Invocation["isolation"];
  prompt_characters: number;
  requested: { model: string | null; effort: string | null };
  used: Settings;
  usage: Usage | null;
  error: string | null;
}
export interface Totals {
  invocations: number;
  errors: number;
  unmetered_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  duration_ms: number;
  cost_usd: number;
}
export interface RunRecord {
  measurement_scope: string;
  rows: Row[];
  section_content: { count: number; total_characters: number; min_characters: number | null; has_duplicates: boolean };
  sections: (Pick<SectionStatus, "section_type" | "status" | "attempt" | "violation_count"> & {
    content: string | null;
  })[];
  totals: Totals;
  per_purpose: Partial<Record<Purpose, Totals>>;
  batches: number;
  steps: number;
  wall_time_ms: number;
  terminal: DoneAction | FailedAction | Stopped;
  quality: {
    outcome: DoneAction["outcome"] | null;
    hard_output_score: number | null;
    distribution: NonNullable<DoneAction["verification"]>["distribution"] | null;
  };
}
