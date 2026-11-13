/**
 * MCP tool profiles for prd-gen (issue #28).
 *
 * prd-gen is a staged pipeline whose 16 tools split along a boundary that
 * already exists in the design: agent-facing generation/verification tools vs
 * internal diagnostics/telemetry tools. A profile narrows the advertised
 * surface for the common generation session without removing any tool from the
 * `full` surface (non-goal: removing tools — everything stays reachable under
 * `full`).
 *
 * Three profiles:
 *   - `full`  — every registered tool. **The default.**
 *   - `agent` — the agent-facing set: every tool except the internal
 *     diagnostics/telemetry tools listed in {@link INTERNAL_TOOL_NAMES}.
 *   - `verifier` — the two deterministic PRD validators only. This narrow,
 *     host-neutral surface is used by the Codex and Gemini distributions.
 *
 * Default = `full` (documented divergence). Issue #28 criterion 3 asks the
 * default to be the agent-facing set. This wave keeps `full` the default
 * across all three repos (ai-architect-mcp-codebase, Cortex, prd-gen) because
 * shrinking the *default* advertised surface is a breaking change — a client
 * that called a now-hidden tool would break — mirroring ai-architect-mcp-codebase's
 * `ToolProfile` reasoning. `agent` is opt-in via `--profile agent` /
 * `PRD_GEN_PROFILE=agent`. The divergence is recorded in CHANGELOG.md.
 *
 * Selection precedence: `--profile` CLI flag > `PRD_GEN_PROFILE` env var >
 * `full` (matches the `PRD_GEN_*` env convention, e.g. `PRD_GEN_SKILL_CONFIG`).
 */
export const PROFILES = ["full", "agent", "verifier"];
export const PROFILE_FLAG = "--profile";
export const PROFILE_ENV_VAR = "PRD_GEN_PROFILE";
/**
 * Internal diagnostics/telemetry tools — excluded from the `agent` profile and
 * gated (rejected on call) when it is active. source: issue #28 "agent-facing
 * generation tools versus internal pipeline/telemetry tools". This is the ONE
 * place profile membership lives (§1.2): adding an internal tool means adding
 * its name here, nothing else.
 */
export const INTERNAL_TOOL_NAMES = [
    "get_config",
    "read_skill_config",
    "check_health",
    "get_quality_history",
    "get_strategy_effectiveness",
];
const INTERNAL_SET = new Set(INTERNAL_TOOL_NAMES);
/** Deterministic, read-only tools exposed by the portable verifier profile. */
export const VERIFIER_TOOL_NAMES = [
    "validate_prd_section",
    "validate_prd_document",
];
const VERIFIER_SET = new Set(VERIFIER_TOOL_NAMES);
/** Whether `toolName` is advertised under `profile`. */
export function isAllowed(profile, toolName) {
    if (profile === "full")
        return true;
    if (profile === "agent")
        return !INTERNAL_SET.has(toolName);
    return VERIFIER_SET.has(toolName);
}
/**
 * Parse a profile name. Accepts exactly the names in {@link PROFILES}.
 * @throws Error naming the accepted values for any other input.
 */
export function parseProfile(value) {
    if (PROFILES.includes(value)) {
        return value;
    }
    throw new Error(`invalid profile '${value}': expected ${PROFILES.join(", ")}`);
}
/**
 * Resolve the active profile.
 *
 * Precondition: `argv` is the process args (with or without the node/script
 * prefix — the flag is matched positionally); `env` is a string map.
 * Postcondition: the `--profile` value if present, else `PRD_GEN_PROFILE` if
 * set, else `"full"`. Throws for an unknown name in either source, or for a
 * trailing `--profile` with no value.
 */
export function resolveProfile(argv, env) {
    const flagValue = flagValueOf(argv);
    if (flagValue !== undefined)
        return parseProfile(flagValue);
    const envValue = env[PROFILE_ENV_VAR];
    if (envValue)
        return parseProfile(envValue);
    return "full";
}
/** Value of `--profile <v>` / `--profile=<v>` in `argv`; last occurrence wins. */
function flagValueOf(argv) {
    let found;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === PROFILE_FLAG) {
            const next = argv[i + 1];
            if (next === undefined) {
                throw new Error(`${PROFILE_FLAG} requires a value: ${PROFILES.join(", ")}`);
            }
            found = next;
            i++;
        }
        else if (arg.startsWith(PROFILE_FLAG + "=")) {
            found = arg.slice(PROFILE_FLAG.length + 1);
        }
    }
    return found;
}
// ─── Per-profile initialize instructions (criterion 4) ──────────────────────
const FULL_INSTRUCTIONS = "prd-gen — staged PRD generation + verification MCP ('full' profile: every " +
    "tool; the default). The tools are a pipeline and the order is the product; " +
    "calling them out of order does not error, it leaves the pipeline in a wrong " +
    "state. Generation loop: start_pipeline → " +
    "get_pipeline_state → submit_action_result (repeat until done). Verification: " +
    "plan_document_verification / plan_section_verification → submit_action_result " +
    "→ conclude_verification. Deterministic checks: validate_prd_section, " +
    "validate_prd_document, map_failure_to_retrieval. Internal diagnostics " +
    "(get_config, read_skill_config, check_health, get_quality_history, " +
    "get_strategy_effectiveness) are also exposed here. The run_prd_pipeline and " +
    "verify_prd_document prompts (prompts/list) publish the ordering as protocol. " +
    "Restart with --profile agent for the agent-facing subset only.";
const AGENT_INSTRUCTIONS = "prd-gen — staged PRD generation + verification MCP ('agent' profile: the " +
    "agent-facing generation/verification surface). The tools are a pipeline and " +
    "the order is the product; calling them out of order leaves the pipeline in a " +
    "wrong state, not an error. Generation loop: " +
    "start_pipeline → get_pipeline_state → submit_action_result (repeat until " +
    "done). Verification: plan_document_verification / plan_section_verification → " +
    "submit_action_result → conclude_verification, with validate_prd_section / " +
    "validate_prd_document and map_failure_to_retrieval for deterministic checks. " +
    "The internal diagnostics/telemetry tools are hidden AND rejected on call in " +
    "this profile; restart with --profile full to expose them. The " +
    "run_prd_pipeline and verify_prd_document prompts guide the flow.";
const VERIFIER_INSTRUCTIONS = "prd-gen — deterministic PRD structure verifier ('verifier' profile). " +
    "Only validate_prd_section and validate_prd_document are exposed. These " +
    "tools run Hard Output Rules and cross-section consistency checks without " +
    "LLM calls. A passing report establishes structural conformance to those " +
    "rules; it does not establish factual accuracy, implementation feasibility, " +
    "or semantic correctness. Restart with --profile full for the complete " +
    "pipeline or --profile agent for its agent-facing subset.";
export function instructions(profile) {
    if (profile === "agent")
        return AGENT_INSTRUCTIONS;
    if (profile === "verifier")
        return VERIFIER_INSTRUCTIONS;
    return FULL_INSTRUCTIONS;
}
//# sourceMappingURL=tool-profiles.js.map