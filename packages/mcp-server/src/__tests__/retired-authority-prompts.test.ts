import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { initialPostSpecs, newPipelineState } from "@prd-gen/orchestration";
import { build, transformSync } from "esbuild";
import { expect, it } from "vitest";
import { handleFinalize } from "../../../orchestration/src/handlers/finalize.js";
import { RUNS_DIR, RunFiles } from "../run-files.js";
import { startStdioServer } from "./stdio-server.js";

const historicalPrStatus = "PR: not opened (declined at the gate, or publication failed).";
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const packages = join(repo, "packages");
const authorityPhrases = [["ALREADY", "approved"].join(" "), "gh pr create", "git push"];
const retiredBuilder = /\b(?:build|make|create)(?:Implementation|Testing|Review|PrCreation)Prompt\b/;
const retiredModule = /^(?:implementation|testing|review|pr-creation)-prompts\.[cm]?[jt]sx?$/;
// source: MCP Vitest config's cold-start allowance for the server dependency graph.
const checkpointTimeoutMs = 60_000;

function productionSourceFiles() {
  const roots = readdirSync(packages, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(packages, entry.name, "src"))
    .filter(existsSync);
  return roots.flatMap(root => readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .filter(entry => !relative(root, entry.parentPath).split(sep).includes("__tests__"))
    .filter(entry => !/\.(?:test|spec|perf)\.[cm]?[jt]sx?$/.test(entry.name)));
}

function sourceForAuthorityCheck(path: string, text: string): string {
  const extension = extname(path).slice(1).replace(/^[cm](?=[jt]s$)/, "");
  if (extension === "ts" || extension === "tsx" || extension === "js" || extension === "jsx") {
    // Keep unreachable code and strip comments that describe the legacy protocol.
    return transformSync(text, { loader: extension, treeShaking: false, legalComments: "none" }).code;
  }
  return text;
}

function historicalCompletion(run_id: string) {
  return {
    ...newPipelineState({ run_id, feature_description: "Resume a legacy result" }),
    current_step: "finalize" as const,
    pending_completion: { summary: "Specification complete", artifacts: [] },
    post_specs: { ...initialPostSpecs(), pr: { pushed: false, url: null } },
  };
}

it("finds no retired constructors or publication authority in production sources", () => {
  const files = productionSourceFiles();
  expect(files.length).toBeGreaterThan(0);
  const violations = files.flatMap(({ name, parentPath }) => {
    const path = join(parentPath, name);
    const text = readFileSync(path, "utf8");
    const location = relative(repo, path);
    if (retiredModule.test(name) || retiredBuilder.test(text)) return [`${location}: retired prompt builder`];
    const source = sourceForAuthorityCheck(path, text);
    return authorityPhrases.filter(phrase => source.includes(phrase)).map(phrase => `${location}: ${phrase}`);
  });
  expect(violations).toEqual([]);
}, checkpointTimeoutMs);

it("ships no retired authority text in a freshly built source bundle", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "prd-gen-retired-authority-"));
  const outfile = join(scratch, "index.js");
  try {
    await build({
      absWorkingDir: repo,
      entryPoints: [join(packages, "mcp-server", "src", "index.ts")],
      tsconfigRaw: {
        compilerOptions: {
          paths: {
            "@prd-gen/benchmark/calibration": ["./packages/benchmark/calibration/index.ts"],
            "@prd-gen/*": ["./packages/*/src/index.ts"],
          },
        },
      },
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      external: ["better-sqlite3"],
      outfile,
    });
    const bundle = readFileSync(outfile, "utf8");
    expect(authorityPhrases.filter(phrase => bundle.includes(phrase))).toEqual([]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, checkpointTimeoutMs);

it("refuses submitted results for all four retired steps over MCP stdio", async () => {
  const checkpoints = [
    ["implementation", "run_retired_implementation"],
    ["testing", "run_retired_testing"],
    ["review", "run_retired_review"],
    ["pr_creation", "run_retired_prcreation"],
  ] as const;
  const files = new RunFiles(RUNS_DIR);
  for (const [current_step, run_id] of checkpoints) {
    // Older state-only checkpoints have no saved action to identify the step.
    files.write({ ...newPipelineState({ run_id, feature_description: "Legacy execution" }), current_step }, null);
  }

  const server = await startStdioServer();
  try {
    for (const [current_step, run_id] of checkpoints) {
      const response = await server.call("submit_action_result", {
        run_id,
        result: { kind: "subagent_batch_result", batch_id: "legacy_batch", responses: [] },
      });
      expect(response.isError, `${current_step}: ${response.text}`).toBe(true);
      expect(JSON.parse(response.text), current_step).toMatchObject({
        error: { code: "architect_os_required" },
      });
    }
  } finally {
    await server.close();
  }
}, checkpointTimeoutMs);

it("resumes a legacy finalize checkpoint and records the unpublished PR over MCP stdio", async () => {
  const run_id = "run_historical_status";
  new RunFiles(RUNS_DIR).write(historicalCompletion(run_id), null);
  const server = await startStdioServer();
  try {
    const replay = await server.call("submit_action_result", {
      run_id,
      result: { kind: "tool_result", correlation_id: "previous_action", success: true, data: {} },
    });
    expect(replay.isError, replay.text).toBe(false);
    const { action } = JSON.parse(replay.text);
    expect(action).toMatchObject({
      kind: "call_cortex_tool",
      tool_name: "remember",
      arguments: { content: expect.stringContaining(historicalPrStatus) },
    });
    const result = await server.call("submit_action_result", {
      run_id,
      result: { kind: "tool_result", correlation_id: action.correlation_id, success: true, data: {} },
    });
    expect(result.isError, result.text).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ current_step: "complete", action: { kind: "done" } });
  } finally {
    await server.close();
  }
}, checkpointTimeoutMs);

it.each([
  { pr: { pushed: false, url: null }, status: historicalPrStatus },
  { pr: { pushed: true, url: "https://example.com/pull/1" }, status: "PR: opened at https://example.com/pull/1." },
])("records the historical PR status when pushed is $pr.pushed", ({ pr, status }) => {
  const checkpoint = historicalCompletion("run_historical_summary");
  const state = { ...checkpoint, post_specs: { ...checkpoint.post_specs, pr } };
  expect(handleFinalize({ state }).action).toMatchObject({
    kind: "call_cortex_tool",
    tool_name: "remember",
    arguments: { content: expect.stringContaining(status) },
  });
});
