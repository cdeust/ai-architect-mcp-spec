import { isBlockingViolation, } from "@prd-gen/core";
const RULE_TO_CATEGORY = {
    // Architecture
    clean_architecture: "missing_architecture",
    code_example_port_compliance: "missing_architecture",
    generic_over_specific: "missing_architecture",
    factory_based_injection: "missing_architecture",
    solid_compliance: "missing_architecture",
    single_responsibility: "missing_architecture",
    // Security
    no_hardcoded_secrets: "missing_security",
    input_validation_required: "missing_security",
    output_encoding_injection_prevention: "missing_security",
    auth_on_every_endpoint: "missing_security",
    security_safe_error_handling: "missing_security",
    cryptographic_standards: "missing_security",
    rate_limiting_required: "missing_security",
    secure_communication: "missing_security",
    // Data model
    no_orphan_ddl: "missing_data_model",
    no_now_in_partial_indexes: "missing_data_model",
    fk_references_exist: "missing_data_model",
    data_classification_required: "missing_data_model",
    // Tests
    no_placeholder_tests: "missing_test_evidence",
    test_traceability_integrity: "missing_test_evidence",
    mandatory_test_coverage: "missing_test_evidence",
    test_isolation: "missing_test_evidence",
    // Structural
    sp_arithmetic: "structural_arithmetic",
    sp_not_in_fr_table: "structural_arithmetic",
    uneven_sp_distribution: "structural_arithmetic",
    ac_numbering: "structural_arithmetic",
    duplicate_requirement_ids: "structural_arithmetic",
    fr_numbering_gaps: "structural_arithmetic",
    // Resilience
    structured_error_handling: "missing_resilience",
    resilience_patterns: "missing_resilience",
    graceful_degradation: "missing_resilience",
    deployment_rollback_plan: "missing_resilience",
    transaction_boundaries: "missing_resilience",
    // Claims
    metrics_disclaimer: "ungrounded_claim",
    honest_verification_verdicts: "ungrounded_claim",
    // Naming
    no_any_codable: "naming_convention",
    no_nested_types: "naming_convention",
    consistent_naming: "naming_convention",
    // Observability
    structured_logging: "missing_observability",
    distributed_tracing: "missing_observability",
    no_pii_in_observability: "missing_observability",
    alerting_thresholds: "missing_observability",
};
// ─── Corrective Query Templates ──────────────────────────────────────────────
const CATEGORY_TO_QUERY = {
    missing_architecture: {
        query: "architecture patterns ports adapters hexagonal clean architecture composition root dependency injection",
        maxResults: 5,
    },
    missing_security: {
        query: "authentication authorization input validation rate limiting encryption security middleware",
        maxResults: 5,
    },
    missing_data_model: {
        query: "database schema CREATE TABLE foreign key references data types constraints indexes",
        maxResults: 4,
    },
    missing_test_evidence: {
        query: "test patterns test fixtures assertions test utilities test helpers integration test",
        maxResults: 4,
    },
    structural_arithmetic: {
        query: "", // No retrieval helps — this is a generation error
        maxResults: 0,
    },
    missing_resilience: {
        query: "error handling retry circuit breaker fallback recovery rollback graceful degradation",
        maxResults: 4,
    },
    ungrounded_claim: {
        query: "", // No retrieval helps — this is a reasoning error
        maxResults: 0,
    },
    naming_convention: {
        query: "naming conventions coding standards type definitions domain model value objects",
        maxResults: 3,
    },
    missing_observability: {
        query: "logging tracing monitoring metrics observability alerts dashboards",
        maxResults: 3,
    },
    uncategorized: {
        query: "",
        maxResults: 0,
    },
};
// ─── Mapping ─────────────────────────────────────────────────────────────────
export function mapFailuresToRetrievals(allViolations) {
    // Advisory findings (a lexicon found none of a topic's words) are not
    // failures: they call for no corrective retrieval and no retry (#117).
    // A violation without the field is blocking, as before.
    const violations = allViolations.filter(isBlockingViolation);
    // Group violations by category
    const categorySet = new Set();
    for (const v of violations) {
        const category = RULE_TO_CATEGORY[v.rule] ?? "uncategorized";
        categorySet.add(category);
    }
    // Build corrective retrievals (deduplicated by category)
    const correctiveRetrievals = [];
    for (const category of categorySet) {
        const template = CATEGORY_TO_QUERY[category];
        if (template.query && template.maxResults > 0) {
            // Find a representative violation for this category
            const representative = violations.find((v) => (RULE_TO_CATEGORY[v.rule] ?? "uncategorized") === category);
            correctiveRetrievals.push({
                query: template.query,
                maxResults: template.maxResults,
                reason: `Validation failed on ${category}: ${representative?.message ?? "unknown"}`,
                triggeringRule: representative?.rule ?? "sp_arithmetic",
            });
        }
    }
    // Structural arithmetic and ungrounded claims don't benefit from retrieval
    const nonRetrievableCategories = new Set([
        "structural_arithmetic",
        "ungrounded_claim",
        "uncategorized",
    ]);
    const hasRetrievableFailures = [...categorySet].some((c) => !nonRetrievableCategories.has(c));
    const failureSummary = [
        `${violations.length} violations across ${categorySet.size} categories.`,
        hasRetrievableFailures
            ? `${correctiveRetrievals.length} corrective retrievals recommended.`
            : "Failures are structural (arithmetic/reasoning) — no retrieval will help. Fix the generation logic.",
    ].join(" ");
    return {
        correctiveRetrievals,
        retryLikely: hasRetrievableFailures,
        failureSummary,
    };
}
//# sourceMappingURL=failure-mapper.js.map