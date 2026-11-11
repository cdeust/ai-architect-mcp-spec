#!/usr/bin/env node
// clean.mjs <path>...: remove build output, relative to the current directory.
// The `clean` scripts called `rm -rf dist`, which a Windows shell does not
// have (#126). They also left `tsconfig.tsbuildinfo` behind: tsc then judged
// the project up to date and the next `pnpm build` emitted nothing.
import { rmSync } from "node:fs";

for (const path of process.argv.slice(2)) rmSync(path, { recursive: true, force: true });
