import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import {
  findAbsenceViolation,
  makeAdvisoryViolation,
} from "./helpers.js";
import { hasExplicitOptOut, matchesAny, phrases } from "./lexicon.js";

// Rule 33: Data Classification Required
export function checkDataClassificationRequired(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["dataClassificationTopic"])) {
    return [];
  }
  return findAbsenceViolation(
    content,
    phrases("dataClassificationSignals"),
    2,
    "data_classification_required",
    sectionType,
    "Technical spec must classify all data entities — define sensitivity levels (public/internal/confidential/restricted) with handling rules per classification.",
  );
}

// Rule 34: Sensitive Data Protection
export function checkSensitiveDataProtection(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["sensitiveDataTopic"])) {
    return [];
  }

  let categoriesMet = 0;
  if (matchesAny(content, ["encryptionAtRestSignals"])) categoriesMet++;
  if (matchesAny(content, ["maskingSignals"])) categoriesMet++;
  if (matchesAny(content, ["accessControlSignals"])) categoriesMet++;

  if (categoriesMet < 2) {
    return [
      makeAdvisoryViolation(
        "sensitive_data_protection",
        sectionType,
        "Technical spec must specify sensitive data protection strategy — address at least 2 of: encryption at rest, masking/anonymization, and access restrictions for PII and sensitive fields.",
      ),
    ];
  }

  return [];
}

// Rule 35: No Sensitive Data in Logs
export function checkNoSensitiveDataInLogs(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["noSensitiveInLogsTopic"])) {
    return [];
  }

  const hasLogProtection = matchesAny(content, ["noLogPIISignals"]);

  const broaderSignals =
    matchesAny(content, ["sensitiveTermSignals"]) &&
    matchesAny(content, ["logTermSignals"]) &&
    matchesAny(content, ["negationActionSignals"]);

  if (!hasLogProtection && !broaderSignals) {
    return [
      makeAdvisoryViolation(
        "no_sensitive_data_in_logs",
        sectionType,
        "Technical spec must explicitly prevent sensitive data (PII, credentials, tokens) from appearing in logs, error messages, URLs, or query parameters.",
      ),
    ];
  }

  return [];
}

// Rule 36: Data Minimization
export function checkDataMinimization(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["dataMinimizationTopic"])) {
    return [];
  }
  return findAbsenceViolation(
    content,
    phrases("dataMinimizationSignals"),
    1,
    "data_minimization",
    sectionType,
    "Technical spec must address data minimization — collect and store only what's necessary, justify every sensitive field, define purpose limitation.",
  );
}

// Rule 37: Audit Trail Required
export function checkAuditTrailRequired(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["auditTrailTopic"])) {
    return [];
  }
  return findAbsenceViolation(
    content,
    phrases("auditTrailSignals"),
    1,
    "audit_trail_required",
    sectionType,
    "Technical spec must require audit trails for sensitive operations — log who/what/when for authentication events, data access, configuration changes, and admin actions.",
  );
}

// Rule 38: Consent & Erasure Support
export function checkConsentAndErasureSupport(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["consentErasureTopic"])) {
    return [];
  }

  const hasConsent = matchesAny(content, ["consentSignals"]);
  const hasErasure = matchesAny(content, ["erasureSignals"]);

  if (!hasConsent && !hasErasure) {
    return [
      makeAdvisoryViolation(
        "consent_and_erasure_support",
        sectionType,
        "Technical spec must support consent management and data erasure — specify how user consent is tracked, how deletion cascades through the data model, and GDPR/privacy compliance.",
      ),
    ];
  }

  return [];
}
