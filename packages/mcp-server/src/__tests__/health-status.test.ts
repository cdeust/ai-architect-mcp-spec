/**
 * Pins the regression from #124: `check_health` answered `status: "ok"` while
 * `skillAvailable` and `evidenceDbHealthy` were false. The status must follow
 * the component probes, and name the ones that failed.
 */
import { describe, expect, it } from "vitest";

import { healthStatus } from "../health-status.js";

describe("healthStatus", () => {
  it("is ok only when every component is true", () => {
    expect(
      healthStatus({ configAvailable: true, skillAvailable: true, evidenceDbHealthy: true }),
    ).toEqual({ status: "ok", degraded: [] });
  });

  it("is degraded and names the failing components (the v0.8.0 .mcpb case)", () => {
    expect(
      healthStatus({ configAvailable: true, skillAvailable: false, evidenceDbHealthy: false }),
    ).toEqual({ status: "degraded", degraded: ["skillAvailable", "evidenceDbHealthy"] });
  });

  it("is degraded when a single component is false", () => {
    expect(
      healthStatus({ configAvailable: false, skillAvailable: true, evidenceDbHealthy: true }),
    ).toEqual({ status: "degraded", degraded: ["configAvailable"] });
  });
});
