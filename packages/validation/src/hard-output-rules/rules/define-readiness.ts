import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { proseLines, requirementDefinitions } from "./requirement-definitions.js";

type Sections = ReadonlyArray<{ type: SectionType; content: string }>;

/** The authoring format in meta-prompting/src/section-prompts.ts supplies the IDs. */
export function checkPrdDefinitions(sections: Sections): HardOutputRuleViolation[] {
  const findings: HardOutputRuleViolation[] = [];
  for (const { type, content } of sections) {
    if (type !== "requirements" && type !== "acceptance_criteria") continue;
    const definitions = requirementDefinitions(content, type === "requirements" ? undefined : ["AC"]);
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
}

function* policyStatements(type: SectionType, content: string) {
  for (const { id, text } of requirementDefinitions(content)) {
    const body = text.replace(/^:(?:\*\*)?/, "");
    for (const statement of body.split("\n")) yield { label: `${type}/${id}`, statement: statement.trim() };
  }
  for (const statement of proseLines(content)) yield { label: type, statement: statement.trim() };
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
    direction: prohibition === undefined ? "publish" : "refuse",
    automatic: object !== target,
  } as const;
}

function oppositeSource(
  observed: Map<string, PublicationSource>,
  publication: NonNullable<ReturnType<typeof parsePublication>>,
  section: number,
) {
  const { key, direction, automatic } = publication;
  const opposite = direction === "publish" ? "refuse" : "publish";
  const broad = observed.get(`${opposite}\nfalse\n${key}`);
  const narrow = observed.get(`${opposite}\ntrue\n${key}`);
  const allowsBroad = direction === "publish" || !automatic;
  const allowsNarrow = direction === "refuse" || automatic;
  if (allowsBroad && broad && broad.section !== section) return broad;
  if (allowsNarrow && narrow && narrow.section !== section) return narrow;
}

export function checkPublicationPolicy(sections: Sections): HardOutputRuleViolation[] {
  const observed = new Map<string, PublicationSource>();
  const reported = new Set<string>();
  const findings: HardOutputRuleViolation[] = [];
  for (const [section, { type, content }] of sections.entries()) {
    for (const { label, statement } of policyStatements(type, content)) {
      const publication = parsePublication(statement);
      if (!publication) continue;
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
        if (!observed.has(samePolarity)) observed.set(samePolarity, { section, label, statement });
      }
    }
  }
  return findings;
}

/** Run the deterministic blockers again at a resumed implementation gate. */
export function validateDefineReadiness(sections: Sections): HardOutputRuleViolation[] {
  return [...checkPrdDefinitions(sections), ...checkPublicationPolicy(sections)];
}
