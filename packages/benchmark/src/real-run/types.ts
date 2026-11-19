import type { PRDContext, RequestSize } from "@prd-gen/core";
import type { AskUserAction, DoneAction, FailedAction, SpawnSubagentsAction, UserAnswer } from "@prd-gen/orchestration";

export type Purpose = SpawnSubagentsAction["purpose"];
export type Invocation = SpawnSubagentsAction["invocations"][number] & { purpose: Purpose };
export interface Settings {
  model: string;
  effort: NonNullable<Invocation["effort"]> | "session";
}
export interface Limits {
  max_invocations: number;
  max_cost_usd: number;
  max_steps: number;
}
export interface Stopped {
  kind: "stopped";
  reason: keyof Limits;
}
export interface RunPlan {
  limits: Limits;
  description: string;
  prd_context: PRDContext;
  request_size: RequestSize;
  policy: "as-emitted" | Partial<Record<Purpose, Settings>>;
  mode: "sequential" | "parallel";
  answers: Record<string, Pick<UserAnswer, "selected" | "freeform">>;
}
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number | null;
  duration_ms: number;
  model_reported: string;
}
export interface Ports {
  invoke(invocation: Invocation, settings: Settings): Promise<{ text: string; usage: Usage; error?: string }>;
  record(row: Row): void | Promise<void>;
  clock(): number;
  answer(question: AskUserAction): UserAnswer;
}
export interface Row {
  batch_id: string;
  invocation_id: string;
  purpose: Purpose;
  agent_type: string;
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
  cost_usd: number | null;
}
export interface RunRecord {
  rows: Row[];
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
