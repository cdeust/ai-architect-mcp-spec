// Run from a checkout with the locked Stryker dependency installed.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const targets = new Map([
  ["lib/config", ["config"]],
  ["lib/redact", ["redact"]],
  ["lib/cli", ["cli"]],
  ["lib/openai-client", ["openai-client"]],
  ["lib/judge-core", ["judge-core"]],
  ["lib/verdict-extract", ["verdict-extract"]],
  ["judge", ["security"]],
]);
const requested = process.argv.slice(2);
for (const name of requested) {
  if (!targets.has(name)) throw new Error("Unknown mutation target");
}
const run = mkdtempSync(join(tmpdir(), "external-judge-mutation-"));
console.log(`Mutation reports: ${run}`);
const work = join(run, "source");
mkdirSync(join(work, "bin"), { recursive: true });
cpSync(join(root, "bin/is-entry.mjs"), join(work, "bin/is-entry.mjs"));
cpSync(join(root, "scripts/external-judge"), join(work, "scripts/external-judge"), { recursive: true });
for (const target of requested.length ? requested : targets.keys()) {
  const tests = targets.get(target).map(name => `scripts/external-judge/__tests__/${name}.test.mjs`);
  const configuration = {
    mutate: [`scripts/external-judge/${target}.mjs`],
    testRunner: "command", plugins: [], coverageAnalysis: "off", concurrency: 1,
    commandRunner: { command: `node --test --test-reporter=dot ${tests.join(" ")}` },
    reporters: ["clear-text", "json"],
    jsonReporter: { fileName: join(run, target.split("/").pop() + ".json") },
    thresholds: { break: null },
  };
  writeFileSync(join(work, "stryker.json"), JSON.stringify(configuration));
  execFileSync(join(root, "node_modules/.bin/stryker"), ["run", "stryker.json"], { cwd: work, stdio: "inherit" });
}
