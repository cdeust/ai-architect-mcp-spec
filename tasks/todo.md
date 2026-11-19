# Portable Spec Verifier (Codex + Gemini, 2026-08-02)

- [x] Preserve the default `full` profile and the Claude plugin contract.
- [x] Add an opt-in `verifier` profile exposing only deterministic PRD validators.
- [x] Package the same verifier MCP server and skills for Codex and Gemini CLI.
- [x] Add profile-gating, distribution, manifest, and skill validation tests.
- [x] Rebuild committed `dist/` and `mcp-server/` artifacts.
- [x] Document scope, installation, validation evidence, and residual risks.

## Review

- `pnpm build`, `pnpm bundle`, and `pnpm lint` pass.
- `pnpm test` passes all 1,503 Vitest tests; the portable distribution suite
  adds 3 passing Node contract tests outside that documented count.
- Both portable skills and the Codex plugin pass the official validators.
- The existing Claude manifest still selects no profile, preserving the
  17-tool `full` default. The packaged launchers use Bash, as documented, so a
  Windows host needs a Bash-compatible shell.

---

# Fix e2e gaps (run run_mrlqa0aj_u2rh15, 2026-07-15) — rentabilité + fonctionnalité

Réf. preuve : session-optimizer/prd-output/run_mrlq/10-verification-report.md + mémoire Cortex 4334566.

## Lot 1 — packages/validation (agent A)
- [ ] A1. Calibrer les hard-output rules par périmètre projet : les règles transverses (security/data-protection/observability/resilience/database…) doivent (a) accepter un « Non applicable + justification » explicite dans la section, et/ou (b) être conditionnées au profil du projet. Vérifier l'hypothèse racine : règles à mots-clés ANGLAIS sur un PRD FRANÇAIS (no_magic_numbers/consistent_naming rejetés alors que couverts verbatim en français).
- [ ] A2. test_traceability_integrity : reconnaître les fonctions bash (`name() {` et `function name() {`) dans les fences (bash ou non typées), en plus des syntaxes existantes.
- [ ] A3. Tests unitaires pour A1+A2 (fixtures françaises + bash).

## Lot 2 — packages/orchestration/self-check (agent B)
- [ ] B1. Jury : réduire le panel par défaut (1 juge/claim, configurable), ajouter `model`/`effort` aux invocations spawn_subagents (défaut haiku/low pour les juges mécaniques), et gate budget : au-delà d'un cap configurable (défaut 20 invocations), émettre une ask_user au lieu de spawner.
- [ ] B2. Tolérer nativement les réponses `error: skipped` (déjà → INCONCLUSIVE, vérifier + tester).

## Lot 3 — export + enveloppe (agent C)
- [ ] C1. file-export : ne plus écrire de placeholders d'une ligne ; les sections absentes vont dans un unique 00-run-notes.md (sections omises + raison). Exporter le rapport de vérification (self-check summary, verdicts jury, validation graphe) en 10-verification-report.md.
- [ ] C2. Borner l'enveloppe de réponse submit_action_result (même budget/shedding que get_pipeline_state format full — 100K chars MCP).

## Lot 4 — issues amont automatised-pipeline (host)
- [ ] D1. validate_prd_against_graph : symbole d'un fichier non indexable (ex. .sh) → « unverifiable (language not indexed) », pas « hallucinated/critical ».
- [ ] D2. prepare_prd_input : faux positifs lexicaux (« ancre » → _CONCRETE_ANCHOR).

## Gates
- [ ] build tsc clean, suite complète verte (≥631 tests), pas de --no-verify, commits conventionnels sur fix/e2e-gaps, pas de push sans OK user.
