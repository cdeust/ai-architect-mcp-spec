/**
 * End-to-end smoke coverage for the PR 3b post-specs gate
 * (design-phases-3-5.md §2, §5).
 *
 * Separate from smoke.test.ts (already at the file-size cap) — single
 * concern: prove a full pipeline run traverses BOTH branches of
 * `implementation_gate` end to end (not just the single-step injections in
 * implementation-gate.test.ts / pre-impl-grounding.test.ts).
 *
 * Proves:
 *   1. "PRD only" (today's canned-dispatcher default): reaches `done` with
 *      current_step === "complete", never emits a get_impact
 *      call_pipeline_tool (pre_impl_grounding never runs).
 *   2. "Implement" with a codebase + an affected-symbols claim: reaches
 *      `done`, DOES emit get_impact call_pipeline_tool(s) for the claimed
 *      symbol(s), traverses `implementation` (recording a parsed
 *      branch/worktree_path from the canned engineer report) and
 *      `post_impl_verification` (PR 4a wiring), and still completes.
 */

import { describe, expect, it } from "vitest";
import {
  defaultFakeSectionDraft,
  makeCannedDispatcher,
  newPipelineState,
  step,
  type ActionResult,
  type NextAction,
  type PipelineState,
} from "../index.js";

const SAFETY_CAP = 200;

/**
 * Prose that clears every hard-output rule of the live validator for
 * technical_specification. The default canned draft fails those rules, and
 * a failed draft is not a symbol source: no sidecar is built from it and
 * pre_impl_grounding queries none of its symbols
 * (cdeust/ai-architect-mcp-spec#122). The "Implement" path below needs a
 * technical_specification that passed.
 */
const PASSING_TECH_SPEC_BODY: readonly string[] = [
  "### Design",
  "- Scalable design: every limit is a configurable value with a default (parameterization), and providers are added through a reusable abstraction, one centralized component and the strategy design pattern (extensibility).",
  "- SOLID principles: single responsibility (each class is focused and has one reason to change, with a clear separation of concerns), open/closed (extensible without modification), dependency inversion (depend on abstractions, not concretions).",
  "- Access control of code: the public API surface is minimal, everything else is private, and encapsulation is enforced.",
  "- Dependency injection: dependencies are wired through factories in a DI container; business logic never instantiates concrete types directly.",
  "- Code quality standards: code is reusable (shared components, centralized utilities) and readable (clear naming, self-documenting, consistent patterns).",
  "- Naming conventions: camelCase casing style, descriptive names, no abbreviations in public APIs, consistent patterns.",
  "- Immutability: immutable data structures and value types by default, const by default; any mutable state is justified explicitly.",
  "- Defensive coding: guard clauses, preconditions, null safety and bounds checking at all entry points; fail fast on invalid state.",
  "",
  "### Security",
  "- Input validation: every external input (API, user, file, webhook) is validated and sanitized at system boundaries.",
  "- Injection prevention: parameterized queries against SQL injection, output encoding against XSS, input sanitization.",
  "- Authorization: every endpoint requires authentication with OAuth 2.0, roles and permission checks (RBAC).",
  "- Error responses never leak implementation details: no stack traces, internal paths, DB schemas or server versions.",
  "- Cryptographic standards: AES-256-GCM encryption, argon2 hashing for passwords, minimum key size 256 bits, key management with rotation in a KMS.",
  "- Rate limiting: 100 requests per minute per user and per IP, throttling with HTTP 429, abuse prevention on public-facing endpoints.",
  "- Secure communication: TLS 1.3, certificate validation, no mixed content, encrypted channels for all data in transit.",
  "",
  "### Data protection",
  "- Data classification: every data entity has a sensitivity level (public/internal/confidential/restricted) with handling rules per classification.",
  "- Sensitive data protection: encryption at rest, masking/anonymization, and access restrictions for PII and sensitive fields.",
  "- No sensitive data (PII, credentials, tokens) in logs, error messages, URLs or query parameters.",
  "- Data minimization: collect and store only what is necessary, justify every sensitive field, purpose limitation.",
  "- Audit trail: an audit log records who/what/when for authentication events, data access, configuration changes and admin actions.",
  "- Consent management and data erasure: user consent is tracked, deletion cascades through the data model, GDPR compliance.",
  "",
  "### Resilience",
  "- Structured error handling: domain-specific error types, no swallowed exceptions, no generic catch-all, explicit error propagation.",
  "- Resilience patterns: circuit breaker for external dependencies, retry with exponential backoff, timeout on every external call.",
  "- Graceful degradation: fallback behavior when dependencies fail, cascading failures are prevented, degraded operation modes are defined.",
  "- Transaction boundaries: transaction scope, isolation level (read committed), rollback strategy, idempotency for multi-step operations.",
  "- Consistent error response format: a standardized structure with error codes, human-readable messages and machine-readable details (RFC 7807).",
  "- Concurrency safety: shared mutable state is protected by a mutex, thread safety is guaranteed, race conditions are prevented, deadlock avoidance by lock ordering.",
  "- Atomicity: multi-step state changes are atomic operations, with transaction isolation levels and optimistic concurrency control.",
  "",
  "### API and operations",
  "- API contracts: every endpoint documents typed request/response schemas, status codes, error responses and content-type in OpenAPI.",
  "- Deprecation strategy: migration paths for breaking changes, sunset timelines, semantic versioning.",
  "- Structured logging: JSON log format, log levels (DEBUG/INFO/WARN/ERROR), and what is logged at each level.",
  "- Distributed tracing: correlation IDs for cross-service request tracking, trace context propagation, OpenTelemetry observability integration.",
  "- No PII in observability: logs, metrics, traces and dashboards hold no sensitive personal data; masking and redaction are applied.",
  "- Alerting thresholds: an error rate above 1% triggers an alert, with severity levels, escalation paths and on-call routing.",
  "- Dependencies: dependency vulnerability scanning with SCA tooling, CVE monitoring and automated scanning in the CI/CD pipeline; minimal dependency principle: each new dependency is justified, the standard library is preferred, license compliance is verified.",
];

