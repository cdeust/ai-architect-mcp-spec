# Assurance case

An assurance case is an argument, not a checklist: a claim about security, the
reasoning that supports it, and the evidence each step rests on — including
where the argument stops.

*Required by OpenSSF Best Practices silver criterion `assurance_case`.*

## What this software is, in threat terms

`ai-architect-mcp-spec` is a **local MCP server**. A host (Claude Code or another
MCP client) starts it over stdio and drives a stateless reducer that turns a
feature description into PRD sections. It makes **no network calls of its own**
and collects **no telemetry**.

Two properties shape the whole threat model:

1. **Its input is untrusted by construction.** The content it validates is
   LLM-generated text, and the codebase context it may receive comes from
   another tool. Neither is a trusted source.
2. **It runs with the user's own privileges.** There is no privilege boundary
   between the server and the person running it, so the interesting risks are
   not "can it escalate" but "can it be induced to do something on the user's
   behalf that they did not intend" — read a file they did not mean to expose,
   burn unbounded CPU, or ship a compromised artifact.

## Claim 1 — Untrusted input cannot make the validator hang

**Argument.** Every validator is a regex or string pass over attacker-influenced
text, so catastrophic backtracking is the realistic denial-of-service path.

**Evidence.**
- Three polynomial-ReDoS patterns were found by CodeQL and rewritten to be
  linear. They are pinned by a *growth-ratio* test, not a wall-clock threshold:
  doubling the input must not quadruple the time
  (`packages/validation/src/__tests__/regex-hardening.test.ts`).
- That assertion is proven non-vacuous — measured against an injected O(n²)
  worker it reports 4.00 idle and 3.81 under eight competing CPU spinners,
  versus 0.03/0.05 for a linear one.
- `validateSection` is exercised by property-based tests under `fast-check`
  (300 runs × 17 section types), asserting it never throws and always returns a
  score in [0,1] on generated input.

**Limit.** The growth test covers the three patterns that were flagged. A newly
added quadratic pattern elsewhere would not be caught until someone points the
same test at it.

## Claim 2 — Nothing reads a path the user did not choose and sends it out

**Argument.** The only component that talks to a third party is the optional
external-judge calibration harness, which posts prompts to an operator-configured
LLM endpoint. If a *path* could be chosen at run time, the corpus would be
substitutable: point it elsewhere and those bytes leave the machine.

**Evidence.**
- CodeQL's `js/file-access-to-http` found exactly that. It was not guarded but
  **removed**: the corpus is now bound by a static
  `import … with { type: "json" }`, so there is no path variable to redirect,
  and `judge.mjs` reads stdin instead of a `--prompt-file` path.
- The fix was verified against the query's own model rather than by hope —
  `FileAccessToHttpCustomizations.qll` defines only two sanitizers, so no amount
  of validation would have broken the taint. CodeQL CLI reports 1 result before
  and 0 after.
- Open CodeQL alerts on `main`: **0**.

**Limit.** This says nothing about what the *operator's configured endpoint*
does with a prompt. Sending data to a third-party LLM is the declared purpose of
that harness, and it is opt-in.

## Claim 3 — What you install is what we built

**Argument.** A local tool distributed as a prebuilt bundle is a supply-chain
target: the risks are a tampered artifact and a dependency that resolves
differently on your machine than on ours.

**Evidence.**
- Every release carries a Sigstore build-provenance attestation
  (`gh attestation verify`), a published SHA-256, and a CycloneDX SBOM. The
  release job **fails** if `server.json`'s checksum does not equal the built
  artifact.
- Runtime dependencies are resolved in CI from a committed lockfile with
  integrity hashes, not re-resolved on the user's machine
  (`scripts/release/stage-mcpb.sh`).
- Every GitHub Action is pinned by commit SHA, and Dependabot covers both `npm`
  and `github-actions` so a SHA pin cannot quietly rot.
- `pnpm audit --prod --audit-level high` is a blocking CI gate, and the audit
  suppression list is **empty**.

**Limit.** Provenance proves *who built what from which commit*. It says nothing
about whether the source is free of defects, and it is worth nothing to a user
who never runs the verification.

## Claim 4 — A failure announces itself

**Argument.** The most dangerous defect class in this codebase is not a crash;
it is a check that silently stops checking. It has happened twice.

**Evidence.**
- An operator class `[:<≤<=]` never matched `<=`, so NFR statements written the
  ordinary way escaped verification entirely.
- 142 of 217 audit-rule patterns used PCRE inline flags that JavaScript cannot
  compile; both call sites swallowed the `SyntaxError` and returned "no match",
  so roughly two thirds of the audit rules were inert while reporting clean
  documents.
- Both are now fixed **and** pinned: the pattern compiler reports a pattern it
  cannot compile instead of swallowing it, and all 115 shipped rules are
  executed against the `should_flag` / `should_pass` fixtures they declare in
  their own YAML (230 assertions).
- The shipped artifact is started end-to-end in CI (`mcpb smoke`), because a
  green unit suite previously coexisted with a bundle that could not boot.

**Limit.** This argument is about the failure modes we have *found*. Its honest
form is "the two classes of silent failure we hit are now instrumented", not
"there are no others".

## What this case does not claim

- **No formal verification.** Correctness rests on tests and static analysis.
- **No adversarial review.** Nobody has attempted to attack this software; the
  security posture is derived from tooling and reasoning, not from a red team.
- **No multi-party review.** With one maintainer, no change is reviewed by a
  second person — the honest reason the OpenSSF gold criteria are out of reach
  (see [GOVERNANCE.md](../GOVERNANCE.md)).
- **Nothing about the models.** Judge verdicts come from LLMs and are treated as
  fallible: consensus is calibrated against externally-grounded oracles
  precisely because a model's agreement is not evidence.
