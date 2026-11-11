/**
 * Size contract of the verification stage (#125): no response of
 * `plan_section_verification`, `plan_document_verification` or
 * `conclude_verification` exceeds the 100,000-char budget the server
 * declares (MAX_RESPONSE_CHARS) on a large PRD, and paging the plan loses
 * and duplicates no judge request.
 *
 * Driven through the real `registerPipelineTools` handlers, so the measured
 * text is the text a host receives.
 *
 * source: cdeust/ai-architect-mcp-spec#125 — `plan_document_verification`
 * measured 238,729 chars for 57,992 chars of sections and 4 judge requests
 * on 2026-11-10. This file's fixture (58,000 chars, 8 sections, 47 judge
 * requests) measured 2,803,785 chars unpaged on 2026-11-11, and 268,370
 * chars with the same claims in 4,800 chars of sections: the response grows
 * as judge requests × document.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_RESPONSE_CHARS } from "@prd-gen/orchestration";
import { planDocumentVerification, planSectionVerification } from "@prd-gen/verification";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

let handlers: Map<string, ToolHandler>;

beforeAll(async () => {
  const { registerPipelineTools } = await import("../pipeline-tools.js");
  handlers = new Map();
  const server = {
    tool(name: string, ...rest: unknown[]) {
      handlers.set(name, rest[rest.length - 1] as ToolHandler);
    },
  };
  registerPipelineTools(server as unknown as Parameters<typeof registerPipelineTools>[0]);
});

/**
 * Deterministic filler prose with no claim pattern: one sentence per line,
 * a blank line every fourth, as a PRD is written (a claim's evidence is a
 * few lines around it, so a single 58k line would put the whole section in
 * every claim).
 */
function filler(topic: string, chars: number): string {
  const sentence = `The ${topic} part of the product is described here in plain words for the reader.`;
  let text = "";
  for (let line = 1; text.length < chars; line++) text += sentence + (line % 4 === 0 ? "\n\n" : "\n");
  return text.slice(0, chars);
}

type Section = { type: string; content: string };

/**
 * Eight sections, about 58,000 chars: the size at which the 2026-11-10
 * measurement on #125 found 238,729 chars. Each section carries the lines
 * the claim extractors recognise, then filler up to `perSection` chars.
 */
function largePrd(perSection = 7_250): Section[] {
  const claimLines: Record<string, string[]> = {
    requirements: [
      "- FR-001: The system supports OAuth login via Google and GitHub.",
      "- FR-002: The system stores session tokens in HttpOnly cookies.",
      "- FR-003: The system signs the user out after 30 minutes of inactivity.",
    ],
    acceptance_criteria: [
      "- AC-001: A user with valid Google credentials can sign in.",
      "- AC-002: A user with invalid credentials sees an error message.",
      "- AC-003: `grep -c FAILED report.txt` prints 0 with exit code 0.",
    ],
    technical_specification: [
      "We use ports-and-adapters architecture. The OAuth domain port is",
      "implemented by Google and GitHub adapters at the infrastructure layer.",
    ],
    security_considerations: ["All session tokens use AES-256-GCM. Authentication uses OAuth 2.0."],
    performance_requirements: ["p95 < 250ms for token validation under nominal load."],
    testing: ["Every acceptance criterion has one automated test."],
    risks: ["- The identity provider outage is a risk for every sign-in."],
    deployment: ["The release is rolled out behind a feature flag."],
  };
  return Object.entries(claimLines).map(([type, lines]) => {
    const head = `## ${type}\n\n${lines.join("\n")}\n\n`;
    return { type, content: head + filler(type, perSection - head.length) };
  });
}

function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0].text) as T;
}

interface PlanPageBody {
  claims?: unknown[];
  mechanical_claims?: unknown[];
  judge_requests: unknown[];
  __page: {
    offset: number;
    count: number;
    total: number;
    next_offset: number | null;
    final_chars: number;
    budget_chars: number;
  };
}

/** Follows `__page.next_offset` from 0; returns every response text. */
async function walk(tool: string, args: Record<string, unknown>): Promise<string[]> {
  const texts: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const res: ToolResult = await handlers.get(tool)!({ ...args, request_offset: offset });
    expect(res.isError).toBeFalsy();
    texts.push(res.content[0].text);
    const page = (JSON.parse(res.content[0].text) as PlanPageBody).__page;
    expect(page.offset).toBe(offset);
    offset = page.next_offset;
    if (texts.length > 1_000) throw new Error("walk does not terminate");
  }
  return texts;
}

