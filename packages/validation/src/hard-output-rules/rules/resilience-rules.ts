import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import {
  findAbsenceViolation,
  makeAdvisoryViolation,
} from "./helpers.js";
import { hasExplicitOptOut, matchesAny, phrases } from "./lexicon.js";

// Rule 39: Structured Error Handling
export function checkStructuredErrorHandling(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["errorHandlingTopic"])) {
    return [];
  }

  const hasDomainErrors = matchesAny(content, ["domainErrorSignals"]);
  const hasPropagation = matchesAny(content, ["propagationSignals"]);

  if (!hasDomainErrors && !hasPropagation) {
    return [
      makeAdvisoryViolation(
        "structured_error_handling",
        sectionType,
        "Technical spec must define structured error handling — domain-specific error types, no swallowed exceptions, no generic catch-all, and explicit error propagation strategy.",
      ),
    ];
  }

  return [];
}

// Rule 40: Resilience Patterns
export function checkResiliencePatterns(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["resiliencePatternsTopic"])) {
    return [];
  }
  return findAbsenceViolation(
    content,
    phrases("resiliencePatternsSignals"),
    2,
    "resilience_patterns",
    sectionType,
    "Technical spec must specify resilience patterns — circuit breaker for external dependencies, retry with exponential backoff, and timeout on every external call.",
  );
}

// Rule 41: Graceful Degradation
export function checkGracefulDegradation(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["gracefulDegradationTopic"])) {
    return [];
  }
  return findAbsenceViolation(
    content,
    phrases("gracefulDegradationSignals"),
    1,
    "graceful_degradation",
    sectionType,
    "Technical spec must define graceful degradation — specify fallback behavior when dependencies fail, prevent cascading failures, and define degraded operation modes.",
  );
}

// Rule 42: Transaction Boundaries
export function checkTransactionBoundaries(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["transactionBoundariesTopic"])) {
    return [];
  }
  return findAbsenceViolation(
    content,
    phrases("transactionBoundariesSignals"),
    2,
    "transaction_boundaries",
    sectionType,
    "Technical spec must define transaction boundaries — specify transaction scope, isolation level, rollback strategy, and idempotency for multi-step operations.",
  );
}

// Rule 43: Consistent Error Format
export function checkConsistentErrorFormat(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["errorFormatTopic"])) {
    return [];
  }
  return findAbsenceViolation(
    content,
    phrases("errorFormatSignals"),
    1,
    "consistent_error_format",
    sectionType,
    'Technical spec must define a consistent error response format — standardized structure with error codes, human-readable messages, and machine-readable details (e.g., RFC 7807).',
  );
}
