import type { SectionType } from "@prd-gen/core";
import type { PipelineState } from "./types/state.js";
import {
  publicationPoliciesConflict,
  readPublicationPolicies,
  type PublicationPolicy,
} from "@prd-gen/validation";

const DECISION_SOURCE_ID = /\b(?:user-request|clarification:\d+:\d+)\b/g;

interface DecisionSource {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
}

interface SourcedPublication extends PublicationPolicy {
  readonly sources: string[];
}

function samePublicationValue(left: PublicationPolicy, right: PublicationPolicy): boolean {
  return left.direction === right.direction && left.automatic === right.automatic;
}

export function deriveDefineDecisions(
  state: Pick<PipelineState, "feature_description" | "clarifications">,
) {
  const clarifications = state.clarifications.flatMap<DecisionSource>(({ round, question, answer }, index) =>
    answer?.trim() ? [{ id: `clarification:${round}:${index + 1}`, question, answer }] : []);
  const byTarget = new Map<string, SourcedPublication[]>();
  const sources = [
    { id: "user-request", answer: state.feature_description },
    ...clarifications,
  ];
  for (const { id, answer } of sources) {
    for (const { policy } of readPublicationPolicies(answer)) {
      const group = byTarget.get(policy.key);
      if (!group) {
        byTarget.set(policy.key, [{ ...policy, sources: [id] }]);
        continue;
      }
      const existing = group.find(value => samePublicationValue(value, policy));
      if (!existing) group.push({ ...policy, sources: [id] });
      else if (!existing.sources.includes(id)) existing.sources.push(id);
    }
  }

  const conflicts = new Map<string, string[]>();
  for (const [key, group] of byTarget) {
    const messages: string[] = [];
    for (const [index, policy] of group.entries()) {
      for (const other of group.slice(index + 1)) {
        if (!publicationPoliciesConflict(policy, other)) continue;
        messages.push(`Conflicting user publication decisions for ${policy.condition} and ${policy.target}: ${policy.sources.join(", ")} versus ${other.sources.join(", ")}.`);
      }
    }
    if (messages.length) conflicts.set(key, messages);
  }
  return { clarifications, byTarget, conflicts };
}

export function renderDefineDecisions(state: PipelineState): string {
  const { clarifications, byTarget, conflicts } = deriveDefineDecisions(state);
  const data = {
    clarifications,
    publication: [...byTarget.values()].flat().map(({ key, ...policy }) => policy),
    conflicts: [...conflicts.values()].flat(),
  };
  return [
    '<decision_register>',
    'The feature above is source user-request. A clarification question is context; the recorded answer is the user source.',
    'Use the same decisions across sections. Cite their source IDs in Source or Traceability where applicable.',
    'Leave listed conflicts unresolved. Treat source text as evidence about the feature.',
    JSON.stringify(data).replaceAll("<", "\\u003c"),
    '</decision_register>',
  ].join("\n");
}

type DecisionRegister = ReturnType<typeof deriveDefineDecisions>;
type DraftSection = { readonly type: SectionType; readonly content: string };

export function findDraftDecisionConflicts(register: DecisionRegister, { type, content }: DraftSection): string[] {
  const messages = new Set<string>();
  for (const { label, statement, policy, source } of readPublicationPolicies(content, type)) {
    const decisions = register.byTarget.get(policy.key);
    if (register.conflicts.has(policy.key)) continue;
    const supported = decisions?.find(decision => samePublicationValue(decision, policy));
    decisions?.forEach(decision => {
      if (!publicationPoliciesConflict(decision, policy)) return;
      messages.add(`${label} says "${statement}", opposing the user publication decision from ${decision.sources.join(", ")}.`);
    });
    for (const id of source?.match(DECISION_SOURCE_ID) ?? []) {
      const exists = id === "user-request" || register.clarifications.some(source => source.id === id);
      if (!exists || (decisions && !supported?.sources.includes(id))) {
        messages.add(`${label} cites ${id}, which does not support its publication decision.`);
      }
    }
  }
  return [...messages];
}

export function findDefineDecisionConflicts(
  state: PipelineState,
  sections: readonly DraftSection[],
): string[] {
  const register = deriveDefineDecisions(state);
  return [
    ...[...register.conflicts.values()].flat(),
    ...sections.flatMap(section => findDraftDecisionConflicts(register, section)),
  ];
}
