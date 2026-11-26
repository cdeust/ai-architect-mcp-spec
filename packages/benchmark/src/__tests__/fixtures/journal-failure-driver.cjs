// The worker owns the IPC channel. If it disappears, release the detached
// fixture even if it has not yet started, and let Node reap it before exit.
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

function workerDisconnected() {
  writeFileSync(join(process.env.OUT, "stop"), "");
}
process.once("disconnect", workerDisconnected);
if (!process.connected) workerDisconnected();

const child = spawn(process.execPath, [join(__dirname, "journal-failure-child.cjs")], {
  env: { OUT: process.env.OUT, DRIVER_PID: String(process.pid) },
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
process.stdout.write(String(child.pid));
child.once("exit", (code, signal) => {
  process.exitCode = code === 1 && signal === null ? 0 : 1;
  process.removeListener("disconnect", workerDisconnected);
  if (process.connected) process.disconnect();
});
