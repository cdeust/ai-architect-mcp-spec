import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import {
  extractCodeBlocks,
  findAbsenceViolation,
  makeAdvisoryViolation,
  makeViolation,
} from "./helpers.js";
import {
  hasExplicitOptOut,
  matchCount,
  matchesAny,
  phrases,
} from "./lexicon.js";

// Rule 25: No Hardcoded Secrets
export function checkNoHardcodedSecrets(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const violations: HardOutputRuleViolation[] = [];
  const codeBlocks = extractCodeBlocks(content);

  const secretPatterns: Array<{ pattern: RegExp; description: string }> = [
    {
      pattern: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{3,}/i,
      description: "hardcoded password",
    },
    {
      pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["'][^"']{8,}/i,
      description: "hardcoded API key",
    },
    {
      pattern: /(?:secret|token|auth)\s*[:=]\s*["'][A-Za-z0-9+/=]{16,}/i,
      description: "hardcoded secret/token",
    },
    {
      pattern: /(?:Bearer|Basic)\s+[A-Za-z0-9+/=]{20,}/i,
      description: "hardcoded auth token",
    },
    {
      pattern:
        /(?:jdbc|mongodb|postgres|mysql|redis):\/\/[^\s"']+:[^\s"']+@/i,
      description: "hardcoded connection string with credentials",
    },
    {
      pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
      description: "embedded private key",
    },
  ];

  for (const codeBlock of codeBlocks) {
    for (const { pattern, description } of secretPatterns) {
      if (pattern.test(codeBlock)) {
        violations.push(
          makeViolation(
            "no_hardcoded_secrets",
            sectionType,
            `Code example contains ${description} — use environment variables, secret managers, or configuration injection instead.`,
            description,
          ),
        );
      }
    }
  }

  const lowered = content.toLowerCase();
  const dangerousPhrases = phrases("dangerousSecretPhrases");
  for (const phrase of dangerousPhrases) {
    if (lowered.includes(phrase)) {
      violations.push(
        makeViolation(
          "no_hardcoded_secrets",
          sectionType,
          "Spec instructs hardcoding secrets — must use secure configuration (env vars, vault, secret manager).",
          phrase,
        ),
      );
    }
  }

  return violations;
}

// Rule 26: Input Validation Required
export function checkInputValidationRequired(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["inputValidationTopic"])) {
    return [];
  }
  return findAbsenceViolation(
    content,
    phrases("inputValidationSignals"),
    2,
    "input_validation_required",
    sectionType,
    "Technical spec must specify input validation strategy — every external input (API, user, file, webhook) needs validation and sanitization rules at system boundaries.",
  );
}

// Rule 27: Output Encoding & Injection Prevention
export function checkOutputEncodingInjectionPrevention(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["injectionTopic"])) {
    return [];
  }
  const signalCount = matchCount(content, ["injectionSignals"]);

  if (signalCount < 2) {
    return [
      makeAdvisoryViolation(
        "output_encoding_injection_prevention",
        sectionType,
        "Technical spec must address injection prevention — specify parameterized queries (SQL injection), output encoding (XSS), and input sanitization strategies.",
      ),
    ];
  }

  const violations: HardOutputRuleViolation[] = [];
  const codeBlocks = extractCodeBlocks(content);

  const unsafeQueryPatterns: Array<{ pattern: RegExp; description: string }> = [
    {
      pattern:
        /(?:SELECT|INSERT|UPDATE|DELETE).*\+\s*(?:user|input|param|req)/i,
      description: "string concatenation in SQL query",
    },
    {
      pattern: /(?:SELECT|INSERT|UPDATE|DELETE).*\$\{.*\}/i,
      description: "string interpolation in SQL query",
    },
    {
      pattern: /exec\s*\(.*\+.*\)/i,
      description: "string concatenation in exec/eval",
    },
  ];

  for (const codeBlock of codeBlocks) {
    for (const { pattern, description } of unsafeQueryPatterns) {
      if (pattern.test(codeBlock)) {
        violations.push(
          makeViolation(
            "output_encoding_injection_prevention",
            sectionType,
            `Code example shows ${description} — use parameterized queries or prepared statements instead.`,
            description,
          ),
        );
      }
    }
  }

  return violations;
}

