/**
 * Schema-contract test for the ai-architect-mcp-codebase MCP protocol.
 *
 * Wave C "no-skip" rewrite. Previously this file gated on
 * `AIPRD_PIPELINE_BIN` and skipped in CI when the live Rust binary was
 * absent — equivalent to never running. The live-binary check is now
 * replaced with an unconditional schema pin against the request and
 * response shapes the live server uses (per
 * /Users/cdeust/Developments/anthropic/ai-architect-mcp-codebase/NOTES.md).
 *
 * What this PROVES (unconditional, in CI):
 *   ✓ `IndexCodebaseRequestSchema` accepts the request shape
 *     `handleInputAnalysis` constructs.
 *   ✓ `IndexCodebaseResponseSchema` parses the live server's
 *     `{ graph_path, symbols_indexed, files_parsed, duration_ms }` shape.
 *   ✓ The schema rejects malformed responses LOUDLY (Curie A3 — drift
 *     guard: a future server-side rename of `graph_path` must NOT silently
 *     pass).
 *   ✓ The `AiArchitectCodebaseClient.indexCodebase` method delegates to the
 *     stdio transport's `callTool` with the validated request.
 *
 * What this does NOT prove (consciously deferred, can only be verified
 * against the live binary):
 *   ✗ The Rust server actually emits the schema-conformant shape today.
 *     The schema is the contract; if the server drifts, this test will
 *     keep passing while production breaks. Mitigation: schema is paired
 *     with the source comment in `contracts/codebase.ts:31-32` that names
 *     the live binary as the source of truth, and the field name was
 *     verified against the live binary at the time of authoring.
 *
 * source: Wave C cross-audit "no-skip" mandate. Replaces a permanently-
 *   skipped env-gated integration test with an unconditional schema pin.
 */

import { describe, it, expect, vi } from "vitest";
import { AiArchitectCodebaseClient } from "../index.js";
import {
  IndexCodebaseRequestSchema,
  IndexCodebaseResponseSchema,
} from "../contracts/codebase.js";

describe("ai-architect-mcp-codebase MCP — request/response schema contract", () => {
  it("IndexCodebaseRequestSchema accepts the shape handleInputAnalysis constructs", () => {
    // Pinned shape — must remain consumable from orchestration's
    // section-generation handler. A future field rename here would break
    // the call site in handleInputAnalysis.
    const validated = IndexCodebaseRequestSchema.parse({
      path: "/Users/cdeust/Developments/ai-architect-mcp-spec/packages/core/src",
      output_dir: "/tmp/prd-gen-pipeline-test",
      language: "auto",
    });
    expect(validated.path.length).toBeGreaterThan(0);
    expect(validated.output_dir.length).toBeGreaterThan(0);
    expect(validated.language).toBe("auto");
  });

  it("IndexCodebaseRequestSchema defaults language to 'auto' when omitted", () => {
    const validated = IndexCodebaseRequestSchema.parse({
      path: "/x",
      output_dir: "/y",
    });
    expect(validated.language).toBe("auto");
  });

  it("IndexCodebaseResponseSchema parses the live-server shape (graph_path, not graph_id)", () => {
    // The live Rust server (per tool_schemas.rs in ai-architect-mcp-codebase)
    // returns `graph_path`, not `graph_id`. This test pins that contract.
    const liveShape = {
      graph_path: "/tmp/prd-gen-pipeline-test/graph.bin",
      symbols_indexed: 1247,
      files_parsed: 18,
      duration_ms: 3421,
    };
    const parsed = IndexCodebaseResponseSchema.parse(liveShape);
    expect(parsed.graph_path).toBe(liveShape.graph_path);
    expect(parsed.symbols_indexed).toBe(1247);
  });

  it("IndexCodebaseResponseSchema rejects a response missing graph_path (loud drift detection)", () => {
    // Curie A3: if the server-side field is renamed (e.g., graph_path →
    // graph_uri), this test must fail loudly so the schema can be updated
    // in lockstep with the server. A silent skip would mask the breakage.
    expect(() =>
      IndexCodebaseResponseSchema.parse({
        // missing graph_path
        symbols_indexed: 1,
        files_parsed: 1,
      }),
    ).toThrow();
  });

  it("IndexCodebaseResponseSchema rejects graph_path of wrong type", () => {
    expect(() =>
      IndexCodebaseResponseSchema.parse({
        graph_path: 12345, // wrong type
      }),
    ).toThrow();
  });
});

describe("AiArchitectCodebaseClient — delegation to stdio transport", () => {
  it("indexCodebase validates the request and delegates callTool to the underlying client", async () => {
    // Stub the StdioMcpClient at the AiArchitectCodebaseClient instance.
    // We inject a fake `client` field via Object.assign because the real
    // class encapsulates the transport — this verifies the public method
    // contract (validate request → callTool → parse response) without
    // requiring a live binary.
    const fakeCallTool = vi.fn().mockResolvedValue({
      graph_path: "/tmp/fake-graph.bin",
      symbols_indexed: 7,
    });

    // Build the client without connecting (constructor only sets up the
    // transport object; no IO until connect() is called).
    const client = new AiArchitectCodebaseClient({
      command: "/nonexistent",
      args: [],
    });

    // Replace the private transport with a stub. Cast through `unknown` to
    // satisfy the TypeScript private-field check; this is a test-only
    // boundary cross.
    (client as unknown as { client: { callTool: typeof fakeCallTool } }).client = {
      callTool: fakeCallTool,
    };

    const result = await client.indexCodebase({
      path: "/x",
      output_dir: "/y",
      language: "typescript",
    });

    // Postcondition: the transport was called with the canonical tool name
    // and a request that passes schema validation.
    expect(fakeCallTool).toHaveBeenCalledWith("index_codebase", {
      path: "/x",
      output_dir: "/y",
      language: "typescript",
    });
    // Postcondition: the response is parsed through the schema.
    expect(result.graph_path).toBe("/tmp/fake-graph.bin");
    expect(result.symbols_indexed).toBe(7);
  });

  it("indexCodebase rejects a malformed response from the transport (loud parse failure)", async () => {
    // If the live server drifts and returns graph_id instead of graph_path,
    // the client must throw, not silently substitute.
    const fakeCallTool = vi.fn().mockResolvedValue({
      graph_id: "should-have-been-graph_path",
    });
    const client = new AiArchitectCodebaseClient({
      command: "/nonexistent",
      args: [],
    });
    (client as unknown as { client: { callTool: typeof fakeCallTool } }).client = {
      callTool: fakeCallTool,
    };

    await expect(
      client.indexCodebase({ path: "/x", output_dir: "/y", language: "auto" }),
    ).rejects.toThrow();
  });
});
