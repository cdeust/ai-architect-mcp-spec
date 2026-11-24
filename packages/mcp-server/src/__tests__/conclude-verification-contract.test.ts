import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Claim, JudgeVerdict } from "@prd-gen/core";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { buildConcludeOpts } from "../build-conclude-opts.js";
import { registerPipelineTools } from "../pipeline-tools.js";

vi.mock("../build-conclude-opts.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../build-conclude-opts.js")>();
  return { buildConcludeOpts: vi.fn(original.buildConcludeOpts) };
});

vi.mock("../reliability-wiring.js", () => ({
  getReliabilityRepo: () => null,
  getConsensusReliabilityProvider: () => null,
}));

const verdicts: JudgeVerdict[] = [{
  judge: { kind: "team", name: "engineer" },
  claim_id: "COPY-1",
  verdict: "PASS",
  rationale: "Copying leaves the original contents unchanged.",
  caveats: [],
  confidence: 0.9,
}];

const minimalClaim = {
  claim_id: "COPY-1",
  claim_type: "correctness",
  external_grounding: { type: "math", payload: { expression: "2+2", expected_value: 4 } },
} satisfies Pick<Claim, "claim_id" | "claim_type" | "external_grounding">;

let client: Client;
let server: McpServer;
let concludeDirectly: (args: Record<string, unknown>) => Promise<unknown>;

beforeAll(async () => {
  server = new McpServer({ name: "verification-contract-server", version: "0" });
  concludeDirectly = registerPipelineTools(server).conclude_verification.handler as unknown as typeof concludeDirectly;
  client = new Client({ name: "verification-contract-client", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(() => vi.clearAllMocks());

afterAll(async () => {
  await client?.close();
  await server?.close();
});

async function conclude(args: Record<string, unknown>) {
  const response = await client.callTool({
    name: "conclude_verification", arguments: { verdicts, ...args },
  });
  expect(response.isError).toBeFalsy();
  const part = response.content[0];
  if (part?.type !== "text") throw new Error("Expected a verification report");
  return JSON.parse(part.text) as unknown;
}

it("defaults to the overview section and weighted-average consensus", async () => {
  expect(await conclude({})).toMatchObject({
    section_type: "overview",
    results: [{ claim_id: "COPY-1", strategy: "weighted_average" }],
  });
  expect(buildConcludeOpts).toHaveBeenCalledWith({
    consensus_strategy: "weighted_average",
    run_id: undefined,
    claim_types: undefined,
    claims: undefined,
  });
});

it("uses the specified section when scope is section", async () => {
  expect(await conclude({ scope: "section", section_type: "testing" })).toMatchObject({
    section_type: "testing",
  });
});

it("forwards grounded claims and run metadata for a document report", async () => {
  const run_id = "run_verification_contract";
  const claim_types = { "COPY-1": "correctness" };
  const contextual = { ...minimalClaim, text: "The example is preserved", evidence: "Test output" };
  expect(await conclude({
    scope: "document", consensus_strategy: "bayesian", run_id, claim_types, claims: [contextual],
  })).toMatchObject({ section_type: "document", results: [{ claim_id: "COPY-1", strategy: "bayesian" }] });
  expect(buildConcludeOpts).toHaveBeenCalledWith({
    consensus_strategy: "bayesian", run_id, claim_types, claims: new Map([["COPY-1", contextual]]),
  });
});

it("fills missing claim context and ignores malformed claims in direct handler calls", async () => {
  await concludeDirectly({
    verdicts, claims: [{ ...minimalClaim, claim_id: "invalid", text: 42 }, minimalClaim],
  });
  expect(buildConcludeOpts).toHaveBeenCalledWith(expect.objectContaining({
    claims: new Map([["COPY-1", { ...minimalClaim, text: "", evidence: "" }]]),
  }));
});

it("leaves the claim map absent when there are no usable claims", async () => {
  await concludeDirectly({ verdicts, claims: [{ ...minimalClaim, claim_id: "invalid", evidence: 42 }] });
  expect(buildConcludeOpts).toHaveBeenCalledWith(expect.objectContaining({ claims: undefined }));
});

it("leaves an empty direct claim batch untouched", async () => {
  const claims: Claim[] = [];
  const iterate = vi.spyOn(claims, Symbol.iterator);
  try {
    await concludeDirectly({ verdicts, claims });
    expect(iterate).not.toHaveBeenCalled();
    expect(buildConcludeOpts).toHaveBeenCalledWith(expect.objectContaining({ claims: undefined }));
  } finally {
    iterate.mockRestore();
  }
});
