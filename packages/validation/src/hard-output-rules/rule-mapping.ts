import type { HardOutputRule, SectionType } from "@prd-gen/core";

/**
 * Maps SectionType to applicable HardOutputRules.
 * Ported from HardOutputRuleMapping.swift.
 */
const SECTION_RULES: Record<SectionType, readonly HardOutputRule[]> = {
  requirements: [
    "sp_not_in_fr_table",
    "fr_traceability",
    "no_self_referencing_deps",
    "duplicate_requirement_ids",
    "fr_numbering_gaps",
  ],
  user_stories: ["no_self_referencing_deps"],
  technical_specification: [
    // Architecture & Code Quality (18-24)
    "clean_architecture",
    "no_any_codable",
    "code_example_port_compliance",
    "generic_over_specific",
    "no_nested_types",
    "single_responsibility",
    "explicit_access_control",
    "factory_based_injection",
    "solid_compliance",
    "code_reusability",
    // Security (25-32)
    "no_hardcoded_secrets",
    "input_validation_required",
    "output_encoding_injection_prevention",
    "auth_on_every_endpoint",
    "security_safe_error_handling",
    "cryptographic_standards",
    "rate_limiting_required",
    "secure_communication",
    // Data Protection (33-38)
    "data_classification_required",
    "sensitive_data_protection",
    "no_sensitive_data_in_logs",
    "data_minimization",
    "audit_trail_required",
    "consent_and_erasure_support",
    // Error Handling & Resilience (39-43)
    "structured_error_handling",
    "resilience_patterns",
    "graceful_degradation",
    "transaction_boundaries",
    "consistent_error_format",
    // Concurrency (44-46)
    "concurrency_safety",
    "immutability_by_default",
    "atomic_operations",
    // Senior Code Quality (47-52)
    "no_magic_numbers",
    "defensive_coding",
    "method_size_limits",
    "consistent_naming",
    "api_contract_documentation",
    "deprecation_strategy",
    // Observability (59-62)
    "structured_logging",
    "distributed_tracing",
    "no_pii_in_observability",
    "alerting_thresholds",
    // Dependencies (63-64)
    "dependency_vulnerability_scanning",
    "minimal_dependency_principle",
  ],
  data_model: [
    "no_orphan_ddl",
    "no_now_in_partial_indexes",
    "no_any_codable",
    "fk_references_exist",
    "data_classification_required",
    "sensitive_data_protection",
    "consent_and_erasure_support",
  ],
  api_specification: [
    "no_any_codable",
    "auth_on_every_endpoint",
    "rate_limiting_required",
    "consistent_error_format",
    "api_contract_documentation",
    "deprecation_strategy",
  ],
  security_considerations: [
    "no_hardcoded_secrets",
    "input_validation_required",
    "output_encoding_injection_prevention",
    "auth_on_every_endpoint",
    "security_safe_error_handling",
    "cryptographic_standards",
    "rate_limiting_required",
    "secure_communication",
    "data_classification_required",
    "sensitive_data_protection",
    "no_sensitive_data_in_logs",
    "data_minimization",
    "audit_trail_required",
    "consent_and_erasure_support",
  ],
  testing: [
    "no_placeholder_tests",
    "test_traceability_integrity",
    "mandatory_test_coverage",
    "security_testing_required",
    "performance_testing_required",
    "no_production_data_in_tests",
    "edge_case_negative_tests",
    "test_isolation",
  ],
  timeline: [
    "sp_arithmetic",
    "uneven_sp_distribution",
    "no_self_referencing_deps",
  ],
  deployment: [
    "sp_arithmetic",
    "ac_numbering",
    "deployment_rollback_plan",
    "structured_logging",
    "distributed_tracing",
    "no_pii_in_observability",
    "alerting_thresholds",
  ],
  acceptance_criteria: ["ac_numbering"],
  performance_requirements: ["honest_verification_verdicts"],
  risks: ["risk_mitigation_completeness"],
  overview: [],
  goals: [],
  source_code: [],
  test_code: [],
  // jira_tickets is a synthetic bucket emitted by jira-generation; its
  // rules apply to the source sections (requirements / acceptance_criteria),
  // not to the JIRA markdown itself.
  jira_tickets: [],
};

export function rulesForSection(sectionType: SectionType): HardOutputRule[] {
  return [...SECTION_RULES[sectionType]];
}

/**
 * Rules that must be validated across the entire document (cross-section).
 *
 * This list DRIVES `validateDocument`'s cross-section pass: every member must
 * have an entry in DOCUMENT_LEVEL_CHECKS (hard-output-rules/index.ts), which
 * is a total Record over this tuple. A rule declared here without a checker is
 * a compile error, and adding one requires no edit to the dispatch loop
 * (coding-standards §1.2 OCP).
 *
 * `no_self_referencing_deps` is deliberately ABSENT: it is a section rule
 * (mapped above for requirements / user_stories / timeline). Both of its
 * patterns are line-anchored — the prose pattern forbids `\n` between the two
 * ID occurrences and the table pattern is `^…` under /gm — so joining sections
 * cannot surface a violation the per-section pass missed. Cross-section
 * dependency CYCLES are a different property, covered by
 * validateCrossReferences (`cycles`), not by this rule.
 */
export const DOCUMENT_LEVEL_RULES = [
  "sp_arithmetic",
  "ac_numbering",
  "honest_verification_verdicts",
  "test_traceability_integrity",
  "fr_to_ac_coverage",
  "ac_to_test_coverage",
  "dependency_targets_defined",
] as const satisfies readonly HardOutputRule[];

/** A rule carried by DOCUMENT_LEVEL_RULES. */
export type DocumentLevelRule = (typeof DOCUMENT_LEVEL_RULES)[number];
