import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import {
  findAbsenceViolation,
  makeAdvisoryViolation,
} from "./helpers.js";
import {
  hasExplicitOptOut,
  matchCount,
  matchesAny,
  phrases,
} from "./lexicon.js";

// Rule 59: Structured Logging
export function checkStructuredLogging(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["structuredLoggingTopic"])) {
    return [];
  }
  const hasFormat = matchesAny(content, ["structuredLoggingFormatSignals"]);
  const hasLevels = matchCount(content, ["structuredLoggingLevelSignals"]) >= 2;

  if (!hasFormat && !hasLevels) {
    return [
      makeAdvisoryViolation(
        "structured_logging",
        sectionType,
        "Technical spec must define structured logging — specify log format (JSON/structured), log levels (DEBUG/INFO/WARN/ERROR), and what to log at each level.",
      ),
    ];
  }

  return [];
}

// Rule 60: Distributed Tracing
export function checkDistributedTracing(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["distributedTracingTopic"])) {
    return [];
  }
  return findAbsenceViolation(
    content,
    phrases("distributedTracingSignals"),
    1,
    "distributed_tracing",
    sectionType,
    "Technical spec should specify distributed tracing — correlation IDs for cross-service request tracking, trace context propagation, and observability integration.",
  );
}

// Rule 61: No PII in Observability
export function checkNoPIIInObservability(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["piiObservabilityTopic"])) {
    return [];
  }

  const hasProtection = matchesAny(content, ["piiObservabilitySignals"]);

  const hasBroader =
    matchesAny(content, ["piiObservabilityBroaderTopicSignals"]) &&
    matchesAny(content, ["piiObservabilitySurfaceSignals"]) &&
    matchesAny(content, ["piiObservabilityActionSignals"]);

  if (!hasProtection && !hasBroader) {
    return [
      makeAdvisoryViolation(
        "no_pii_in_observability",
        sectionType,
        "Technical spec must ensure no PII in observability — logs, metrics, traces, and dashboards must not contain sensitive personal data. Specify masking/redaction strategy.",
      ),
    ];
  }

  return [];
}

// Rule 62: Alerting Thresholds
export function checkAlertingThresholds(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["alertingTopic"])) {
    return [];
  }
  return findAbsenceViolation(
    content,
    phrases("alertingSignals"),
    2,
    "alerting_thresholds",
    sectionType,
    "Technical spec should define alerting thresholds — specify what triggers alerts, severity levels, escalation paths, and on-call routing.",
  );
}