// Rule 28: Auth on Every Endpoint
export function checkAuthOnEveryEndpoint(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["authTopic"])) {
    return [];
  }

  const hasAuthN = matchesAny(content, ["authNSignals"]);
  const hasAuthZ = matchesAny(content, ["authZSignals"]);

  if (!hasAuthN || !hasAuthZ) {
    const missing: string[] = [];
    if (!hasAuthN) missing.push("authentication");
    if (!hasAuthZ) missing.push("authorization");
    return [
      makeAdvisoryViolation(
        "auth_on_every_endpoint",
        sectionType,
        `Technical spec must specify ${missing.join(" and ")} strategy — every endpoint/operation needs auth method, roles, and permission checks.`,
      ),
    ];
  }

  return [];
}

// Rule 29: Security-Safe Error Handling
export function checkSecuritySafeErrorHandling(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["safeErrorTopic"])) {
    return [];
  }

  const signalCount = matchCount(content, ["safeErrorSignals"]);

  if (signalCount < 1) {
    const hasErrorSecurity =
      matchesAny(content, ["errorTermSignals"]) &&
      matchesAny(content, ["securityOrSensitiveTermSignals"]);
    if (!hasErrorSecurity) {
      return [
        makeAdvisoryViolation(
          "security_safe_error_handling",
          sectionType,
          "Technical spec must ensure errors don't leak implementation details — no stack traces, internal paths, DB schemas, or server versions in error responses to clients.",
        ),
      ];
    }
  }

  return [];
}

// Rule 30: Cryptographic Standards
export function checkCryptographicStandards(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  // source: bug found 2026-07-15, e2e run run_mrlqa0aj_u2rh15 — this rule
  // was the only security rule in this file with NO opt-out escape, so a
  // local bash script with no encryption surface could never satisfy it
  // regardless of how it justified the non-applicability.
  if (hasExplicitOptOut(content, ["cryptoTopic"])) {
    return [];
  }
  const violations: HardOutputRuleViolation[] = [];

  const signalCount = matchCount(content, ["cryptoSignals"]);

  if (signalCount < 2) {
    violations.push(
      makeAdvisoryViolation(
        "cryptographic_standards",
        sectionType,
        "Technical spec must specify cryptographic standards — define encryption algorithms, hashing for passwords (bcrypt/argon2), minimum key sizes, and key management strategy.",
      ),
    );
  }

  const codeBlocks = extractCodeBlocks(content);
  const weakPatterns: Array<{ pattern: RegExp; description: string }> = [
    { pattern: /\bMD5\b/, description: "MD5 (cryptographically broken)" },
    { pattern: /\bSHA-?1\b/, description: "SHA-1 (deprecated for security)" },
    { pattern: /\bDES\b/, description: "DES (obsolete, use AES)" },
    { pattern: /\bRC4\b/, description: "RC4 (broken)" },
  ];

  for (const codeBlock of codeBlocks) {
    for (const { pattern, description } of weakPatterns) {
      if (pattern.test(codeBlock)) {
        violations.push(
          makeViolation(
            "cryptographic_standards",
            sectionType,
            `Code example uses weak cryptographic algorithm: ${description}. Use AES-256, SHA-256+, bcrypt/argon2 for passwords.`,
            description,
          ),
        );
      }
    }
  }

  return violations;
}

// Rule 31: Rate Limiting Required
export function checkRateLimitingRequired(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["rateLimitTopic"])) {
    return [];
  }
  return findAbsenceViolation(
    content,
    phrases("rateLimitSignals"),
    1,
    "rate_limiting_required",
    sectionType,
    "Technical spec must specify rate limiting strategy — define request limits per user/IP, throttling behavior, and abuse prevention for public-facing endpoints.",
  );
}

// Rule 32: Secure Communication
export function checkSecureCommunication(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  if (hasExplicitOptOut(content, ["secureCommTopic"])) {
    return [];
  }
  return findAbsenceViolation(
    content,
    phrases("secureCommSignals"),
    1,
    "secure_communication",
    sectionType,
    "Technical spec must specify secure communication — TLS requirements, certificate validation, no mixed content, encrypted channels for all data in transit.",
  );
}
