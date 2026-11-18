/**
 * Per-context section list — which sections each PRD type produces, in order.
 *
 * Section counts match PRD_CONTEXT_CONFIGS.expectedSectionCount in core.
 * Lists are derived from the workflow described in SKILL.md and the section
 * focus of each context type. Tune by use, not by guess.
 */

import {
  effectiveRequestSize,
  requestSizePlan,
  type PRDContext,
  type RequestSize,
  type SectionType,
} from "@prd-gen/core";

export const SECTIONS_BY_CONTEXT: Record<PRDContext, readonly SectionType[]> = {
  proposal: [
    "overview",
    "goals",
    "requirements",
    "user_stories",
    "acceptance_criteria",
    "timeline",
    "risks",
  ],
  feature: [
    "overview",
    "goals",
    "requirements",
    "user_stories",
    "technical_specification",
    "acceptance_criteria",
    "data_model",
    "api_specification",
    "security_considerations",
    "performance_requirements",
    "testing",
  ],
  bug: [
    "overview",
    "requirements",
    "technical_specification",
    "acceptance_criteria",
    "testing",
    "deployment",
  ],
  incident: [
    "overview",
    "requirements",
    "technical_specification",
    "acceptance_criteria",
    "security_considerations",
    "testing",
    "deployment",
    "risks",
  ],
  poc: [
    "overview",
    "goals",
    "requirements",
    "technical_specification",
    "acceptance_criteria",
  ],
  mvp: [
    "overview",
    "goals",
    "requirements",
    "user_stories",
    "technical_specification",
    "acceptance_criteria",
    "testing",
    "timeline",
  ],
  release: [
    "overview",
    "goals",
    "requirements",
    "technical_specification",
    "acceptance_criteria",
    "security_considerations",
    "performance_requirements",
    "testing",
    "deployment",
    "timeline",
  ],
  cicd: [
    "overview",
    "goals",
    "requirements",
    "technical_specification",
    "acceptance_criteria",
    "security_considerations",
    "testing",
    "deployment",
    "timeline",
  ],
} as const;

/**
 * postcondition: the sections a run writes, in order: those of its effective
 *                size when that size names them (the fast path of #119),
 *                else those of its kind. The one place that answers "which
 *                sections does this run have": generation and export both
 *                read it.
 */
export function plannedSections(context: PRDContext, size: RequestSize): readonly SectionType[] {
  return requestSizePlan(context, size)?.sections ?? SECTIONS_BY_CONTEXT[context];
}

/**
 * postcondition: the size the run is held to, for what the run says of
 *                itself (its summaries, its files): the declared size when
 *                its plan applies to the kind of the run, `standard`
 *                otherwise; the declared size while the kind is not known.
 */
export function runRequestSize(state: { prd_context: PRDContext | null; request_size: RequestSize }): RequestSize {
  // Stryker disable next-line ConditionalExpression: equivalent: no plan of a size exempts an unknown kind, so both branches give the declared size
  return state.prd_context === null ? state.request_size : effectiveRequestSize(state.prd_context, state.request_size);
}

/**
 * Section-specific Cortex recall query templates.
 * Mirror the table in SKILL.md "Section-Adaptive Retrieval via Cortex".
 */
export const SECTION_RECALL_TEMPLATES: Record<SectionType, string> = {
  overview:
    "high-level architecture domain context for {feature}",
  goals:
    "business goals success metrics KPIs for {feature}",
  requirements:
    "public API surfaces exports interfaces contracts for {feature}",
  user_stories:
    "user flows personas use cases for {feature}",
  technical_specification:
    "architecture patterns module structure dependencies for {feature}",
  acceptance_criteria:
    "test scenarios validation rules edge cases for {feature}",
  data_model:
    "database schema tables relationships data types for {feature}",
  api_specification:
    "REST GraphQL endpoints routes handlers middleware for {feature}",
  security_considerations:
    "authentication authorization encryption validation secrets for {feature}",
  performance_requirements:
    "latency throughput caching scalability targets for {feature}",
  testing:
    "test patterns fixtures assertions coverage for {feature}",
  deployment:
    "deployment configuration infrastructure CI/CD environments for {feature}",
  risks:
    "error handling edge cases failure modes risks for {feature}",
  timeline:
    "milestones phases release schedule for {feature}",
  source_code:
    "implementation source code patterns for {feature}",
  test_code:
    "test code patterns assertions for {feature}",
  // jira_tickets is generated from the PRD itself, not from a Cortex query.
  jira_tickets: "",
};
