import type {
  HardOutputRule,
  HardOutputRuleViolation,
  ValidationReport,
  SectionType,
} from "@prd-gen/core";
// isCriticalRule / scorePenalty are applied in rules/helpers.ts's makeViolation
// factory; this module reads the resulting `isCritical` / `scorePenalty` FIELDS
// off each violation, never the functions.

import {
  rulesForSection,
  DOCUMENT_LEVEL_RULES,
  type DocumentLevelRule,
} from "./rule-mapping.js";

// Document-level dependency targets (#118)
import { checkDocumentDependencyTargetsDefined } from "./rules/dependency-target-rules.js";

// SP Rules (1, 8, 9)
import {
  checkSPArithmetic,
  checkSPNotInFRTable,
  checkUnevenSPDistribution,
  checkDocumentSPArithmetic,
} from "./rules/sp-rules.js";

// Quality Rules (2, 10, 15, 23, 24)
import {
  checkNoSelfReferencingDeps,
  checkMetricsDisclaimer,
  checkHonestVerificationVerdicts,
  checkDocumentVerificationVerdicts,
  checkRiskMitigationCompleteness,
  checkDeploymentRollbackPlan,
} from "./rules/quality-rules.js";

// Numbering Rules (3, 11, 18, 22)
import {
  checkACNumbering,
  checkFRTraceability,
  checkDuplicateRequirementIds,
  checkFRNumberingGaps,
  checkDocumentACConsistency,
} from "./rules/numbering-rules.js";

// Database Rules (4, 5, 6, 21)
import {
  checkNoAnyCodable,
  checkNoNowInPartialIndexes,
  checkNoOrphanDDL,
  checkFKReferencesExist,
} from "./rules/database-rules.js";

// Test Rules (7, 17)
import {
  checkNoPlaceholderTests,
  checkTestTraceabilityIntegrity,
  checkDocumentTestTraceability,
} from "./rules/test-rules.js";

// Architecture Rules (12, 16, 18)
import {
  checkCleanArchitecture,
  checkCodeExamplePortCompliance,
  checkGenericOverSpecific,
} from "./rules/architecture-rules.js";

// Code Quality Rules (19-24)
import {
  checkNoNestedTypes,
  checkSingleResponsibility,
  checkExplicitAccessControl,
  checkFactoryBasedInjection,
  checkSolidCompliance,
  checkCodeReusability,
} from "./rules/code-quality-rules.js";

// Coverage Rules (19, 20) — document-level
import {
  checkDocumentFRToACCoverage,
  checkDocumentACToTestCoverage,
} from "./rules/coverage-rules.js";

// Security Rules (25-32)
import {
  checkNoHardcodedSecrets,
  checkInputValidationRequired,
  checkOutputEncodingInjectionPrevention,
  checkAuthOnEveryEndpoint,
  checkSecuritySafeErrorHandling,
  checkCryptographicStandards,
  checkRateLimitingRequired,
  checkSecureCommunication,
} from "./rules/security-rules.js";

// Data Protection Rules (33-38)
import {
  checkDataClassificationRequired,
  checkSensitiveDataProtection,
  checkNoSensitiveDataInLogs,
  checkDataMinimization,
  checkAuditTrailRequired,
  checkConsentAndErasureSupport,
} from "./rules/data-protection-rules.js";

// Resilience Rules (39-43)
import {
  checkStructuredErrorHandling,
  checkResiliencePatterns,
  checkGracefulDegradation,
  checkTransactionBoundaries,
  checkConsistentErrorFormat,
} from "./rules/resilience-rules.js";

// Concurrency Rules (44-46)
import {
  checkConcurrencySafety,
  checkImmutabilityByDefault,
  checkAtomicOperations,
} from "./rules/concurrency-rules.js";

// Senior Quality Rules (47-52)
import {
  checkNoMagicNumbers,
  checkDefensiveCoding,
  checkMethodSizeLimits,
  checkConsistentNaming,
  checkAPIContractDocumentation,
  checkDeprecationStrategy,
} from "./rules/senior-quality-rules.js";

