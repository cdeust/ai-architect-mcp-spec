/**
 * The ten seeded defects of the #118 audit, rebuilt as a regression fixture.
 *
 * The audit of 2026-10-10 seeded ten defects into a PRD and ran the
 * deterministic tools on it; its data set is not in the repository. The issue
 * names the ten categories, so each one is rebuilt here as a single mutation
 * of the clean control below, which is the client-side PRD of #117. Each
 * seeded document differs from the control by that one defect, so any finding
 * it draws beyond the control's is a diagnosis of that defect.
 */
import type { SectionType } from "@prd-gen/core";

export type Section = { readonly type: SectionType; readonly content: string };

/** The ten defect categories of the #118 audit, in the order the issue lists them. */
export type DefectCategory =
  | "contradiction"
  | "missing_acceptance_criteria"
  | "unmeasurable_requirement"
  | "wrong_number"
  | "hallucinated_dependency"
  | "duplicate_requirement"
  | "scope_creep"
  | "missing_edge_case"
  | "inconsistent_terminology"
  | "untestable_statement";

export interface SeededDefect {
  readonly category: DefectCategory;
  /** What was changed in the control, in one sentence. */
  readonly seed: string;
  readonly sections: readonly Section[];
}

const OVERVIEW = `## Overview

Add a "Copy" button next to every code block in the documentation viewer.
Clicking it copies the code block's text to the system clipboard and shows a
"Copied" confirmation for two seconds. The feature runs entirely in the
browser: no request leaves the page and nothing is stored.`;

const REQUIREMENTS = `## Requirements

| ID | Requirement | Priority | Source |
|----|-------------|----------|--------|
| FR-001 | Each code block shows a Copy button in its top-right corner. | Must | Reader survey |
| FR-002 | Clicking Copy writes the block's plain text to the clipboard. | Must | Reader survey |
| FR-003 | After a successful copy the button reads "Copied" for two seconds. | Should | Design review |`;

const USER_STORIES = `## User Stories

- STORY-1: As a reader, I copy a code sample in one click so that I can paste it into my terminal. (FR-001, FR-002) — 2 SP
- STORY-2: As a reader, I see that the copy worked so that I do not copy twice. (FR-003) — 1 SP`;

const ACCEPTANCE_CRITERIA = `## Acceptance Criteria

- AC-001 (FR-001): Every rendered code block has exactly one Copy button.
- AC-002 (FR-002): After a click, the clipboard holds the block's text, without line numbers.
- AC-003 (FR-003): The label reads "Copied" for two seconds, then "Copy" again.`;

const TESTING = `## Testing

| Test | Covers | Check |
|------|--------|-------|
| T-001 | AC-001 | Render a page with three code blocks; expect three Copy buttons. |
| T-002 | AC-002 | Click Copy on a numbered block; expect the clipboard text without line numbers. |
| T-003 | AC-003 | Click Copy with a fake timer; expect "Copied", then "Copy" after two seconds. |`;

/** The clean control: the #117 client-side PRD, which passes with a full score. */
export const CLEAN_CONTROL: readonly Section[] = [
  { type: "overview", content: OVERVIEW },
  { type: "requirements", content: REQUIREMENTS },
  { type: "user_stories", content: USER_STORIES },
  { type: "acceptance_criteria", content: ACCEPTANCE_CRITERIA },
  { type: "testing", content: TESTING },
];

function mutate(type: SectionType, edit: (content: string) => string): readonly Section[] {
  const out = CLEAN_CONTROL.map((s) => (s.type === type ? { ...s, content: edit(s.content) } : s));
  if (out.every((s, i) => s.content === CLEAN_CONTROL[i]!.content)) {
    throw new Error(`seed on ${type} changed nothing`);
  }
  return out;
}

/**
 * Add FR-004 with an acceptance criterion and a test, so that the new row is
 * fully traced and the only defect left is the one its wording carries.
 */
function withFr004(requirement: string, criterion: string): readonly Section[] {
  return CLEAN_CONTROL.map((s) => {
    if (s.type === "requirements") {
      return { ...s, content: `${s.content}\n| FR-004 | ${requirement} | Should | Design review |` };
    }
    if (s.type === "acceptance_criteria") {
      return { ...s, content: `${s.content}\n- AC-004 (FR-004): ${criterion}` };
    }
    if (s.type === "testing") {
      return { ...s, content: `${s.content}\n| T-004 | AC-004 | ${criterion} |` };
    }
    return s;
  });
}

function replaceOnce(content: string, from: string, to: string): string {
  if (!content.includes(from)) throw new Error(`seed anchor not found: ${from}`);
  return content.replace(from, to);
}

export const SEEDED_DEFECTS: readonly SeededDefect[] = [
  {
    category: "contradiction",
    seed: "A requirement keeps the confirmation for five seconds, against FR-003's two.",
    sections: withFr004(
      'After a successful copy the button reads "Copied" for five seconds.',
      'The label reads "Copied" for five seconds after a copy.',
    ),
  },
  {
    category: "missing_acceptance_criteria",
    seed: "AC-003 is removed, so FR-003 has no acceptance criterion.",
    sections: mutate("acceptance_criteria", (c) =>
      replaceOnce(c, `\n- AC-003 (FR-003): The label reads "Copied" for two seconds, then "Copy" again.`, ""),
    ),
  },
  {
    category: "unmeasurable_requirement",
    seed: "A requirement asks for a fast, user-friendly copy with no measure.",
    sections: withFr004(
      "Copying must be fast and user-friendly.",
      "Copying feels fast and user-friendly.",
    ),
  },
  {
    category: "wrong_number",
    seed: "The stories state a 5 SP total; the two stories sum to 3 SP.",
    sections: mutate("user_stories", (c) => `${c}\n\nTotal: 5 SP`),
  },
  {
    category: "hallucinated_dependency",
    seed: "STORY-2 depends on STORY-7, which the document does not define.",
    sections: mutate("user_stories", (c) =>
      replaceOnce(c, "(FR-003) — 1 SP", "(FR-003) Depends on STORY-7. — 1 SP"),
    ),
  },
  {
    category: "duplicate_requirement",
    seed: "A second row reuses the identifier FR-002.",
    sections: mutate("requirements", (c) =>
      `${c}\n| FR-002 | The button is keyboard reachable. | Must | Accessibility audit |`,
    ),
  },
  {
    category: "scope_creep",
    seed: "A requirement syncs copied snippets to a cloud account, against 'nothing is stored'.",
    sections: withFr004(
      "Every copied snippet is saved to the reader's cloud account history.",
      "After a copy, the snippet appears in the reader's cloud account history.",
    ),
  },
  {
    category: "missing_edge_case",
    seed: "The clipboard-denied case is introduced in the overview and covered by no requirement.",
    sections: mutate("overview", (c) =>
      `${c}\nSome browsers deny clipboard access to pages that are not focused.`,
    ),
  },
  {
    category: "inconsistent_terminology",
    seed: "The acceptance criteria call the Copy button the 'Clone control'.",
    sections: mutate("acceptance_criteria", (c) =>
      replaceOnce(c, "has exactly one Copy button.", "has exactly one Clone control."),
    ),
  },
  {
    category: "untestable_statement",
    seed: "AC-003 states that readers love the confirmation.",
    sections: mutate("acceptance_criteria", (c) =>
      replaceOnce(
        c,
        `The label reads "Copied" for two seconds, then "Copy" again.`,
        "Readers love the confirmation.",
      ),
    ),
  },
];