describe("verification stage: every response within the declared budget (#125)", () => {
  it("plan_document_verification pages a large PRD under the budget, losing and duplicating no judge request", async () => {
    const sections = largePrd();
    const inputChars = sections.reduce((n, s) => n + s.content.length, 0);
    expect(inputChars).toBeGreaterThan(57_000);

    const whole = planDocumentVerification(sections as Parameters<typeof planDocumentVerification>[0], {
      codebase_excerpts: [],
      memory_excerpts: [],
      include_prd_excerpt: true,
    });
    // The fixture is the reported case: unpaged, the plan is over the budget.
    expect(JSON.stringify(whole, null, 2).length).toBeGreaterThan(MAX_RESPONSE_CHARS);
    expect(whole.judge_requests.length).toBeGreaterThan(1);
    expect(whole.mechanical_claims.length).toBeGreaterThan(0);

    const texts = await walk("plan_document_verification", { sections });
    expect(texts.length).toBeGreaterThan(1);
    const pages = texts.map((t) => JSON.parse(t) as PlanPageBody);
    texts.forEach((text, i) => {
      expect(text.length, `page ${i}`).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
      expect(pages[i].__page.final_chars).toBe(text.length);
      expect(pages[i].__page.budget_chars).toBe(MAX_RESPONSE_CHARS);
      expect(pages[i].__page.total).toBe(whole.judge_requests.length);
    });
    expect(pages.flatMap((p) => p.judge_requests)).toEqual(whole.judge_requests);
    expect(pages[0].claims).toEqual(whole.claims);
    expect(pages[0].mechanical_claims).toEqual(whole.mechanical_claims);
    for (const later of pages.slice(1)) {
      expect(later).not.toHaveProperty("claims");
      expect(later).not.toHaveProperty("mechanical_claims");
    }
  });

  it("plan_section_verification pages a large section the same way", async () => {
    const [requirements] = largePrd(58_000);
    const whole = planSectionVerification(
      requirements.type as Parameters<typeof planSectionVerification>[0],
      requirements.content,
      { codebase_excerpts: [], memory_excerpts: [], include_prd_excerpt: true },
    );
    expect(JSON.stringify(whole, null, 2).length).toBeGreaterThan(MAX_RESPONSE_CHARS);

    const texts = await walk("plan_section_verification", {
      section_type: requirements.type,
      content: requirements.content,
    });
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const pages = texts.map((t) => JSON.parse(t) as PlanPageBody);
    expect(pages.flatMap((p) => p.judge_requests)).toEqual(whole.judge_requests);
    expect(pages[0].claims).toEqual(whole.claims);
  });

  it("conclude_verification answers the verdicts of the whole large plan within the budget", async () => {
    const sections = largePrd();
    const whole = planDocumentVerification(sections as Parameters<typeof planDocumentVerification>[0], {
      include_prd_excerpt: true,
    });
    const verdicts = whole.judge_requests.map((r) => ({
      judge: r.judge,
      claim_id: r.claim.claim_id,
      verdict: "PASS",
      rationale: "The claim is supported by the section text quoted as evidence.",
      caveats: [],
      confidence: 0.8,
    }));
    const res = await handlers.get("conclude_verification")!({
      scope: "document",
      verdicts,
      consensus_strategy: "weighted_average",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  });

  it("returns a plan that fits as one page with every field of the plan", async () => {
    // One short section: 3 requirement claims, about 12k chars of plan.
    const sections = largePrd(600).slice(0, 1);
    const whole = planDocumentVerification(sections as Parameters<typeof planDocumentVerification>[0], {
      codebase_excerpts: [],
      memory_excerpts: [],
      include_prd_excerpt: true,
    });
    const res = await handlers.get("plan_document_verification")!({ sections });
    const body = parse<PlanPageBody>(res);
    expect(body.claims).toEqual(whole.claims);
    expect(body.judge_requests).toEqual(whole.judge_requests);
    expect(body.mechanical_claims).toEqual(whole.mechanical_claims);
    expect(body.__page).toMatchObject({
      offset: 0,
      count: whole.judge_requests.length,
      total: whole.judge_requests.length,
      next_offset: null,
      budget_chars: MAX_RESPONSE_CHARS,
    });
    expect(body.__page.final_chars).toBe(res.content[0].text.length);
  });

  it("rejects a request_offset past the end of the plan with a structured error", async () => {
    const sections = largePrd(600).slice(0, 1);
    const res = await handlers.get("plan_document_verification")!({ sections, request_offset: 10_000 });
    expect(res.isError).toBe(true);
    expect(parse<{ error: string }>(res).error).toContain("out of range");
  });
});
