/**
 * Pipeline capabilities — single, unconditional capability set.
 *
 * Replaces the former tier-based gating (free / trial / licensed) that was
 * carried over from the Swift port. The TS rewrite has no licensing model;
 * every run gets the full feature set.
 *
 * source: removal of license-tier system, 2026-04. The values match the
 * previous "licensed" tier exactly, so no behaviour changes for callers
 * that already ran at full capability.
 */

import type { ThinkingStrategy } from "./thinking-strategy.js";
import type { PRDContext } from "./prd-context.js";

export interface Capabilities {
  readonly maxStrategies: number;
  readonly allowedStrategies: readonly ThinkingStrategy[];
  readonly maxClarificationRounds: number;
  readonly allowedContextTypes: readonly PRDContext[];
  readonly maxSections: number;
  readonly verificationLevel: "basic" | "full";
}

export const CAPABILITIES: Capabilities = {
  // source: matches allowedStrategies.length below.
  maxStrategies: 16,
  allowedStrategies: [
    "chain_of_thought",
    "tree_of_thoughts",
    "graph_of_thoughts",
    "react",
    "reflexion",
    "plan_and_solve",
    "verified_reasoning",
    "recursive_refinement",
    "problem_analysis",
    "zero_shot",
    "few_shot",
    "self_consistency",
    "generate_knowledge",
    "prompt_chaining",
    "multimodal_cot",
    "meta_prompting",
  ],
  maxClarificationRounds: Infinity,
  allowedContextTypes: [
    "proposal",
    "feature",
    "bug",
    "incident",
    "poc",
    "mvp",
    "release",
    "cicd",
  ],
  maxSections: 11,
  verificationLevel: "full",
} as const;
