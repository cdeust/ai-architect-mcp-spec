import { z } from "zod";

/**
 * The Hard Output Rules, first ported from HardOutputRule.swift; #118 added
 * `dependency_targets_defined`, `measurable_requirements`,
 * `testable_acceptance_criteria` and `contradictory_requirements`. The count
 * is `HardOutputRuleSchema.options.length`; neither it nor the position of a
 * rule is written by hand here, since both drifted when rules were added.
 * These are the #1 quality driver in the system (per Feynman/Ginzburg audit).
 * Each rule was added to fix a specific LLM failure mode observed in production.
 * Do not remove any rule without benchmarking the impact.
 */
export const HardOutputRuleSchema = z.enum([
  // Core PRD Rules
  "sp_arithmetic",
  "no_self_referencing_deps",
  "ac_numbering",
  "no_orphan_ddl",
  "no_now_in_partial_indexes",
  "no_any_codable",
  "no_placeholder_tests",
  "sp_not_in_fr_table",
  "uneven_sp_distribution",
  "metrics_disclaimer",
  "fr_traceability",
  "clean_architecture",
  "post_generation_self_check",
  "mandatory_codebase_analysis",
  "honest_verification_verdicts",
  "code_example_port_compliance",
  "test_traceability_integrity",
  "duplicate_requirement_ids",
  "fr_to_ac_coverage",
  "ac_to_test_coverage",
  "fk_references_exist",
  "fr_numbering_gaps",
  "risk_mitigation_completeness",
  "deployment_rollback_plan",
  "dependency_targets_defined",
  "measurable_requirements",
  "testable_acceptance_criteria",
  "contradictory_requirements",
  // Architecture & Code Quality
  "generic_over_specific",
  "no_nested_types",
  "single_responsibility",
  "explicit_access_control",
  "factory_based_injection",
  "solid_compliance",
  "code_reusability",
  // Security
  "no_hardcoded_secrets",
  "input_validation_required",
  "output_encoding_injection_prevention",
  "auth_on_every_endpoint",
  "security_safe_error_handling",
  "cryptographic_standards",
  "rate_limiting_required",
  "secure_communication",
  // Data Protection & Compliance
  "data_classification_required",
  "sensitive_data_protection",
  "no_sensitive_data_in_logs",
  "data_minimization",
  "audit_trail_required",
  "consent_and_erasure_support",
  // Error Handling & Resilience
  "structured_error_handling",
  "resilience_patterns",
  "graceful_degradation",
  "transaction_boundaries",
  "consistent_error_format",
  // Concurrency & State Management
  "concurrency_safety",
  "immutability_by_default",
  "atomic_operations",
  // Senior Code Quality Standards
  "no_magic_numbers",
  "defensive_coding",
  "method_size_limits",
  "consistent_naming",
  "api_contract_documentation",
  "deprecation_strategy",
  // Comprehensive Testing
  "mandatory_test_coverage",
  "security_testing_required",
  "performance_testing_required",
  "no_production_data_in_tests",
  "edge_case_negative_tests",
  "test_isolation",
  // Observability & Monitoring
  "structured_logging",
  "distributed_tracing",
  "no_pii_in_observability",
  "alerting_thresholds",
  // Dependency & Supply Chain
  "dependency_vulnerability_scanning",
  "minimal_dependency_principle",
]);

export type HardOutputRule = z.infer<typeof HardOutputRuleSchema>;

/** Non-critical rules produce warnings, not failures. Ported from HardOutputRule.swift isCritical. */
const NON_CRITICAL_RULES: ReadonlySet<HardOutputRule> = new Set([
  "uneven_sp_distribution",
  "metrics_disclaimer",
  "post_generation_self_check",
  "mandatory_codebase_analysis",
  "fr_numbering_gaps",
  "risk_mitigation_completeness",
  "deployment_rollback_plan",
  "measurable_requirements",
  "testable_acceptance_criteria",
  "contradictory_requirements",
  "explicit_access_control",
  "code_reusability",
  "immutability_by_default",
  "consistent_naming",
  "deprecation_strategy",
  "distributed_tracing",
  "alerting_thresholds",
  "minimal_dependency_principle",
]);

export function isCriticalRule(rule: HardOutputRule): boolean {
  return !NON_CRITICAL_RULES.has(rule);
}

/** Score penalty: critical = 0.15, non-critical = 0.05. Ported from HardOutputRule.swift. */
export function scorePenalty(rule: HardOutputRule): number {
  return isCriticalRule(rule) ? 0.15 : 0.05;
}

/** Rules that require LLM judgment (not deterministic regex). */
const NON_DETERMINISTIC_RULES: ReadonlySet<HardOutputRule> = new Set([
  "post_generation_self_check",
  "mandatory_codebase_analysis",
]);

export function isDeterministicRule(rule: HardOutputRule): boolean {
  return !NON_DETERMINISTIC_RULES.has(rule);
}
