// Run after the shell has drained stdin and dispatched the sequential replies.
const { appendFileSync, existsSync, mkdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { OUT, START } = process.env;
let leader = true;
try {
  mkdirSync(join(OUT, "claimed"));
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  leader = false;
}

// Same release-file polling interval as the original shell stand-in.
const wait = setInterval(() => {
  if (leader && existsSync(join(OUT, "release"))) {
    clearInterval(wait);
    process.stdout.write(readFileSync(join(OUT, "reply-" + START)));
  }
}, 50);
appendFileSync(join(OUT, "ready"), process.pid + "\n");