// Testing Rules (53-58)
import {
  checkMandatoryTestCoverage,
  checkSecurityTestingRequired,
  checkPerformanceTestingRequired,
  checkNoProductionDataInTests,
  checkEdgeCaseNegativeTests,
  checkTestIsolation,
} from "./rules/testing-rules.js";

// Observability Rules (59-62)
import {
  checkStructuredLogging,
  checkDistributedTracing,
  checkNoPIIInObservability,
  checkAlertingThresholds,
} from "./rules/observability-rules.js";

// Dependency Rules (63-64)
import {
  checkDependencyVulnerabilityScanning,
  checkMinimalDependencyPrinciple,
} from "./rules/dependency-rules.js";

/**
 * Dispatch a single rule check against section content.
 * Ported from HardOutputRulesValidator.swift checkRule().
 */
function checkRule(
  rule: HardOutputRule,
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  switch (rule) {
    // Core PRD Rules
    case "sp_arithmetic":
      return checkSPArithmetic(content, sectionType);
    case "no_self_referencing_deps":
      return checkNoSelfReferencingDeps(content, sectionType);
    case "ac_numbering":
      return checkACNumbering(content, sectionType);
    case "no_orphan_ddl":
      return checkNoOrphanDDL(content, sectionType);
    case "no_now_in_partial_indexes":
      return checkNoNowInPartialIndexes(content, sectionType);
    case "no_any_codable":
      return checkNoAnyCodable(content, sectionType);
    case "no_placeholder_tests":
      return checkNoPlaceholderTests(content, sectionType);
    case "sp_not_in_fr_table":
      return checkSPNotInFRTable(content, sectionType);
    case "uneven_sp_distribution":
      return checkUnevenSPDistribution(content, sectionType);
    case "metrics_disclaimer":
      return checkMetricsDisclaimer(content, sectionType);
    case "fr_traceability":
      return checkFRTraceability(content, sectionType);
    case "clean_architecture":
      return checkCleanArchitecture(content, sectionType);
    case "honest_verification_verdicts":
      return checkHonestVerificationVerdicts(content, sectionType);
    case "code_example_port_compliance":
      return checkCodeExamplePortCompliance(content, sectionType);
    case "test_traceability_integrity":
      return checkTestTraceabilityIntegrity(content, sectionType);
    case "duplicate_requirement_ids":
      return checkDuplicateRequirementIds(content, sectionType);
    case "fk_references_exist":
      return checkFKReferencesExist(content, sectionType);
    case "fr_numbering_gaps":
      return checkFRNumberingGaps(content, sectionType);
    case "risk_mitigation_completeness":
      return checkRiskMitigationCompleteness(content, sectionType);
    case "deployment_rollback_plan":
      return checkDeploymentRollbackPlan(content, sectionType);

    // Architecture & Code Quality (18-24)
    case "generic_over_specific":
      return checkGenericOverSpecific(content, sectionType);
    case "no_nested_types":
      return checkNoNestedTypes(content, sectionType);
    case "single_responsibility":
      return checkSingleResponsibility(content, sectionType);
    case "explicit_access_control":
      return checkExplicitAccessControl(content, sectionType);
    case "factory_based_injection":
      return checkFactoryBasedInjection(content, sectionType);
    case "solid_compliance":
      return checkSolidCompliance(content, sectionType);
    case "code_reusability":
      return checkCodeReusability(content, sectionType);

    // Security (25-32)
    case "no_hardcoded_secrets":
      return checkNoHardcodedSecrets(content, sectionType);
    case "input_validation_required":
      return checkInputValidationRequired(content, sectionType);
    case "output_encoding_injection_prevention":
      return checkOutputEncodingInjectionPrevention(content, sectionType);
    case "auth_on_every_endpoint":
      return checkAuthOnEveryEndpoint(content, sectionType);
    case "security_safe_error_handling":
      return checkSecuritySafeErrorHandling(content, sectionType);
    case "cryptographic_standards":
      return checkCryptographicStandards(content, sectionType);
    case "rate_limiting_required":
      return checkRateLimitingRequired(content, sectionType);
    case "secure_communication":
      return checkSecureCommunication(content, sectionType);

    // Data Protection (33-38)
    case "data_classification_required":
      return checkDataClassificationRequired(content, sectionType);
    case "sensitive_data_protection":
      return checkSensitiveDataProtection(content, sectionType);
    case "no_sensitive_data_in_logs":
      return checkNoSensitiveDataInLogs(content, sectionType);
    case "data_minimization":
      return checkDataMinimization(content, sectionType);
    case "audit_trail_required":
      return checkAuditTrailRequired(content, sectionType);
    case "consent_and_erasure_support":
      return checkConsentAndErasureSupport(content, sectionType);

    // Error Handling & Resilience (39-43)
    case "structured_error_handling":
      return checkStructuredErrorHandling(content, sectionType);
    case "resilience_patterns":
      return checkResiliencePatterns(content, sectionType);
    case "graceful_degradation":
      return checkGracefulDegradation(content, sectionType);
    case "transaction_boundaries":
      return checkTransactionBoundaries(content, sectionType);
    case "consistent_error_format":
      return checkConsistentErrorFormat(content, sectionType);

    // Concurrency (44-46)
    case "concurrency_safety":
      return checkConcurrencySafety(content, sectionType);
    case "immutability_by_default":
      return checkImmutabilityByDefault(content, sectionType);
    case "atomic_operations":
      return checkAtomicOperations(content, sectionType);

    // Senior Quality (47-52)
    case "no_magic_numbers":
      return checkNoMagicNumbers(content, sectionType);
    case "defensive_coding":
      return checkDefensiveCoding(content, sectionType);
    case "method_size_limits":
      return checkMethodSizeLimits(content, sectionType);
    case "consistent_naming":
      return checkConsistentNaming(content, sectionType);
    case "api_contract_documentation":
      return checkAPIContractDocumentation(content, sectionType);
    case "deprecation_strategy":
      return checkDeprecationStrategy(content, sectionType);

    // Testing (53-58)
    case "mandatory_test_coverage":
      return checkMandatoryTestCoverage(content, sectionType);
    case "security_testing_required":
      return checkSecurityTestingRequired(content, sectionType);
    case "performance_testing_required":
      return checkPerformanceTestingRequired(content, sectionType);
    case "no_production_data_in_tests":
      return checkNoProductionDataInTests(content, sectionType);
    case "edge_case_negative_tests":
      return checkEdgeCaseNegativeTests(content, sectionType);
    case "test_isolation":
      return checkTestIsolation(content, sectionType);

    // Observability (59-62)
    case "structured_logging":
      return checkStructuredLogging(content, sectionType);
    case "distributed_tracing":
      return checkDistributedTracing(content, sectionType);
    case "no_pii_in_observability":
      return checkNoPIIInObservability(content, sectionType);
    case "alerting_thresholds":
      return checkAlertingThresholds(content, sectionType);

    // Dependencies (63-64)
    case "dependency_vulnerability_scanning":
      return checkDependencyVulnerabilityScanning(content, sectionType);
    case "minimal_dependency_principle":
      return checkMinimalDependencyPrinciple(content, sectionType);

    // Document-level / process-level rules — checked in validateDocument()
    case "fr_to_ac_coverage":
    case "ac_to_test_coverage":
    case "dependency_targets_defined":
    case "post_generation_self_check":
    case "mandatory_codebase_analysis":
      return [];
  }
}

