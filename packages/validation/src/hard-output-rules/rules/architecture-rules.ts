import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import {
  extractCodeBlocks,
  makeAdvisoryViolation,
  makeViolation,
} from "./helpers.js";

// Rule 12: Clean Architecture in Technical Spec
export function checkCleanArchitecture(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const lowered = content.toLowerCase();

  const hasPortAdapter =
    lowered.includes("port") && lowered.includes("adapter");
  const hasHexagonal = lowered.includes("hexagonal");
  const hasCleanArch = lowered.includes("clean architecture");
  const hasDomainLayer =
    lowered.includes("domain layer") || lowered.includes("domain model");
  const hasCompositionRoot =
    lowered.includes("composition root") ||
    lowered.includes("composition layer");

  const hasArchPattern = hasPortAdapter || hasHexagonal || hasCleanArch;
  const hasLayerSeparation = hasDomainLayer || hasCompositionRoot;

  if (!hasArchPattern && !hasLayerSeparation) {
    return [
      makeAdvisoryViolation(
        "clean_architecture",
        sectionType,
        "Technical spec lacks ports/adapters architecture — must show domain layer with ports, adapter layer, and composition root",
      ),
    ];
  }

  return [];
}

// Rule 16: Code Example Port Compliance
export function checkCodeExamplePortCompliance(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const codeBlocks = extractCodeBlocks(content);
  if (codeBlocks.length === 0) return [];

  const portViolations: Array<{ pattern: RegExp; message: string }> = [
    { pattern: /\bDate\(\)/, message: "Date() — inject a Clock port instead" },
    {
      pattern: /\bUUID\(\)/,
      message: "UUID() — inject a UUIDGenerator port instead",
    },
    {
      pattern: /\bFileManager\b/,
      message: "FileManager — inject a FileSystem port instead",
    },
    {
      pattern: /\bURLSession\b/,
      message: "URLSession — inject an HTTPClient port instead",
    },
    {
      pattern: /\bUserDefaults\b/,
      message: "UserDefaults — inject a KeyValueStore port instead",
    },
  ];

  const foundViolations: HardOutputRuleViolation[] = [];

  for (const codeBlock of codeBlocks) {
    if (!isDomainLayerCode(codeBlock)) continue;

    for (const { pattern, message } of portViolations) {
      const globalPattern = new RegExp(pattern.source, "g");
      let match: RegExpExecArray | null;
      while ((match = globalPattern.exec(codeBlock)) !== null) {
        foundViolations.push(
          makeViolation(
            "code_example_port_compliance",
            sectionType,
            `Domain-layer code example uses framework type: ${message}`,
            match[0],
          ),
        );
      }
    }
  }

  return foundViolations;
}

// Rule 18: Generic Over Specific
export function checkGenericOverSpecific(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const lowered = content.toLowerCase();

  const paramSignals = [
    "parameter",
    "configurable",
    "configuration",
    "default value",
    "sensible default",
    "optional",
    "override",
    "customizable",
  ];

  const extensibilitySignals = [
    "extensible",
    "reusable",
    "composable",
    "generic",
    "abstraction",
    "centralized",
    "single source of truth",
    "shared component",
    "common module",
  ];

  const patternSignals = [
    "strategy pattern",
    "builder pattern",
    "factory",
    "protocol",
    "interface",
    "contract",
    "dependency injection",
    "inversion of control",
    "plugin",
    "middleware",
    "decorator",
  ];

  let categoriesPresent = 0;
  if (paramSignals.some((s) => lowered.includes(s))) categoriesPresent++;
  if (extensibilitySignals.some((s) => lowered.includes(s)))
    categoriesPresent++;
  if (patternSignals.some((s) => lowered.includes(s))) categoriesPresent++;

  if (categoriesPresent < 2) {
    return [
      makeAdvisoryViolation(
        "generic_over_specific",
        sectionType,
        "Technical spec lacks scalable design — must demonstrate parameterization (configurable values, defaults) AND extensibility (reusable abstractions, centralized components, design patterns). A solution that requires repeating the same fix across many files is not scalable.",
      ),
    ];
  }

  return [];
}

/** Detect if a code block represents domain/entity/use-case layer code. */
export function isDomainLayerCode(code: string): boolean {
  const lowered = code.toLowerCase();

  const hasDomainSignals =
    lowered.includes("protocol ") ||
    lowered.includes("entity") ||
    lowered.includes("use case") ||
    lowered.includes("usecase") ||
    lowered.includes("domain") ||
    lowered.includes("port") ||
    lowered.includes("repository");

  const hasAdapterSignals =
    lowered.includes("import uikit") ||
    lowered.includes("import swiftui") ||
    lowered.includes("import foundation") ||
    lowered.includes("adapter") ||
    lowered.includes("controller") ||
    lowered.includes("viewmodel") ||
    lowered.includes("@main") ||
    lowered.includes("@objc");

  return hasDomainSignals && !hasAdapterSignals;
}
