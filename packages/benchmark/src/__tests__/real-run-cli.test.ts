import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cwd = fileURLToPath(new URL("../../", import.meta.url));
function cli(...args: string[]) {
  return spawnSync(process.execPath, ["dist/src/real-run/cli.js", ...args], {
    cwd, encoding: "utf8", env: { PATH: "" },
  });
}

it("requires explicit cost acceptance before opening a live plan", () => {
  const result = cli("--plan", "absent.json", "--out", ".");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Live runs require --i-accept-model-cost");
  expect(result.stdout).toBe("");
});

it("writes five dry-run records and the comparison without an installed model CLI", async () => {
  const out = await mkdtemp(join(tmpdir(), "real-run-test-"));
  try {
    const result = cli("--dry-run", "--plan", "real-run/plans/pilot.json", "--out", out);
    expect(result.status, result.stderr).toBe(0);
    const arms = ["standard-as-emitted", "tiny-as-emitted", "standard-tiered", "tiny-tiered", "tiny-tiered-parallel"];
    expect((await readdir(out)).sort()).toEqual([...arms, "summary.md"].sort());
    const summary = await readFile(join(out, "summary.md"), "utf8");
    for (const arm of arms) {
      const count = arm.startsWith("tiny") ? 12 : 27;
      expect(result.stdout).toContain(`${arm}: ${count} expected invocations (canned)`);
      const record = JSON.parse(await readFile(join(out, arm, "record.json"), "utf8"));
      expect(record).toMatchObject({ dry_run: true, totals: { invocations: count, cost_usd: 0, errors: 0 },
        quality: { hard_output_score: 0.85, outcome: { status: "needs_attention" } } });
      const sections = JSON.parse(await readFile(join(out, arm, "sections.json"), "utf8"));
      expect(sections).toEqual(record.sections);
      expect(sections).toContainEqual({
        section_type: "overview",
        status: expect.any(String),
        attempt: expect.any(Number),
        violation_count: expect.any(Number),
        content: expect.stringMatching(/\S/),
      });
      const journal = await readFile(join(out, arm, "rows.jsonl"), "utf8");
      expect(journal.trimEnd().split("\n").map(line => JSON.parse(line))).toEqual(expect.arrayContaining(record.rows));
      expect(journal.trimEnd().split("\n")).toHaveLength(count);
      const draft = record.rows.find((r: { purpose: string }) => r.purpose === "draft");
      expect(draft.used.model).toBe(arm.includes("tiered") ? "sonnet" : "session");
      expect(summary).toContain(`| ${arm} | 0 | 0 |`);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
