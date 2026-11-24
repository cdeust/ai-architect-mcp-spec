import { API_KEY_FLAG_ERROR, ConfigError } from "./config.mjs";
import { redact } from "./redact.mjs";

const shared = [
  ["provider", "provider"], ["base-url", "baseUrl"], ["model", "model"], ["timeout-ms", "timeoutMs"],
];
const judge = new Map([...shared, ["debug", "debug"]]);
const calibration = new Map([...shared, ["min-agreement", "minAgreement"]]);

/** Parse both `--name value` and `--name=value` for either entry point. */
export function parseFlags(argv, entry = "judge") {
  const options = entry === "calibrate" ? calibration : judge;
  const flags = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new ConfigError("Unknown option.");
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (/^api[-_]?key$/i.test(name)) {
      throw new ConfigError(API_KEY_FLAG_ERROR);
    }
    const key = options.get(name);
    if (!key) throw new ConfigError("Unknown option.");
    const next = argv[i + 1];
    if (equals !== -1) {
      flags[key] = arg.slice(equals + 1);
    } else if (next !== undefined && !next.startsWith("-")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

export function writeCliError(script, error) {
  const reason = error instanceof ConfigError ? error.message : "unexpected failure";
  process.stderr.write(`${redact(`${script}: ${reason}`)}\n`);
  process.exitCode = 2;
}
