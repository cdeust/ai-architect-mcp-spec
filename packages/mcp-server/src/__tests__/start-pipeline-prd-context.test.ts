/**
 * MCP contract of the two inputs a host declares at start_pipeline (#119):
 * `prd_context`, the kind of PRD, and `request_size`, its size.
 *
 * Drives a real MCP Client over an in-memory transport against the production
 * registerPipelineTools, so the registered input schema and its forwarding to
 * the reducer are exercised through the protocol. Proves: (1) both inputs are
 * listed, optional, and described with the numbers the run uses; (2) a
 * declared kind is the context of the run, over the trigger words of the
 * description; (3) a declared size `tiny` is the size of the run, which keeps
 * its kind, and each envelope says both; (4) nothing declared: the kind is
 * read from the words, and no size is; (5) an incident declared tiny runs the
 * plan of an incident, and says so; (6) a value that is no kind or no size is
 * refused before any run starts. The sections and rounds of a size are proven
 * in orchestration (request-size.test.ts, smoke.test.ts).
 *
 * source: Codex review of #356 (P1, "Add MCP contract tests for the new
 * context input"); AGENTS.md review guideline on observable behavior.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REQUEST_SIZE_CONFIGS } from "@prd-gen/core";

import { registerPipelineTools } from "../pipeline-tools.js";

let client: Client;

beforeAll(async () => {
  const server = new McpServer({ name: "test", version: "0" });
  registerPipelineTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
});

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

const DESCRIPTION = "build a feature: a tiny copy button";

/** The run a start_pipeline call makes: its first envelope, and its state. */
async function started(args: Record<string, unknown>) {
  const res = await call("start_pipeline", { feature_description: DESCRIPTION, skip_preflight: true, ...args });
  expect(res.isError).toBeFalsy();
  const envelope = JSON.parse(res.content[0].text) as {
    run_id: string;
    messages: Array<{ text: string }>;
    state_summary: { prd_context: string | null; request_size: string };
  };
  expect(typeof envelope.run_id).toBe("string");
  const stateRes = await call("get_pipeline_state", { run_id: envelope.run_id, format: "full" });
  expect(stateRes.isError).toBeFalsy();
  const body = JSON.parse(stateRes.content[0].text) as { state: { prd_context: string; request_size: string } };
  return { ...body.state, summary: envelope.state_summary, messages: envelope.messages.map((m) => m.text) };
}

/**
 * What the server answers when it refuses the call, as a tool error or as a
 * protocol error (SDK versions differ); null when it accepts it. The text is
 * returned so a test can see the refusal is about the input it sent, and not
 * any other failure.
 */
async function refusal(args: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await call("start_pipeline", { feature_description: DESCRIPTION, skip_preflight: true, ...args });
    return res.isError === true ? res.content.map((part) => part.text).join("\n") : null;
  } catch (error) {
    return String((error as Error).message);
  }
}

describe("start_pipeline: the kind and the size a host declares, over MCP (#119)", () => {
  it("keeps context, size and semantic review optional in the public input", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "start_pipeline");
    const schema = tool?.inputSchema as {
      properties: Record<string, { description?: string; enum?: string[] }>;
      required?: string[];
    };
    expect(tool?.description).toMatch(/Initialize a new PRD pipeline run/);
    expect(Object.keys(schema.properties).sort()).toEqual([
      "codebase_path",
      "feature_description",
      "prd_context",
      "request_size",
      "semantic_review",
      "skip_preflight",
    ]);
    expect(schema.required).toEqual(["feature_description"]);
    expect(schema.properties.feature_description.description).toMatch(/What the PRD is about/);
    expect(schema.properties.codebase_path.description).toMatch(/Absolute path/);
    expect(schema.properties.skip_preflight.description).toMatch(/skip the preflight/);
    expect(schema.properties.semantic_review.description).toMatch(/scope and declared edge-case coverage/);
    expect(schema.properties.prd_context.description).toMatch(/^The kind of PRD the request calls for, declared by the host/);
    // A size is not a kind.
    expect(schema.properties.prd_context.enum).not.toContain("tiny");
    expect(schema.properties.request_size.enum).toEqual(["standard", "tiny"]);
  });

  it("describes request_size with the numbers the run uses", async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "start_pipeline")?.inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    // The sentence of `tiny` is the first after the opening one: `standard` has none.
    expect(schema.properties.request_size.description).toBe(
      "The size of the request, declared by the host: the server never reads a size from feature_description. " +
        "'tiny' (Tiny change) is the fast path for a small, self-contained change: 4 sections (overview, requirements, acceptance_criteria, testing) and 4 to 5 clarification rounds, in place of those of the kind. " +
        "It is not for: incident, which keeps the rounds and sections of its kind. " +
        "Declare prd_context with it: the exemption holds for a kind the run knows, and a kind read from the words of feature_description can miss an incident. " +
        "Omit it for a request of ordinary size.",
    );
    const { sections, clarificationRange, notFor } = REQUEST_SIZE_CONFIGS.tiny.plan!;
    expect([sections.length, sections.join(", "), clarificationRange.join(" to "), notFor.join(", ")]).toEqual([
      4,
      "overview, requirements, acceptance_criteria, testing",
      "4 to 5",
      "incident",
    ]);
  });

  it("runs under the declared kind, not the one the description's words name", async () => {
    // "build" and "feature" would detect `feature`.
    const run = await started({ prd_context: "bug" });
    expect(run.prd_context).toBe("bug");
    expect(run.request_size).toBe("standard");
    expect(run.messages).toContain("PRD context: Bug Fix");
  });

  it("keeps the kind of a run declared tiny, and says its size in each envelope", async () => {
    const run = await started({ prd_context: "bug", request_size: "tiny" });
    expect(run.prd_context).toBe("bug");
    expect(run.request_size).toBe("tiny");
    expect(run.messages).toContain("PRD context: Bug Fix. Request size: Tiny change.");
    expect(run.summary).toMatchObject({ prd_context: "bug", request_size: "tiny" });
  });

  it("reads the kind, and no size, from the description when nothing is declared", async () => {
    // start_pipeline steps through context_detection before it answers.
    const run = await started({});
    expect(run.prd_context).toBe("feature");
    expect(run.request_size).toBe("standard");
    expect(run.messages).toContain("PRD context detected: Feature (from trigger words)");
    expect(run.summary).toMatchObject({ prd_context: "feature", request_size: "standard" });
  });

  it("says that an incident declared tiny keeps the plan of an incident", async () => {
    const run = await started({ prd_context: "incident", request_size: "tiny" });
    expect(run.messages).toContain(
      'PRD context: Incident. The declared size "tiny" is not applied: a run of this kind keeps the rounds and sections of its kind.',
    );
    // What was declared stays in the state; the run is held to standard.
    expect(run.request_size).toBe("tiny");
    expect(run.summary).toMatchObject({ prd_context: "incident", request_size: "standard" });
  });

  it("refuses a kind or a size that is not one, before any run starts", async () => {
    expect(await refusal({ prd_context: "huge" })).toContain("prd_context");
    // A size is not a kind, and a kind is not a size.
    expect(await refusal({ prd_context: "tiny" })).toContain("prd_context");
    expect(await refusal({ request_size: "bug" })).toContain("request_size");
    expect(await refusal({ prd_context: "bug", request_size: "tiny" })).toBeNull();
  });
});
