import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { posixTest, tempDirectory } from "./real-run-cli-harness.js";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { makeClaudeInvoker } from "../real-run/claude-cli-invoker.js";
import { loadArms } from "../real-run/plan-file.js";
import { runBench } from "../real-run/run-bench.js";
import { fileURLToPath } from "node:url";

posixTest("kills a hanging executable and records the timeout on its invocation", async () => {
  const dir = await tempDirectory("bench-timeout-");
  try {
    const program = join(dir, "stand-in");
    await writeFile(program, '#!/bin/sh\necho $$ > "$0.pid"\n/bin/sleep 3 &\necho $! > \"$0.descendant\"\nwait\n', { mode: 0o700 });
    const pilot = fileURLToPath(new URL("../../real-run/plans/pilot.json", import.meta.url));
    const [{ plan }] = await loadArms(pilot);
    const started = performance.now();
    const record = await runBench(plan, {
      invoke: makeClaudeInvoker(1500, dir, program),
      record: () => {},
      clock: Date.now,
    });
    expect(record.rows[0]).toMatchObject({ error: "Claude CLI timed out after 1500 ms", usage: null });
    expect(performance.now() - started).toBeLessThan(2100);
    expect((await readdir(dir)).filter(name => name.startsWith("call-"))).toEqual([]);
    const descendant = Number(await readFile(program + ".descendant", "utf8"));
    await expect.poll(() => {
      try {
        process.kill(descendant, 0);
        return false;
      }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }).toBe(true);
    const pid = Number(await readFile(program + ".pid", "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

posixTest.each(["complete", "incomplete", "billed error"])("handles %s output when a descendant holds stdout after exit", async output => {
  const dir = await tempDirectory("bench-inherited-pipe-");
  try {
    const program = join(dir, "stand-in");
    const fixture = new URL("./fixtures/claude-cli-result.json", import.meta.url);
    await writeFile(program, [
      "#!/bin/sh",
      // Consume the prompt before exiting so this fixture exercises the inherited output pipe alone.
      "/bin/cat >/dev/null",
      '/bin/sleep 10 &',
      'echo $! > "$0.descendant"',
      ...(output === "billed error" ? [
        'echo \'{"type":"result","subtype":"provider_error","is_error":true,"result":"quota","total_cost_usd":0.25}\'',
        "exit 1",
      ] : [output === "complete" ? `/bin/cat "${fileURLToPath(fixture)}"` : "echo '{'"]),
    ].join("\n"), { mode: 0o700 });
    const [{ plan }] = await loadArms(fileURLToPath(new URL("../../real-run/plans/smoke.json", import.meta.url)));
    plan.limits.max_invocations = 1;
    const record = await runBench(plan, { invoke: makeClaudeInvoker(1500, dir, program), record: () => {}, clock: Date.now });
    expect(record.rows[0]).toMatchObject(output === "complete"
      ? { error: null, usage: { input_tokens: 2 } }
      : output === "billed error"
        ? { error: "provider_error: quota: Claude CLI exited with 1", usage: { cost_usd: 0.25 } }
        : { error: "Claude CLI timed out after 1500 ms", usage: null });
    const pid = Number(await readFile(program + ".descendant", "utf8"));
    await expect.poll(() => {
      try {
        process.kill(pid, 0);
        return false;
      }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

posixTest.each(["ESRCH", "EPERM"])("keeps the parsed result when the group probe returns %s", async code => {
  const dir = await tempDirectory("bench-group-");
  const kill = vi.spyOn(process, "kill");
  if (code === "EPERM") kill.mockImplementation(() => { throw Object.assign(new Error("EPERM"), { code }); });
  try {
    const program = join(dir, "stand-in");
    const fixture = fileURLToPath(new URL("./fixtures/claude-cli-result.json", import.meta.url));
    await writeFile(program, `#!/bin/sh\n/bin/cat >/dev/null\necho $$ > "$0.pid"\nexec /bin/cat "${fixture}"\n`, { mode: 0o700 });
    const [{ plan }] = await loadArms(fileURLToPath(new URL("../../real-run/plans/smoke.json", import.meta.url)));
    plan.limits.max_invocations = 1;
    const record = await runBench(plan, { invoke: makeClaudeInvoker(1500, dir, program), record: () => {}, clock: Date.now });
    expect(record.rows[0]).toMatchObject({ error: null, usage: { input_tokens: 2 } });
    if (code === "EPERM") expect(record.rows[0].notes).toEqual([expect.stringContaining("EPERM")]);
    const pid = Number(await readFile(program + ".pid", "utf8"));
    expect(kill).not.toHaveBeenCalledWith(-pid, "SIGKILL");
  } finally {
    kill.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

posixTest("passes the prompt and isolated environment to the executable in its call directory", async () => {
  const dir = await tempDirectory("bench-stdin-");
  try {
    const program = join(dir, "stand-in");
    const fixture = fileURLToPath(new URL("./fixtures/claude-cli-result.json", import.meta.url));
    await writeFile(program, [
      "#!/bin/sh", '/bin/cat > "$OUT/input"', 'pwd > "$OUT/cwd"',
      'echo "$CLAUDE_CODE_DISABLE_CLAUDE_MDS/$CLAUDE_CODE_DISABLE_AUTO_MEMORY/$MARK" > "$OUT/settings"',
      'exec /bin/cat "$FIXTURE"',
    ].join("\n"), { mode: 0o700 });
    const [{ plan }] = await loadArms(fileURLToPath(new URL("../../real-run/plans/smoke.json", import.meta.url)));
    plan.limits.max_invocations = 1;
    const env = { FIXTURE: fixture, OUT: dir, MARK: "supplied", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" };
    const invoke = makeClaudeInvoker(1500, dir, program, undefined, env);
    let prompt = "";
    const record = await runBench(plan, { clock: Date.now, record: () => {}, invoke: (inv, used, row) => {
      prompt = inv.prompt;
      return invoke(inv, used, row);
    } });
    expect(record.rows[0].error).toBeNull();
    expect(prompt).not.toBe("");
    expect(await readFile(join(dir, "input"), "utf8")).toBe(prompt);
    expect(await readFile(join(dir, "settings"), "utf8")).toBe("1/1/supplied\n");
    const cwd = (await readFile(join(dir, "cwd"), "utf8")).trim();
    expect(cwd.startsWith(join(dir, "call-"))).toBe(true);
    await expect(readdir(cwd)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
