import { z } from "zod";

/**
 * PRD context types — ported from PRDContext.swift.
 * Each context type configures clarification depth, RAG hops, section count,
 * and strategy tier preference. These ranges are load-bearing quality drivers
 * calibrated from production use.
 */
export const PRDContextSchema = z.enum([
  "proposal",
  "feature",
  "bug",
  "incident",
  "poc",
  "mvp",
  "release",
  "cicd",
]);

export type PRDContext = z.infer<typeof PRDContextSchema>;

export const PRD_CONTEXT_DEFAULT: PRDContext = "feature";

export interface PRDContextConfig {
  readonly displayName: string;
  readonly description: string;
  readonly clarificationRange: readonly [min: number, max: number];
  readonly ragMaxHops: number;
  readonly expectedSectionCount: number;
  readonly preferredStrategyTier: number;
}

/**
 * Context-aware configuration — exact values from PRDContext.swift.
 * These numbers are production-calibrated. Do not change without benchmarking.
 */
export const PRD_CONTEXT_CONFIGS: Record<PRDContext, PRDContextConfig> = {
  proposal: {
    displayName: "Proposal",
    description:
      "High-level, stakeholder-facing PRD focused on business value and ROI",
    clarificationRange: [5, 6],
    ragMaxHops: 1,
    expectedSectionCount: 7,
    preferredStrategyTier: 2,
  },
  feature: {
    displayName: "Feature",
    description:
      "Implementation-ready PRD with deep technical specifications",
    clarificationRange: [8, 10],
    ragMaxHops: 3,
    expectedSectionCount: 11,
    preferredStrategyTier: 1,
  },
  bug: {
    displayName: "Bug Fix",
    description:
      "Root cause analysis PRD focused on targeted fix and regression prevention",
    clarificationRange: [6, 8],
    ragMaxHops: 3,
    expectedSectionCount: 6,
    preferredStrategyTier: 1,
  },
  incident: {
    displayName: "Incident",
    description:
      "Forensic investigation PRD for urgent response and mitigation",
    clarificationRange: [10, 12],
    ragMaxHops: 4,
    expectedSectionCount: 8,
    preferredStrategyTier: 1,
  },
  poc: {
    displayName: "Proof of Concept",
    description:
      "Technical feasibility validation PRD with minimal scope",
    clarificationRange: [4, 5],
    ragMaxHops: 2,
    expectedSectionCount: 5,
    preferredStrategyTier: 3,
  },
  mvp: {
    displayName: "MVP",
    description:
      "Minimum viable product PRD focused on core value and fast delivery",
    clarificationRange: [6, 7],
    ragMaxHops: 2,
    expectedSectionCount: 8,
    preferredStrategyTier: 2,
  },
  release: {
    displayName: "Release",
    description:
      "Production release PRD with full documentation and migration guides",
    clarificationRange: [9, 11],
    ragMaxHops: 3,
    expectedSectionCount: 10,
    preferredStrategyTier: 1,
  },
  cicd: {
    displayName: "CI/CD Pipeline",
    description:
      "CI/CD pipeline PRD with automation stages, testing, and deployment flows",
    clarificationRange: [7, 9],
    ragMaxHops: 3,
    expectedSectionCount: 9,
    preferredStrategyTier: 1,
  },
} as const;
