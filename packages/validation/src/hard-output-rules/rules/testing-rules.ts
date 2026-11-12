import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import {
  findAbsenceViolation,
  makeAdvisoryViolation,
} from "./helpers.js";

// Rule 53: Mandatory Test Coverage
export function checkMandatoryTestCoverage(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const lowered = content.toLowerCase();

  const unitSignals = [
    "unit test",
    "ut-",
    "unit coverage",
    "function test",
    "method test",
    "class test",
    "module test",
  ];

  const integrationSignals = [
    "integration test",
    "it-",
    "api test",
    "contract test",
    "component test",
    "service test",
    "end-to-end",
    "e2e",
  ];

  const coverageSignals = [
    "test coverage",
    "code coverage",
    "coverage target",
    "coverage threshold",
    "coverage report",
    "line coverage",
    "branch coverage",
    "100% coverage",
    "minimum coverage",
  ];

  const hasUnit = unitSignals.some((s) => lowered.includes(s));
  const hasIntegration = integrationSignals.some((s) => lowered.includes(s));
  const hasCoverage = coverageSignals.some((s) => lowered.includes(s));

  const violations: HardOutputRuleViolation[] = [];

  if (!hasUnit || !hasIntegration) {
    violations.push(
      makeAdvisoryViolation(
        "mandatory_test_coverage",
        sectionType,
        "Test spec must include both unit tests and integration tests — every public method/endpoint needs corresponding test specifications.",
      ),
    );
  }

  if (!hasCoverage) {
    violations.push(
      makeAdvisoryViolation(
        "mandatory_test_coverage",
        sectionType,
        "Test spec must define coverage targets — specify minimum code coverage thresholds for unit, integration, and overall coverage.",
      ),
    );
  }

  return violations;
}

// Rule 54: Security Testing Required
export function checkSecurityTestingRequired(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "security test",
      "penetration test",
      "pen test",
      "sast",
      "dast",
      "static analysis",
      "dynamic analysis",
      "vulnerability scan",
      "dependency scan",
      "snyk",
      "owasp",
      "security audit",
      "threat model",
      "fuzz",
      "injection test",
      "auth test",
      "access control test",
      "privilege escalation",
    ],
    2,
    "security_testing_required",
    sectionType,
    "Test spec must include security testing — SAST/DAST, dependency vulnerability scanning, penetration test plan, and OWASP-based test cases.",
  );
}

// Rule 55: Performance Testing Required
export function checkPerformanceTestingRequired(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "performance test",
      "load test",
      "stress test",
      "benchmark",
      "throughput test",
      "latency test",
      "spike test",
      "soak test",
      "capacity test",
      "response time",
      "p95",
      "p99",
      "percentile",
      "concurrent user",
      "requests per second",
      "rps",
    ],
    2,
    "performance_testing_required",
    sectionType,
    "Test spec must include performance testing — load test scenarios, stress thresholds, baseline comparisons, and latency percentile targets.",
  );
}

// Rule 56: No Production Data in Tests
export function checkNoProductionDataInTests(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "synthetic data",
      "anonymized",
      "anonymised",
      "test fixture",
      "mock data",
      "fake data",
      "factory",
      "faker",
      "seed data",
      "generated data",
      "no production data",
      "no real data",
      "test data",
      "sample data",
      "fixture",
    ],
    1,
    "no_production_data_in_tests",
    sectionType,
    "Test spec must mandate synthetic test data — no real PII, no production data dumps, use factories/fakers/fixtures for all test data.",
  );
}

// Rule 57: Edge Case & Negative Tests
export function checkEdgeCaseNegativeTests(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const lowered = content.toLowerCase();

  const negativeSignals = [
    "negative test",
    "failure case",
    "error case",
    "unhappy path",
    "sad path",
    "invalid input",
    "reject",
    "unauthorized",
    "forbidden",
    "not found",
    "timeout",
    "failure scenario",
  ];

  const edgeCaseSignals = [
    "edge case",
    "boundary",
    "corner case",
    "empty",
    "null",
    "zero",
    "overflow",
    "maximum",
    "minimum",
    "limit",
    "concurrent",
    "race condition",
    "duplicate",
    "idempoten",
  ];

  const hasNegative = negativeSignals.some((s) => lowered.includes(s));
  const hasEdgeCases = edgeCaseSignals.some((s) => lowered.includes(s));

  if (!hasNegative || !hasEdgeCases) {
    return [
      makeAdvisoryViolation(
        "edge_case_negative_tests",
        sectionType,
        "Test spec must include both negative tests (failure scenarios, invalid inputs, unauthorized access) and edge cases (boundary values, empty states, concurrent operations).",
      ),
    ];
  }

  return [];
}

// Rule 58: Test Isolation
export function checkTestIsolation(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "test isolation",
      "isolated test",
      "independent test",
      "no shared state",
      "setup and teardown",
      "setup/teardown",
      "before each",
      "after each",
      "beforeeach",
      "aftereach",
      "fresh instance",
      "clean state",
      "reset",
      "test container",
      "in-memory database",
      "mock",
    ],
    2,
    "test_isolation",
    sectionType,
    "Test spec must ensure test isolation — no shared mutable state between tests, proper setup/teardown, each test independent and repeatable in any order.",
  );
}
