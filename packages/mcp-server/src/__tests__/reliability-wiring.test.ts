import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const core = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@prd-gen/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@prd-gen/core")>()),
  tryCreateReliabilityRepository: core.create,
}));

type Wiring = typeof import("../reliability-wiring.js");

function fakeRepo(over: Record<string, unknown> = {}) {
  return {
    close: vi.fn(),
    getReliability: vi.fn(),
    getSchemaVersion: vi.fn().mockReturnValue(2),
    getAllRecords: vi.fn().mockReturnValue([]),
    ...over,
  };
}

describe("reliability-wiring", () => {
  let w: Wiring;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    vi.resetModules();
    core.create.mockReset();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    w = await import("../reliability-wiring.js");
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("opens the repository once under ~/.prd-gen and caches it", () => {
    const repo = fakeRepo();
    core.create.mockReturnValue(repo);
    expect(w.getReliabilityRepo()).toBe(repo);
    expect(w.getReliabilityRepo()).toBe(repo);
    expect(core.create).toHaveBeenCalledTimes(1);
    expect(core.create.mock.calls[0]![0]).toMatch(/\.prd-gen[\\/]reliability\.db$/);
  });

  it("caches a failed open as null instead of retrying", () => {
    core.create.mockReturnValue(null);
    expect(w.getReliabilityRepo()).toBeNull();
    expect(w.getReliabilityRepo()).toBeNull();
    expect(core.create).toHaveBeenCalledTimes(1);
  });

  it("wraps the repository in a provider, or yields none without one", () => {
    core.create.mockReturnValue(fakeRepo());
    const p = w.getConsensusReliabilityProvider();
    expect(p).not.toBeNull();
    expect(w.getConsensusReliabilityProvider()).toBe(p);
  });

  it("returns no provider when the repository is unavailable", () => {
    core.create.mockReturnValue(null);
    expect(w.getConsensusReliabilityProvider()).toBeNull();
  });

  it("closeReliabilityRepo closes the open repository once and drops the provider", () => {
    const repo = fakeRepo();
    core.create.mockReturnValue(repo);
    w.getConsensusReliabilityProvider();
    w.closeReliabilityRepo();
    w.closeReliabilityRepo();
    expect(repo.close).toHaveBeenCalledTimes(1);
    expect(w.getConsensusReliabilityProvider()).toBeNull();
  });

  it("closeReliabilityRepo is safe before first use", () => {
    expect(() => w.closeReliabilityRepo()).not.toThrow();
    expect(core.create).not.toHaveBeenCalled();
  });

  it("health: unhealthy and explains the fallback when the DB is unavailable", () => {
    core.create.mockReturnValue(null);
    const h = w.checkReliabilityHealth();
    expect(h).toMatchObject({ healthy: false, schemaVersion: null, recordCount: null });
    expect(h.message).toContain("Beta(7,3)");
  });

  it("health: unhealthy when reading the schema version throws", () => {
    core.create.mockReturnValue(
      fakeRepo({
        getSchemaVersion: vi.fn(() => {
          throw new Error("locked");
        }),
      }),
    );
    const h = w.checkReliabilityHealth();
    expect(h.healthy).toBe(false);
    expect(h.message).toContain("schema check failed");
    expect(h.message).toContain("locked");
  });

  it("health: unhealthy on a schema version mismatch", () => {
    core.create.mockReturnValue(fakeRepo({ getSchemaVersion: vi.fn().mockReturnValue(1) }));
    const h = w.checkReliabilityHealth();
    expect(h).toMatchObject({ healthy: false, schemaVersion: 1, recordCount: null });
    expect(h.message).toContain("version mismatch");
  });

  it("health: an empty DB is healthy but logs the cold-start fallback", () => {
    core.create.mockReturnValue(fakeRepo());
    const h = w.checkReliabilityHealth();
    expect(h).toMatchObject({ healthy: true, schemaVersion: 2, recordCount: 0 });
    expect(h.message).toContain("empty");
    expect(errSpy).toHaveBeenCalledOnce();
  });

  it("health: a populated DB reports its cell count without logging", () => {
    core.create.mockReturnValue(fakeRepo({ getAllRecords: vi.fn().mockReturnValue([{}, {}, {}]) }));
    const h = w.checkReliabilityHealth();
    expect(h).toMatchObject({ healthy: true, recordCount: 3 });
    expect(h.message).toContain("3 calibrated");
    expect(errSpy).not.toHaveBeenCalled();
  });
});
