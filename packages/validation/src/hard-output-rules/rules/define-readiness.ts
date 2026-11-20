import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { ACCEPTANCE_REFERENCES, DEFINE_REQUIREMENT_OPTIONS, proseLines, requirementDefinitions } from "./requirement-definitions.js";

type Sections = ReadonlyArray<{ type: SectionType; content: string }>;

/** The authoring format in meta-prompting/src/section-prompts.ts supplies the IDs. */
export function checkPrdDefinitions(sections: Sections): HardOutputRuleViolation[] {
  const findings: HardOutputRuleViolation[] = [];
  for (const { type, content } of sections) {
    if (type !== "requirements" && type !== "acceptance_criteria") continue;
    const definitions = requirementDefinitions(content, type === "requirements" ? undefined : ["AC"], DEFINE_REQUIREMENT_OPTIONS);
    if (definitions.some(({ text }) => /[\p{L}\p{N}]/u.test(text))) continue;
    const expected = type === "requirements" ? "FR or NFR" : "AC";
    findings.push(makeViolation("missing_prd_definitions", type, `The ${type} section must define at least one ${expected} statement.`));
  }
  return findings;
}

// Recognize the pilot's explicit conditional publication grammar in prose.
// The option, its value and the publication target must all match. Quantity
// comparisons and general natural-language entailment are separate checks.
const CONDITIONAL_POLICY = /^With `(--[a-z][a-z0-9-]*(?: [a-z0-9][a-z0-9-]*)?)`,?([ \t].*)$/i;
const PUBLICATION = /^(?:(stop after CI and never |never ))?publish (the .+)/i;

interface PublicationSource {
  readonly section: number;
  readonly label: string;
  readonly statement: string;
  readonly policy: PublicationPolicy;
}

function* policyStatements(type: SectionType | undefined, content: string) {
  const prefixes = type === "acceptance_criteria" ? ["AC"] : undefined;
  const definitions = requirementDefinitions(content, prefixes, DEFINE_REQUIREMENT_OPTIONS);
  for (const { id, text, source } of definitions) {
    const body = text.replace(/^:(?:\*\*)?/, "");
    for (const statement of body.split("\n")) yield { label: type ? `${type}/${id}` : id, statement: statement.trim(), source };
  }
  for (const statement of proseLines(content, true)) yield { label: type ?? "user", statement: statement.trim(), source: undefined };
}

function parsePublication(statement: string) {
  const conditional = CONDITIONAL_POLICY.exec(statement);
  if (!conditional) return;
  const [, condition, instruction] = conditional;
  const publication = PUBLICATION.exec(instruction!.trimStart().replace(/\.$/, ""));
  if (!publication) return;
  const [, prohibition, target] = publication;
  const object = target!.replace(/ automatically$/i, "");
  return {
    condition: condition!,
    key: `${condition}\n${object}`,
    target: object,
    direction: prohibition === undefined ? "publish" : "refuse",
    automatic: object !== target,
  } as const;
}

export type PublicationPolicy = NonNullable<ReturnType<typeof parsePublication>>;

export function* readPublicationPolicies(content: string, type?: SectionType) {
  for (const { label, statement, source } of policyStatements(type, content)) {
    const body = type === "acceptance_criteria" ? statement.replace(ACCEPTANCE_REFERENCES, "") : statement;
    const policy = parsePublication(body);
    if (policy) yield { label, statement, policy, source };
  }
}

export function publicationPoliciesConflict(left: PublicationPolicy, right: PublicationPolicy): boolean {
  return left.key === right.key && left.direction !== right.direction &&
    (left.direction === "publish" ? left.automatic || !right.automatic : right.automatic || !left.automatic);
}

function oppositeSource(
  observed: Map<string, PublicationSource>,
  publication: PublicationPolicy,
  section: number,
) {
  const { key, direction } = publication;
  const opposite = direction === "publish" ? "refuse" : "publish";
  const broad = observed.get(`${opposite}\nfalse\n${key}`);
  const narrow = observed.get(`${opposite}\ntrue\n${key}`);
  return [broad, narrow].find(source => source && source.section !== section &&
    publicationPoliciesConflict(publication, source.policy));
}

export function checkPublicationPolicy(sections: Sections): HardOutputRuleViolation[] {
  const observed = new Map<string, PublicationSource>();
  const reported = new Set<string>();
  const findings: HardOutputRuleViolation[] = [];
  for (const [section, { type, content }] of sections.entries()) {
    for (const { label, statement, policy: publication } of readPublicationPolicies(content, type)) {
      const { condition, key, direction, automatic } = publication;
      if (reported.has(key)) continue;
      const against = oppositeSource(observed, publication, section);
      if (against) {
        findings.push(makeViolation(
          "contradictory_publication_policy",
          null,
          `Conflicting publication instructions for ${condition}: ${against.label} says "${against.statement}"; ${label} says "${statement}".`,
          statement,
        ));
        reported.add(key);
      } else {
        const samePolarity = `${direction}\n${automatic}\n${key}`;
        if (!observed.has(samePolarity)) observed.set(samePolarity, { section, label, statement, policy: publication });
      }
    }
  }
  return findings;
}

/** Run the deterministic blockers again at a resumed implementation gate. */
export function validateDefineReadiness(sections: Sections): HardOutputRuleViolation[] {
  return [...checkPrdDefinitions(sections), ...checkPublicationPolicy(sections)];
}
