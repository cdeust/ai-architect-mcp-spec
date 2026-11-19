import { ChildProcess, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { makeClaudeInvoker } from "../real-run/claude-cli-invoker.js";
import type { Invocation, Row } from "../real-run/types.js";

vi.mock(import("node:child_process"), async original => ({ ...await original(), spawn: vi.fn() }));
vi.mock(import("node:fs"), async original => ({ ...await original(), mkdtempSync: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function invocation(pid?: number) {
  const child = Object.assign(new ChildProcess(), {
    pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  }) as ChildProcessWithoutNullStreams;
  vi.mocked(spawn).mockReturnValue(child);
  vi.mocked(mkdtempSync).mockReturnValue("/bench/call-test");
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  const track = vi.fn<NonNullable<Parameters<typeof makeClaudeInvoker>[3]>>();
  const remove = vi.fn();
  const row = { workspace_kept: false } as Row;
  const invoke = makeClaudeInvoker(1000, "/bench", undefined, track, {}, remove);
  const pending = invoke({ prompt: "hello" } as Invocation, { model: "session", effort: "session" }, row);
  const [, kill, cleanup] = track.mock.calls[0];
  async function close() {
    child.emit("close");
    await expect(pending).rejects.toThrow(/^Claude CLI returned invalid or incomplete JSON$/);
  }
  return { child, signal, kill, cleanup, close, remove, row };
}

it("runs claude by default and leaves tracked cleanup to its owner", async () => {
  const call = invocation(123);
  await call.close();
  expect(vi.mocked(spawn).mock.lastCall?.[0]).toBe("claude");
  expect(call.remove).not.toHaveBeenCalled();
  call.cleanup();
  expect(call.remove).toHaveBeenCalledExactlyOnceWith("/bench/call-test", { recursive: true, force: true });
});

it("never signals an unassigned process group", async () => {
  const call = invocation();
  call.kill();
  await call.close();
  expect(call.signal).not.toHaveBeenCalled();
});

it.each([
  [null, null, [[-123, "SIGKILL"]]],
  [0, null, [[-123, 0], [-123, "SIGKILL"]]],
  [null, "SIGTERM", [[-123, 0], [-123, "SIGKILL"]]],
] as const)("signals the group once with exitCode=%s and signalCode=%s", async (exitCode, signalCode, calls) => {
  const call = invocation(123);
  Object.assign(call.child, { exitCode, signalCode });
  call.kill();
  await call.close();
  expect(call.signal.mock.calls).toEqual(calls);
});

it("keeps a missing process group out of the cleanup notes", async () => {
  const call = invocation(123);
  call.signal.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  await call.close();
  expect(call.signal.mock.calls).toEqual([[-123, "SIGKILL"]]);
  expect(call.row.notes).toBeUndefined();
});
