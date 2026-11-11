/**
 * The overall status `check_health` reports from its component probes.
 *
 * `check_health` used to answer `status: "ok"` as a literal, whatever the
 * probes found. The 2026-10-10 audit of the v0.8.0 .mcpb (#124) read
 * `status: "ok"` next to `skillAvailable: false` and
 * `evidenceDbHealthy: false`: a host that reads only `status` was told a
 * server with no SKILL.md and no evidence database was healthy.
 *
 * The status is therefore derived from the components, never written down:
 * `ok` only when every component is true, `degraded` otherwise, with the
 * failing components named so the reader does not have to diff booleans.
 * A degraded server still answers (the tool result is not an error): the
 * server is up and can say what is missing, which is the point of the probe.
 */
export function healthStatus(components) {
    const degraded = Object.entries(components)
        .filter(([, healthy]) => !healthy)
        .map(([name]) => name);
    return { status: degraded.length === 0 ? "ok" : "degraded", degraded };
}
//# sourceMappingURL=health-status.js.map