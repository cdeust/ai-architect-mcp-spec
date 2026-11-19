import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { collectOutput } from "../real-run/claude-cli-invoker.js";

const fixture = readFileSync(new URL("./fixtures/claude-cli-result.json", import.meta.url), "utf8");
function streams() {
  const child = Object.assign(new ChildProcess(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
  }) as ChildProcessWithoutNullStreams;
  const stdoutEncoding = vi.spyOn(child.stdout, "setEncoding");
  const stderrEncoding = vi.spyOn(child.stderr, "setEncoding");
  const kill = vi.fn();
  const result = collectOutput(child, 1000, kill);
  return { child, kill, result, stdoutEncoding, stderrEncoding };
}

it("settles on late pipe data and preserves the first stdin error and the leader signal", async () => {
  const { child, kill, result } = streams();
  child.stdout.emit("data", fixture.slice(0, 4));
  child.stderr.emit("data", "  failed  ");
  child.stdin.emit("error", new Error("pipe closed"));
  child.stdin.emit("error", new Error("second error"));
  child.emit("exit", null, "SIGTERM");
  expect(kill).not.toHaveBeenCalled();
  child.stdout.emit("data", fixture.slice(4));
  expect(kill).toHaveBeenCalledTimes(1);
  expect(await result).toMatchObject({ error: "Claude CLI exited with SIGTERM: pipe closed: failed" });
  child.emit("error", new Error("late"));
  child.emit("close");
  expect(kill).toHaveBeenCalledTimes(1);
});

it("rejects a spawn error immediately and cleans up only once", async () => {
  const { child, kill, result } = streams();
  child.emit("error", new Error("cannot start"));
  await expect(result).rejects.toThrow(/^cannot start$/);
  child.emit("close");
  expect(kill).toHaveBeenCalledTimes(1);
});

it("bounds and trims stderr on timeout, then clears the watchdog after a successful result", async () => {
  vi.useFakeTimers();
  try {
    const timed = streams();
    timed.child.stderr.emit("data", "  detail  ");
    const rejection = expect(timed.result).rejects.toThrow(/^Claude CLI timed out after 1000 ms: detail$/);
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(timed.kill).toHaveBeenCalledTimes(1);
    const success = streams();
    success.child.stdout.emit("data", fixture);
    success.child.emit("exit", 0, null);
    expect(await success.result).toMatchObject({ text: "ok", error: undefined });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("decodes UTF-8 on both pipes and skips parsing after settlement", async () => {
  const { child, result, stdoutEncoding, stderrEncoding } = streams();
  expect(stdoutEncoding).toHaveBeenCalledExactlyOnceWith("utf8");
  expect(stderrEncoding).toHaveBeenCalledExactlyOnceWith("utf8");
  expect(child.stdout.readableEncoding).toBe("utf8");
  expect(child.stderr.readableEncoding).toBe("utf8");
  child.stdout.emit("data", fixture);
  child.emit("exit", 0, null);
  await result;
  const parse = vi.spyOn(JSON, "parse");
  try {
    child.emit("close");
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

it("allows late output to complete an incomplete envelope before close", async () => {
  const { child, kill, result } = streams();
  child.emit("exit", 0, null);
  child.stdout.emit("data", fixture.slice(0, 2));
  expect(kill).not.toHaveBeenCalled();
  child.stdout.emit("data", fixture.slice(2));
  expect(await result).toMatchObject({ text: "ok" });
});
