// Replays the flake of the growth tests on demand: `pnpm build && pnpm test:perf:load`.
//
// regex-hardening.perf.ts compares the cost of an input with that of twice the
// input. Measured on wall-clock time it failed under machine load with no defect
// (ratio 3.17 against 3.0, PR #405). This puts a linear workload and a quadratic
// control under N CPU spinners and reads BOTH clocks around every call, so the
// two estimators see exactly the same scheduling:
//   - the CPU-time ratio of the linear workload must stay under the ceiling in
//     every trial, loaded or idle;
//   - the CPU-time ratio of the quadratic control must stay above it in every
//     trial (a robust estimator that cannot fail is worth nothing);
//   - the wall-clock ratios are printed for comparison, not asserted.
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { validateSection } = await import(pathToFileURL(join(ROOT, "packages/validation/dist/index.js")).href);

// source: same ceiling, floor and pair count as packages/validation/src/__tests__/regex-hardening.perf.ts.
const CEILING = 3.0;
const MIN_SAMPLE_MS = 0.5;
const PAIRS = 7;
// source: heuristic provisional; 15 trials of 7 pairs per condition keep the run near a minute.
const TRIALS = 15;
const SPINNERS = cpus().length;

const cpuNow = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

function ratios(run, small, large) {
  const fastest = { cpu: [Infinity, Infinity], wall: [Infinity, Infinity] };
  for (let pair = 0; pair < PAIRS; pair++) {
    [small, large].forEach((input, size) => {
      const c0 = cpuNow(), w0 = performance.now();
      run(input);
      fastest.cpu[size] = Math.min(fastest.cpu[size], cpuNow() - c0);
      fastest.wall[size] = Math.min(fastest.wall[size], performance.now() - w0);
    });
  }
  const ratio = ([s, l]) => l / Math.max(s, MIN_SAMPLE_MS);
  return { cpu: ratio(fastest.cpu), wall: ratio(fastest.wall) };
}

const linear = input => validateSection(input, "technical_specification");
const linearInput = n => ["```kotlin", "abstract ".repeat(n), "```"].join("\n");
const quadratic = input => {
  let sum = 0;
  for (let i = 0; i < input.length; i++) for (let j = 0; j < input.length; j++) sum += input.charCodeAt(j) ^ i;
  if (sum === 0.5) throw new Error("unreachable");
};

function trials(run, small, large) {
  run(small); run(large);
  return Array.from({ length: TRIALS }, () => ratios(run, small, large));
}
const stats = (rows, clock) => { const v = rows.map(r => r[clock]); return { min: Math.min(...v), max: Math.max(...v), over: v.filter(x => x >= CEILING).length }; };
const line = (label, rows) => {
  const c = stats(rows, "cpu"), w = stats(rows, "wall");
  console.log(`${label.padEnd(24)} cpu ${c.min.toFixed(2)}–${c.max.toFixed(2)} (${c.over}/${TRIALS} ≥ ${CEILING})   wall ${w.min.toFixed(2)}–${w.max.toFixed(2)} (${w.over}/${TRIALS} ≥ ${CEILING})`);
  return { c, w };
};

function measure() {
  return {
    linear: line("linear (validateSection)", trials(linear, linearInput(8_000), linearInput(16_000))),
    quadratic: line("quadratic control", trials(quadratic, "a".repeat(3_000), "a".repeat(6_000))),
  };
}

console.log(`idle`);
const idle = measure();
const spinners = Array.from({ length: SPINNERS }, () => spawn(process.execPath, ["-e", "for (;;) {}"], { stdio: "ignore" }));
console.log(`\nunder ${SPINNERS} CPU spinners`);
let loaded;
try {
  loaded = measure();
} finally {
  for (const spinner of spinners) spinner.kill("SIGKILL");
}

const failures = [];
for (const [name, run] of [["idle", idle], ["loaded", loaded]]) {
  if (run.linear.c.over) failures.push(`${name}: the CPU-time ratio of a linear workload reached the ceiling`);
  if (run.quadratic.c.min < CEILING) failures.push(`${name}: the CPU-time ratio of the quadratic control fell below the ceiling`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("\nCPU-time estimator: linear stays under the ceiling and the quadratic control above it, idle and loaded");
