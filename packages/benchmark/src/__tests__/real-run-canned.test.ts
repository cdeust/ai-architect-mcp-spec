import { expect, it, vi } from "vitest";
import { cannedInvoke } from "../real-run/canned-ports.js";
import type { Invocation } from "../real-run/types.js";

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@prd-gen/orchestration", () => ({ makeCannedDispatcher: () => dispatch }));
const inv: Invocation = {
  invocation_id: "probe", description: "probe", prompt: "hello", subagent_type: "engineer",
  isolation: "none", purpose: "probe",
};

it.each([undefined, { kind: "tool_result" }, { kind: "subagent_batch_result", responses: [{}] }])(
  "explains a missing canned response for %j", async reply => {
    dispatch.mockReturnValue(reply);
    await expect(cannedInvoke(inv)).rejects.toThrow(/^Expected a canned subagent response$/);
  },
);
