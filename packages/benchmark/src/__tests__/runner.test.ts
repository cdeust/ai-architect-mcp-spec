import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchmark } from "../runner.js";

describe("runBenchmark", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails the gate when the fixtures directory does not exist", async () => {
    const s = await runBenchmark(join(dir, "missing"), join(dir, "out.md"));
    expect(s.qualityGatePassed).toBe(false);
    expect(s.scenarios).toEqual([]);
    expect(s.aggregate.overallPassRate).toBe(0);
    expect(existsSync(join(dir, "out.md"))).toBe(false);
  });

  it("fails the gate when the directory has no manifests", async () => {
    mkdirSync(join(dir, "empty"));
    const s = await runBenchmark(dir, join(dir, "out.md"));
    expect(s.qualityGatePassed).toBe(false);
  });

  it("runs a scenario, skips missing section files and writes a report", async () => {
    const sc = join(dir, "sc");
    mkdirSync(sc);
    writeFileSync(join(sc, "overview.md"), "# Overview\n\nA short overview.\n");
    writeFileSync(
      join(sc, "manifest.json"),
      JSON.stringify({
        name: "demo",
        sections: [
          { name: "Overview", type: "overview", file: "overview.md" },
          { name: "Ghost", type: "goals", file: "nope.md" },
        ],
      }),
    );
    const out = join(dir, "out.md");
    const s = await runBenchmark(dir, out);
    expect(s.scenarios).toHaveLength(1);
    expect(s.scenarios[0]!.scenario).toBe("demo");
    const m = s.scenarios[0]!.metrics;
    expect(m.passRate).toBeGreaterThanOrEqual(0);
    expect(m.passRate).toBeLessThanOrEqual(1);
    expect(s.aggregate.totalRulesChecked).toBe(m.rulesChecked);
    const report = readFileSync(out, "utf-8");
    expect(report).toContain("# PRD Generator Benchmark Report");
    expect(report).toContain("### demo");
    expect(report).toContain(s.qualityGatePassed ? "PASSED" : "FAILED");
  });

  it("falls back to the directory name when the manifest has no name", async () => {
    const sc = join(dir, "dirname");
    mkdirSync(sc);
    writeFileSync(join(sc, "manifest.json"), JSON.stringify({}));
    const s = await runBenchmark(dir, join(dir, "out.md"));
    expect(s.scenarios[0]!.scenario).toBe("dirname");
    expect(s.scenarios[0]!.metrics.passRate).toBe(1);
  });

  it("lists violations in the report when sections break rules", async () => {
    const sc = join(dir, "bad");
    mkdirSync(sc);
    writeFileSync(join(sc, "t.md"), "TODO placeholder\n".repeat(5));
    writeFileSync(
      join(sc, "manifest.json"),
      JSON.stringify({
        name: "bad",
        sections: [
          { name: "T", type: "technical_specification", file: "t.md" },
          { name: "R", type: "requirements", file: "t.md" },
          { name: "S", type: "security_considerations", file: "t.md" },
          { name: "D", type: "data_model", file: "t.md" },
          { name: "A", type: "acceptance_criteria", file: "t.md" },
        ],
      }),
    );
    const out = join(dir, "out.md");
    const s = await runBenchmark(dir, out);
    const report = readFileSync(out, "utf-8");
    const n = s.scenarios[0]!.horReport.violations.length;
    expect(report.includes("**Violations:**")).toBe(n > 0);
    expect(report.includes(`... and ${n - 10} more`)).toBe(n > 10);
  });
});
