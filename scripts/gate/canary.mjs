#!/usr/bin/env node
/**
 * The canary of the delivery gate, run inside the sandbox before any check:
 * it tries what the profile must refuse, and says what it could do.
 *
 *   --write <path>     create the file (the path must not be writable)
 *   --append <path>    open the existing file for append, and add nothing
 *   --read <path>      read the file
 *   --list <path>      list the directory
 *   --connect <port>   reach 127.0.0.1:<port>
 *
 * One line per attempt that succeeded, and exit 1 if any did. When every one
 * was refused, one line that says how many, and exit 0: the gate reads the
 * line. An argument it does not know is a failure: a canary that skips an
 * attempt proves nothing.
 */
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const ATTEMPTS = {
  "--write": (path) => (writeFileSync(path, "canary", { flag: "wx" }), `wrote ${path}`),
  "--append": (path) => (appendFileSync(path, ""), `opened ${path} for writing`),
  "--read": (path) => (readFileSync(path), `read ${path}`),
  "--list": (path) => (readdirSync(path), `listed ${path}`),
};

const breaches = [];
const pending = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const [kind, target] = [args[i], args[i + 1]];
  if (kind === "--connect") {
    pending.push(
      new Promise((done) => {
        const socket = connect({ host: "127.0.0.1", port: Number(target), timeout: 3000 });
        socket.once("connect", () => {
          breaches.push(`connected to 127.0.0.1:${target}`);
          socket.destroy();
          done();
        });
        socket.once("error", done);
        socket.once("timeout", () => {
          socket.destroy();
          done();
        });
      }),
    );
  } else if (Object.hasOwn(ATTEMPTS, kind) && target !== undefined) {
    try {
      breaches.push(ATTEMPTS[kind](target));
    } catch {
      // refused: what the profile promises
    }
  } else {
    breaches.push(`unknown argument ${kind}`);
  }
}
await Promise.all(pending);
for (const breach of breaches) console.log(breach);
if (breaches.length === 0) console.log(`canary: ${args.length / 2} attempt(s), all refused`);
process.exit(breaches.length === 0 ? 0 : 1);
