import { z } from "zod";
import { PRD_CONTEXT_CONFIGS, type PRDContext } from "./prd-context.js";
import type { SectionType } from "./section-type.js";

/**
 * The size of a request, declared by the host at start_pipeline (#119). It
 * is a second axis, beside the kind of PRD (`PRDContext`): a bug fix is a
 * `bug` whether it is one line or a rewrite, and stays one in its prompts,
 * its messages and its evidence. The size changes only how much is asked and
 * written.
 *
 * `standard` is the absence of a declaration: the kind decides, as before.
 * `tiny` is the fast path #119 asks for.
 */
export const RequestSizeSchema = z.enum(["standard", "tiny"]);
export type RequestSize = z.infer<typeof RequestSizeSchema>;

export const REQUEST_SIZE_DEFAULT: RequestSize = "standard";

/** What a size puts in place of the plan of the kind. */
export interface RequestSizePlan {
  readonly clarificationRange: readonly [min: number, max: number];
  /** The sections of a run of this size, in order. */
  readonly sections: readonly SectionType[];
  /** The kinds that keep their own plan whatever the size. */
  readonly notFor: readonly PRDContext[];
}

export interface RequestSizeConfig {
  readonly displayName: string;
  /** The plan of a run of this size; null: the plan of its kind. */
  readonly plan: RequestSizePlan | null;
}

/**
 * source of `tiny`: the sections are the four #119 names ("overview,
 * functional requirements, acceptance criteria, tests"). The clarification
 * range [4, 5] is the smallest any kind uses (`poc`): fewer rounds need a
 * measurement, not a guess. An incident is not a fast path: its report needs
 * its security, deployment and risks sections whatever the size of the
 * change that caused it ("a one-line config change took down checkout").
 */
export const REQUEST_SIZE_CONFIGS: Record<RequestSize, RequestSizeConfig> = {
  standard: { displayName: "Standard", plan: null },
  tiny: {
    displayName: "Tiny change",
    plan: {
      clarificationRange: [4, 5],
      sections: ["overview", "requirements", "acceptance_criteria", "testing"],
      notFor: ["incident"],
    },
  },
};

/**
 * postcondition: the plan a run of this kind is held to by its declared
 *                size, or null when its kind decides: no size was declared,
 *                or the size is not for this kind.
 */
export function requestSizePlan(context: PRDContext, declared: RequestSize): RequestSizePlan | null {
  const plan = REQUEST_SIZE_CONFIGS[declared].plan;
  return plan === null || plan.notFor.includes(context) ? null : plan;
}

/**
 * postcondition: the size a run of this kind is held to: the declared one
 *                when its plan applies to the kind, `standard` otherwise.
 */
export function effectiveRequestSize(context: PRDContext, declared: RequestSize): RequestSize {
  return requestSizePlan(context, declared) === null ? REQUEST_SIZE_DEFAULT : declared;
}

/**
 * postcondition: the clarification range of a run: the one of the plan of
 *                its size when one applies, else the one of its kind.
 */
export function clarificationRangeFor(
  context: PRDContext,
  declared: RequestSize,
): readonly [min: number, max: number] {
  return requestSizePlan(context, declared)?.clarificationRange ?? PRD_CONTEXT_CONFIGS[context].clarificationRange;
}
