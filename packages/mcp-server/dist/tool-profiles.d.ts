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
export declare const PROFILES: readonly ["full", "agent", "verifier"];
export type ToolProfile = (typeof PROFILES)[number];
export declare const PROFILE_FLAG = "--profile";
export declare const PROFILE_ENV_VAR = "PRD_GEN_PROFILE";
/**
 * Internal diagnostics/telemetry tools — excluded from the `agent` profile and
 * gated (rejected on call) when it is active. source: issue #28 "agent-facing
 * generation tools versus internal pipeline/telemetry tools". This is the ONE
 * place profile membership lives (§1.2): adding an internal tool means adding
 * its name here, nothing else.
 */
export declare const INTERNAL_TOOL_NAMES: readonly ["get_config", "read_skill_config", "check_health", "get_quality_history", "get_strategy_effectiveness"];
/** Deterministic, read-only tools exposed by the portable verifier profile. */
export declare const VERIFIER_TOOL_NAMES: readonly ["validate_prd_section", "validate_prd_document"];
/** Whether `toolName` is advertised under `profile`. */
export declare function isAllowed(profile: ToolProfile, toolName: string): boolean;
/**
 * Parse a profile name. Accepts exactly the names in {@link PROFILES}.
 * @throws Error naming the accepted values for any other input.
 */
export declare function parseProfile(value: string): ToolProfile;
/**
 * Resolve the active profile.
 *
 * Precondition: `argv` is the process args (with or without the node/script
 * prefix — the flag is matched positionally); `env` is a string map.
 * Postcondition: the `--profile` value if present, else `PRD_GEN_PROFILE` if
 * set, else `"full"`. Throws for an unknown name in either source, or for a
 * trailing `--profile` with no value.
 */
export declare function resolveProfile(argv: readonly string[], env: Record<string, string | undefined>): ToolProfile;
export declare function instructions(profile: ToolProfile): string;
//# sourceMappingURL=tool-profiles.d.ts.map