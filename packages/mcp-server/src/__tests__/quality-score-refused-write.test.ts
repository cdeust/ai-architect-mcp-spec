/**
 * #121 — an evidence store that refuses a quality score does not stop the
 * run, and says so on stderr.
 *
 * The score is feedback, not a gate: the run must still reach `done`. The
 * refusal must not be silent either, or a store that cannot be written is
 * taken for one that has nothing to show.
 *
 * Strategy: the production registerPipelineTools, with getEvidenceRepo()
 * replaced by a repository whose recordQualityScore throws; a canned run is
 * played through the captured start_pipeline / submit_action_result handlers
 * (the capturing server of run-semaphore.test.ts).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeCannedDispatcher, type NextAction } from "@prd-gen/orchestration";

const refused: Array<{ prdId: string; auditFlagsRaised: number | null }> = [];

vi.mock("../evidence-db-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../evidence-db-path.js")>()),
  getEvidenceRepo: () => ({
    recordQualityScore(score: { prdId: string; auditFlagsRaised: number | null }) {
      refused.push(score);
      throw new Error("attempt to write a readonly database");
    },
    recordStrategyExecution() {},
    pruneRunEvidence() {},
  }),
}));

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface Envelope {
  readonly run_id: string;
  readonly action: { readonly kind: string };
}

let handlers: Map<string, ToolHandler>;

beforeAll(async () => {
  const { registerPipelineTools } = await import("../pipeline-tools.js");
  handlers = new Map();
  const server = {
    tool(name: string, ...rest: unknown[]) {
      handlers.set(name, rest[rest.length - 1] as ToolHandler);
    },
  };
  registerPipelineTools(server as unknown as Parameters<typeof registerPipelineTools>[0]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function envelopeOf(tool: string, args: Record<string, unknown>): Promise<Envelope> {
  const response = await handlers.get(tool)!(args);
  expect(response.isError, response.content[0]!.text).toBeFalsy();
  return JSON.parse(response.content[0]!.text) as Envelope;
}

describe("a quality score the evidence store refuses (#121)", () => {
  it("leaves the run to finish and is reported on stderr, once", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const dispatch = makeCannedDispatcher({});

    let envelope = await envelopeOf("start_pipeline", {
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/smoke",
    });
    for (let steps = 0; steps < 2_000; steps++) {
      const result = dispatch(envelope.action as unknown as NextAction);
      if (result === undefined) break;
      envelope = await envelopeOf("submit_action_result", { run_id: envelope.run_id, result });
    }
    expect(envelope.action.kind).toBe("done");

    // One write was attempted, for this run, and it was refused.
    expect(refused).toHaveLength(1);
    expect(refused[0]!.prdId).toBe(envelope.run_id);

    // The refused score is not offered again at a later step, and the
    // refusal names the run and the reason.
    const reports = stderr.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("quality score"));
    expect(reports).toEqual([
      `[prd-gen] quality score of ${envelope.run_id} not recorded: Error: attempt to write a readonly database`,
    ]);
  });
});
