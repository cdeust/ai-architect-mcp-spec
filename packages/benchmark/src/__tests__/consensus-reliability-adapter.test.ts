import { describe, it, expect, vi } from "vitest";
import type { ReliabilityRepository, JudgeReliabilityRecord } from "@prd-gen/core";
import { BenchmarkConsensusReliabilityProvider } from "../consensus-reliability-adapter.js";

const record = { alpha: 9, beta: 2 } as unknown as JudgeReliabilityRecord;
const judge = { kind: "genius", name: "liskov" } as const;
const dir = "positive" as never;

function setup() {
  const getReliability = vi.fn().mockReturnValue(record);
  const repo = { getReliability } as unknown as ReliabilityRepository;
  return { getReliability, provider: new BenchmarkConsensusReliabilityProvider(repo) };
}

describe("BenchmarkConsensusReliabilityProvider", () => {
  it("withholds calibrated history for roughly one run in five (CC-3 control arm)", () => {
    const { provider } = setup();
    const ids = Array.from({ length: 500 }, (_, i) => `run-${i}`);
    const control = ids.filter(
      (id) => provider.getReliabilityForRun(id, judge, "fr_traceability", dir) === null,
    );
    expect(control.length).toBeGreaterThan(50);
    expect(control.length).toBeLessThan(150);
  });

  it("is deterministic per run id and never touches the repository for control runs", () => {
    const { provider, getReliability } = setup();
    const id = Array.from({ length: 200 }, (_, i) => `r${i}`).find(
      (r) => provider.getReliabilityForRun(r, judge, "fr_traceability", dir) === null,
    )!;
    getReliability.mockClear();
    expect(provider.getReliabilityForRun(id, judge, "fr_traceability", dir)).toBeNull();
    expect(getReliability).not.toHaveBeenCalled();
  });

  it("returns the persisted record for treatment runs, passing the cell through", () => {
    const { provider, getReliability } = setup();
    const id = Array.from({ length: 200 }, (_, i) => `r${i}`).find(
      (r) => provider.getReliabilityForRun(r, judge, "fr_traceability", dir) !== null,
    )!;
    getReliability.mockClear();
    const negative = "negative" as never;
    expect(provider.getReliabilityForRun(id, judge, "sp_arithmetic", negative)).toBe(record);
    expect(getReliability).toHaveBeenCalledWith(judge, "sp_arithmetic", "negative");
  });

  it("returns null when the repository has no data for the cell", () => {
    const getReliability = vi.fn().mockReturnValue(null);
    const provider = new BenchmarkConsensusReliabilityProvider({ getReliability } as unknown as ReliabilityRepository);
    for (let i = 0; i < 20; i++) {
      expect(provider.getReliabilityForRun(`x${i}`, judge, "fr_traceability", dir)).toBeNull();
    }
  });
});