/**
 * technical_specification draft that passes validation and carries an
 * affected-symbols claim, so pre_impl_grounding (when reached) has a symbol
 * to query.
 */
function draftWithAffectedSymbols(section_type: string): string {
  if (section_type !== "technical_specification") {
    return defaultFakeSectionDraft(section_type);
  }
  return [
    defaultFakeSectionDraft(section_type),
    "",
    ...PASSING_TECH_SPEC_BODY,
    "",
    "<!-- AFFECTED_SYMBOLS_JSON -->",
    "```json",
    JSON.stringify({
      affected_symbols: [
        { qualified_name: "src/auth.ts::login", change_kind: "modify" },
      ],
    }),
    "```",
  ].join("\n");
}

function runSmoke(
  seed: Readonly<PipelineState>,
  dispatch: (action: NextAction) => ActionResult | undefined,
) {
  let state: PipelineState = seed;
  let pendingResult: ActionResult | undefined = undefined;
  const observedToolNames: string[] = [];

  for (let i = 0; i < SAFETY_CAP; i++) {
    const out = step({ state, result: pendingResult });
    state = out.state;
    if (out.action.kind === "call_pipeline_tool") {
      observedToolNames.push(out.action.tool_name);
    }
    if (out.action.kind === "done" || out.action.kind === "failed") {
      return { finalAction: out.action, finalState: state, observedToolNames };
    }
    pendingResult = dispatch(out.action);
    if (pendingResult === undefined) {
      throw new Error(`Harness produced no result for action.kind=${out.action.kind}`);
    }
  }
  throw new Error(`Smoke run exceeded safety cap (${SAFETY_CAP} iterations)`);
}

describe("implementation_gate — PRD-only smoke path (zero regression)", () => {
  it("reaches done without ever emitting get_impact", () => {
    const dispatch = makeCannedDispatcher({
      freeform_answer: "smoke-gate-answer",
      graph_path: "/tmp/smoke-gate/.prd-gen/graphs/smoke/graph",
      implementation_gate_answer: "PRD only",
    });
    const seed = newPipelineState({
      run_id: "smoke_gate_prd_only",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/smoke-gate",
    });

    const result = runSmoke(seed, dispatch);

    expect(result.finalAction.kind).toBe("done");
    expect(result.finalState.current_step).toBe("complete");
    expect(result.finalState.post_specs?.decision).toBe("prd_only");
    expect(result.observedToolNames).not.toContain("get_impact");
  });
});

describe("implementation_gate — Implement smoke path (PR 4a: implementation + post-impl verification wired)", () => {
  it("emits get_impact for the claimed symbol, implements, verifies, and reaches done", () => {
    const dispatch = makeCannedDispatcher({
      freeform_answer: "smoke-gate-answer",
      graph_path: "/tmp/smoke-gate-impl/.prd-gen/graphs/smoke/graph",
      implementation_gate_answer: "Implement",
      fake_section_draft: draftWithAffectedSymbols,
    });
    const seed = newPipelineState({
      run_id: "smoke_gate_implement",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/smoke-gate-impl",
    });

    const result = runSmoke(seed, dispatch);

    expect(result.finalAction.kind).toBe("done");
    expect(result.finalState.current_step).toBe("complete");
    expect(result.finalState.post_specs?.decision).toBe("implement");
    expect(
      result.finalState.sections.find((s) => s.section_type === "technical_specification")
        ?.status,
    ).toBe("passed");
    expect(result.observedToolNames).toContain("get_impact");
    expect(result.finalState.post_specs?.impact_queries.done).toBe(true);
    expect(
      result.finalState.post_specs?.impact_queries.results.some(
        (r) => r.qualified_name === "src/auth.ts::login" && r.success,
      ),
    ).toBe(true);
    // PR 4a: implementation ran and recorded a parsed branch/worktree_path
    // from the canned engineer report, then post_impl_verification ran the
    // full 4-call sequence.
    expect(result.finalState.post_specs?.implementation?.branch).toBe(
      "feat/canned-implementation",
    );
    expect(result.finalState.post_specs?.implementation?.worktree_path).toBe(
      "/tmp/canned/implementation-worktree",
    );
    expect(result.observedToolNames).toContain("index_codebase");
    expect(result.observedToolNames).toContain("detect_changes");
    expect(result.observedToolNames).toContain("verify_semantic_diff");
    expect(result.observedToolNames).toContain("check_security_gates");
    expect(result.finalState.post_specs?.verification?.gates_passed).toBe(true);
  });
});
