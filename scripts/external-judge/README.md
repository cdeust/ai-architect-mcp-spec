# External judge adapter

Host-side executor for cross-vendor (non-Anthropic) judge slots in the
self-check jury's model-diversity panel. The pipeline is host-driven: when a
`spawn_subagents` invocation names a `model` that is not an Anthropic model,
the host cannot dispatch it via the Agent tool — it calls this script
instead, which POSTs the judge prompt to an OpenAI-compatible chat
completions endpoint and returns the parsed verdict.

Rationale: **Cognitive Monoculture mitigation** (arXiv:2602.11865) —
persona-diverse judges running on one underlying model family are not
independent verifiers. Cross-vendor judge slots break the single-family
ceiling. See `docs/design-phases-3-5.md` §7 for the full design context.

Zero npm dependencies. Node ≥20, native `fetch`.

## Files

```
scripts/external-judge/
  judge.mjs            CLI: run one judge prompt against one external model
  calibrate.mjs         CLI: run the 10-claim calibration sweep + admission gate
  lib/
    config.mjs           provider presets + env/flag resolution
    openai-client.mjs     fetch wrapper: 429 backoff, timeout, Mistral throttle
    verdict-extract.mjs   tolerant JSON-verdict extraction from a raw reply
    backoff.mjs           pure backoff-delay computation
    redact.mjs            credential redaction for any debug output
    judge-core.mjs         runJudge() — the "no key -> skip, never fabricate" gate
    prompt-builder.mjs     claim-scoped prompt construction (calibration only)
  fixtures/
    01-prd.md              real e2e PRD fixture (copied from session-optimizer
                            run_mrlqa0aj_u2rh15 — same fixture source as
                            packages/verification/src/__tests__/claim-tier.test.ts)
    01-prd-precorrection-us01.md   AC-008 ONLY: historical/reconstructed
                            pre-correction US-01 text. PROVENANCE ONLY — the
                            text itself is inlined in ground-truth.json and a
                            test pins the two byte-for-byte (see "AC-008 is
                            judged on historical text" below)
    10-verification-report.md   the real jury report this run's ground truth is
                            transcribed from
    ground-truth.json      10 claims, claim-scoped inline evidence, recorded
                            verdicts. Loaded by static `import ... with
                            { type: "json" }`, never read at run time
  __tests__/               node --test unit tests (no network)
```

## Provider setup

### Google AI Studio (Gemini, OpenAI-compatible, free tier)

1. Go to <https://aistudio.google.com/apikey> and click "Create API key"
   (2 clicks, no billing setup required for the free tier).
2. `export GEMINI_API_KEY=...` (or pass `--api-key` directly).
3. Base URL and a default model are pre-filled by `--provider gemini`
   (`https://generativelanguage.googleapis.com/v1beta/openai/`,
   `gemini-2.0-flash` — source: <https://ai.google.dev/gemini-api/docs/openai>,
   accessed 2026-07-15; override with `--model` if Google ships a newer
   default).

### Mistral La Plateforme ("Experiment" free tier)

1. Go to <https://console.mistral.ai/> → API Keys → create a key under the
   Experiment (free) plan.
