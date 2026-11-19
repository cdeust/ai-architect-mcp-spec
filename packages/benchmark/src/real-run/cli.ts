import { productionIo } from "./production-io.js";
import { runCli } from "./cli-main.js";

process.exitCode = await runCli(process.argv.slice(2), process.env, productionIo(process));
