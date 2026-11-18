#!/usr/bin/env node
/**
 * The canary of the delivery gate, run inside the sandbox before any check:
 * it tries what the profile must refuse. Arguments: `--write <path>` (must
 * not be writable), `--read <path>` (must not be readable), `--connect
 * <port>` (127.0.0.1:<port> must not be reachable). It prints one line per
 * attempt that succeeded and exits 1 if any did, 0 if all were refused.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { connect } from "node:net";

const breaches = [];
const attempts = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const [kind, target] = [args[i], args[i + 1]];
  if (kind === "--write") {
    try {
      writeFileSync(target, "canary");
      breaches.push(`wrote ${target}`);
    } catch {
      // refused: what the profile promises
    }
  } else if (kind === "--read") {
    try {
      readFileSync(target);
      breaches.push(`read ${target}`);
    } catch {
      // refused
    }
  } else if (kind === "--connect") {
    attempts.push(
      new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port: Number(target), timeout: 3000 });
        socket.once("connect", () => {
          breaches.push(`connected to 127.0.0.1:${target}`);
          socket.destroy();
          resolve();
        });
        socket.once("error", resolve);
        socket.once("timeout", () => {
          socket.destroy();
          resolve();
        });
      }),
    );
  } else {
    breaches.push(`unknown argument ${kind}`);
  }
}
await Promise.all(attempts);
for (const breach of breaches) console.log(breach);
process.exit(breaches.length === 0 ? 0 : 1);