/**
 * Validate a single PRD section against applicable Hard Output Rules.
 * Returns violations found. Zero LLM calls — pure regex/parsing.
 */
export function validateSection(
  content: string,
  sectionType: SectionType,
): ValidationReport {
  const applicableRules = rulesForSection(sectionType);
  const violations: HardOutputRuleViolation[] = [];
  const rulesPassed: HardOutputRule[] = [];

  for (const rule of applicableRules) {
    const ruleViolations = checkRule(rule, content, sectionType);
    if (ruleViolations.length === 0) {
      rulesPassed.push(rule);
    } else {
      violations.push(...ruleViolations);
    }
  }

  const hasCriticalViolations = violations.some((v) => v.isCritical);
  const totalPenalty = violations.reduce((sum, v) => sum + v.scorePenalty, 0);
  const totalScore = Math.max(0, 1 - totalPenalty);

  return {
    violations,
    rulesChecked: applicableRules,
    rulesPassed,
    sectionType,
    hasCriticalViolations,
    totalScore,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Validate an entire PRD document with cross-section rules.
 * Runs section-level validation on each section, then document-level checks
 * (SP arithmetic across all stories, cross-file AC numbering, etc.).
 */
/** Everything a cross-section checker may read. */
interface DocumentCheckInput {
  readonly sections: ReadonlyArray<{ type: SectionType; content: string }>;
  readonly combinedContent: string;
}

/**
 * Cross-section checker for every rule in DOCUMENT_LEVEL_RULES.
 *
 * Total by construction: `Record<DocumentLevelRule, …>` makes a rule declared
 * document-level without a checker a compile error, which is the drift this
 * table was added to close — DOCUMENT_LEVEL_RULES previously listed 7 rules
 * while validateDocument hand-called 6, and nothing detected the gap because
 * the constant had no consumer.
 *
 * source: coding-standards §1.2 OCP — new document rule = one list entry +
 *   one table entry, zero edits to the dispatch loop.
 */
const DOCUMENT_LEVEL_CHECKS: Readonly<
  Record<DocumentLevelRule, (input: DocumentCheckInput) => HardOutputRuleViolation[]>
> = {
  sp_arithmetic: ({ sections }) => checkDocumentSPArithmetic(sections),
  ac_numbering: ({ combinedContent }) =>
    checkDocumentACConsistency(combinedContent),
  honest_verification_verdicts: ({ sections }) =>
    checkDocumentVerificationVerdicts(sections),
  test_traceability_integrity: ({ sections }) =>
    checkDocumentTestTraceability(sections),
  fr_to_ac_coverage: ({ sections }) => checkDocumentFRToACCoverage(sections),
  ac_to_test_coverage: ({ sections }) => checkDocumentACToTestCoverage(sections),
  dependency_targets_defined: ({ sections }) =>
    checkDocumentDependencyTargetsDefined(sections),
};

export function validateDocument(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): ValidationReport {
  const allViolations: HardOutputRuleViolation[] = [];
  const allRulesChecked = new Set<HardOutputRule>();
  const allRulesPassed = new Set<HardOutputRule>();

  // Section-level validation
  for (const section of sections) {
    const report = validateSection(section.content, section.type);
    allViolations.push(...report.violations);
    for (const r of report.rulesChecked) allRulesChecked.add(r);
    for (const r of report.rulesPassed) allRulesPassed.add(r);
  }

  // Document-level cross-section checks
  const combinedContent = sections.map((s) => s.content).join("\n\n");

  const addDocCheck = (
    rule: HardOutputRule,
    violations: HardOutputRuleViolation[],
  ) => {
    allRulesChecked.add(rule);
    if (violations.length === 0) {
      allRulesPassed.add(rule);
    } else {
      allRulesPassed.delete(rule);
      allViolations.push(...violations);
    }
  };

  const input: DocumentCheckInput = { sections, combinedContent };
  for (const rule of DOCUMENT_LEVEL_RULES) {
    addDocCheck(rule, DOCUMENT_LEVEL_CHECKS[rule](input));
  }

  // Remove violated rules from passed set
  const violatedRules = new Set(allViolations.map((v) => v.rule));
  for (const rule of violatedRules) {
    allRulesPassed.delete(rule);
  }

  const hasCriticalViolations = allViolations.some((v) => v.isCritical);
  const totalPenalty = allViolations.reduce((sum, v) => sum + v.scorePenalty, 0);
  const totalScore = Math.max(0, 1 - totalPenalty);

  return {
    violations: allViolations,
    rulesChecked: [...allRulesChecked].sort(),
    rulesPassed: [...allRulesPassed].sort(),
    sectionType: null,
    hasCriticalViolations,
    totalScore,
    checkedAt: new Date().toISOString(),
  };
}

// Re-export for consumers
export {
  rulesForSection,
  DOCUMENT_LEVEL_RULES,
  type DocumentLevelRule,
} from "./rule-mapping.js";