2. `export MISTRAL_API_KEY=...`.
3. Base URL and a default model are pre-filled by `--provider mistral`
   (`https://api.mistral.ai/v1/`, `mistral-small-latest` — source:
   <https://docs.mistral.ai/getting-started/models/>, accessed 2026-07-15).
4. **Rate limit**: the Experiment tier is user-constrained to ~2 req/min for
   this task. `judge.mjs`/`calibrate.mjs` enforce a client-side 30s floor
   between consecutive requests to a `mistral` provider config
   (`lib/backoff.mjs` `MIN_INTERVAL_MS`), independent of whether the server
   actually returns a 429 — do not bypass this by calling the underlying
   `lib/` functions directly in a tight loop.

## Running a single judge call

```bash
# From a prompt file (the shell opens it — judge.mjs itself opens no files):
node scripts/external-judge/judge.mjs --provider gemini < /tmp/prompt.txt

# From a pipe:
cat /tmp/prompt.txt | node scripts/external-judge/judge.mjs --provider mistral

# Custom (non-preset) OpenAI-compatible endpoint:
node scripts/external-judge/judge.mjs \
  --base-url https://my-endpoint/v1/ --model my-model --api-key sk-... \
  < /tmp/prompt.txt
```

Output (stdout, one JSON line):
```json
{"status":"ok","verdict":{"verdict":"PASS","rationale":"...","caveats":[],"confidence":0.85},"model":"gemini-2.0-flash","provider":"gemini","latency_ms":842}
```
or, with no key configured:
```json
{"status":"skipped","reason":"no credentials — set EXTERNAL_JUDGE_API_KEY (or provider-specific GEMINI_API_KEY)"}
```
A batched judge prompt (one prompt per judge, issue #119) is answered with a
JSON array; the result then carries `verdicts`, one object per element with
its `claim_id`, instead of `verdict`:
```json
{"status":"ok","verdicts":[{"claim_id":"FR-001","verdict":"PASS","rationale":"...","caveats":[],"confidence":0.85}],"model":"gemini-2.0-flash","provider":"gemini","latency_ms":842}
```
The host passes `verdicts` back as the invocation's `raw_text` (a JSON
array); an element without a string `claim_id` or with an invalid verdict is
an `error`, never a partial list.
`skipped` and `error` never carry a `verdict` or `verdicts` field — the host must not
treat their absence as any particular verdict. This is the graceful-
degradation contract: no API key configured means no verdict is produced,
never a fabricated one.

## Running calibration

Once a key exists:

```bash
# Gemini:
export GEMINI_API_KEY=...
node scripts/external-judge/calibrate.mjs --provider gemini

# Mistral (takes ~4.5 minutes for 10 claims at the enforced 30s floor):
export MISTRAL_API_KEY=...
node scripts/external-judge/calibrate.mjs --provider mistral

# Tighter/looser admission threshold:
node scripts/external-judge/calibrate.mjs --provider gemini --min-agreement 0.8
```

Exit code is 0 iff the agreement rate over scored (non-skipped) claims meets
`--min-agreement` (default 0.7); 1 if it runs and falls short; 0 with an
explicit "nothing to calibrate" notice if every claim was skipped (no
credentials) — a missing key is never reported as gate failure.

## Admission rule

A judge model is wired into the self-check jury's `diversity_models` slot
(see `docs/design-phases-3-5.md` §7) **only after both**:

1. `calibrate.mjs` agreement rate ≥ `--min-agreement` (default 0.7) against
   the 10 recorded ground-truth verdicts in `fixtures/ground-truth.json`, **AND**
2. the judge actually returns `FAIL` on claim `AC-008` — the deliberate
   discriminator claim (a US-01/AC-008 uniform-vs-segmented-rendering
   contradiction; see `fixtures/ground-truth.json`'s `provenance.note_on_ac008`).

Condition 2 exists because condition 1 alone is gameable: 7 of the 10
ground-truth claims resolve to `PASS`, so a judge that always answers
`PASS` scores 0.7 agreement — at the default threshold — while providing
zero independent verification value. `calibrate.mjs` reports both numbers
separately; do not admit a judge on agreement rate alone.

**AC-008 is judged on historical text, not `fixtures/01-prd.md`.** Every
other claim's evidence is a claim-scoped excerpt of `fixtures/01-prd.md`
(the corrected PRD). AC-008 is the exception: its `evidence` is the
historical pre-correction US-01 text, and its `evidence_source` field
records the file that text was taken from,
`fixtures/01-prd-precorrection-us01.md`. That field is **provenance only** —
nothing reads it at run time (see "No runtime file reads" below); a test
pins the inline evidence byte-for-byte against the file it names, so the
pointer cannot drift from the text it documents.
The reason is structural, not incidental — `fixtures/01-prd.md` as
committed already contains the corrected, post-jury US-01 wording (the
contradiction resolved), so a judge reading it can legitimately answer
`PASS`, which would silently defeat condition 2 above: the calibration
would no longer be testing whether the judge can catch a real
uniform-vs-segmented-rendering contradiction, only whether it can read
already-corrected text. `01-prd-precorrection-us01.md`'s own header
documents exactly what is verbatim-quoted from git (two fragments, in
`10-verification-report.md:24` and `01-prd.md:53`) versus reconstructed
from those fragments — no git commit holds the full historical wording,
so this is disclosed rather than presented as a recovered blob.

## No runtime file reads

Everything this harness sends leaves the machine for a third-party LLM
endpoint, so **nothing in the prompt→network path opens a file at run
time.** The corpus is bound by a static
`import ... with { type: "json" }` of `fixtures/ground-truth.json`, and
`judge.mjs` takes its prompt from stdin.

This is a deliberate structural property, not a style choice. Both inputs
were previously paths chosen at run time — `prompt_source` named a file in
the claim DATA, and `--prompt-file` named one on the command line — which
made the corpus substitutable: point either at another file and its
contents are posted to a third-party API. Containment checks can guard such
a read (and did, for `prompt_source`); removing the read removes the class.
CodeQL `js/file-access-to-http` reported exactly this flow and now reports
nothing. Three tests pin it: no `node:fs` import or `readFileSync` call in
any module on the path, the static-import binding in `calibrate.mjs`, and
the AC-008 provenance equality above.

## Data-privacy note

Google AI Studio's and Mistral's **free tiers** may use request data
(including prompts) to improve their models — this is standard for
no-cost API tiers and is documented in each provider's terms of service.
**Do not send client-sensitive or confidential PRDs through these free-tier
endpoints.** `fixtures/01-prd.md` in this directory is a synthetic/internal
tooling PRD (a statusline color-rendering change) with no client data —
safe for calibration. For any judge slot handling real project PRDs in
production, either use a paid tier with a no-training data-use guarantee,
or keep cross-vendor judge slots opt-in and scoped to non-sensitive runs.

## Honest limits

Cross-vendor judges are **not** perfect statistical independence — Gemini
and Mistral may share training-data provenance, RLHF methodology
influences, or correlated blind spots with each other or with the
Anthropic-model judges already in the panel. What cross-vendor slots
concretely buy is breaking the **single-family ceiling**: three genius
personas all running on the same underlying model share that model's
specific failure modes (arXiv:2602.11865's "Cognitive Monoculture"
finding), so even an imperfectly-independent second vendor is strictly more
informative than a fourth same-vendor persona. Treat calibration results as
"does this judge notice things the existing panel might correlate on,"
not "is this judge a ground-truth oracle."

## Testing

```bash
pnpm run test:external-judge
# or directly:
node --test scripts/external-judge/__tests__/*.test.mjs
```

All tests mock `fetch` (or exercise pure functions) — **zero real network
calls**, safe for CI. `judge.mjs`/`calibrate.mjs` themselves are not run in
CI (they require live credentials by design); only the `lib/` unit tests
and the prompt-construction/ground-truth tests run automatically. To add
this to CI, add a step running `pnpm run test:external-judge` alongside the
existing `pnpm test` step in `.github/workflows/ci.yml` — not done in this
change (out of scope: this PR touches `scripts/` + `docs/` only).
