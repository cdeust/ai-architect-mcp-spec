/**
 * Contract test for `check_health` through the built server over stdio (#124).
 *
 * The 2026-10-10 audit of the v0.8.0 .mcpb read `status: "ok"` while
 * `skillAvailable` and `evidenceDbHealthy` were false. This starts
 * `dist/index.js` with a plugin root that has neither skill-config.json nor
 * SKILL.md, the shape of that bundle, and checks that the status follows the
 * probes. `configAvailable` was always true before: the fallback config also
 * carries `version`, which was the field being tested.
 *
 * Needs `pnpm build` first, as every CI command runs it before the tests.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENTRY = join(__dirname, "..", "..", "dist", "index.js");

// Above vitest's 5 s default testTimeout: a cold start of dist/index.js loads
// the orchestration, validation and verification trees, which scales with
// runner load (see hookTimeout in vitest.config.ts). The inner timer stays
// below it so the failure names the cause.
const RESPONSE_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;

let root: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-health-"));
});

afterEach(() => {
  // Kill before deleting root: the server may hold evidence.db open in it.
  child?.kill();
  child = undefined;
  rmSync(root, { recursive: true, force: true });
});

function callCheckHealth(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath, [ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
    child = server;
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`no check_health response within ${RESPONSE_TIMEOUT_MS} ms: ${stderr}`));
    }, RESPONSE_TIMEOUT_MS);
    server.on("error", reject);
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (code ${code}) before answering: ${stderr}`));
    });
    server.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    server.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      for (const line of buffer.split("\n")) {
        let message: { id?: number; result?: { content: Array<{ text: string }> } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 2 && message.result) {
          clearTimeout(timer);
          resolve(JSON.parse(message.result.content[0].text));
          return;
        }
      }
    });
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "check-health-test", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_health", arguments: {} } },
    ];
    server.stdin!.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  });
}

describe("check_health over stdio", () => {
  it("reports degraded and names the missing components when the plugin root is empty", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: root };
    delete env.PRD_GEN_SKILL_CONFIG;
    env.PRD_GEN_EVIDENCE_DB = join(root, "evidence.db");
    const health = await callCheckHealth(env);
    expect(health.status).toBe("degraded");
    expect(health.configAvailable).toBe(false);
    expect(health.skillAvailable).toBe(false);
    expect(health.degraded).toEqual(
      expect.arrayContaining(["configAvailable", "skillAvailable"]),
    );
  }, TEST_TIMEOUT_MS);

  it("reports config and SKILL.md available when the plugin root has both", async () => {
    const skillDir = join(root, "packages", "skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "skill-config.json"), JSON.stringify({ version: "2.0.0" }));
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\n");
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: root };
    delete env.PRD_GEN_SKILL_CONFIG;
    env.PRD_GEN_EVIDENCE_DB = join(root, "evidence.db");
    const health = await callCheckHealth(env);
    expect(health.configAvailable).toBe(true);
    expect(health.skillAvailable).toBe(true);
    expect(health.degraded).not.toContain("configAvailable");
    expect(health.degraded).not.toContain("skillAvailable");
    // evidenceDbHealthy depends on better-sqlite3 on this machine; status follows it.
    expect(health.status).toBe(health.evidenceDbHealthy ? "ok" : "degraded");
  }, TEST_TIMEOUT_MS);
});
