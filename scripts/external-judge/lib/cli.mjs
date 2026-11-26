import { API_KEY_FLAG_ERROR, ConfigError } from "./config.mjs";
import { redact } from "./redact.mjs";

/** Options that take a mandatory value, then boolean flags that take none. */
const shared = [
  ["provider", "provider"], ["base-url", "baseUrl"], ["model", "model"], ["timeout-ms", "timeoutMs"],
].map(([name, key]) => [name, { key, valued: true }]);
const judge = new Map([...shared, ["debug", { key: "debug", valued: false }]]);
const calibration = new Map([...shared, ["min-agreement", { key: "minAgreement", valued: true }]]);

/** A ratio in [0, 1]; anything else (blank, signed, hex, NaN) would silently move the admission gate. */
const RATIO = /^(?:\d+\.?\d*|\.\d+)$/;

/** Parse both `--name value` and `--name=value` for either entry point. */
export function parseFlags(argv, entry) {
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
    const option = options.get(name);
    if (!option) throw new ConfigError("Unknown option.");
    if (!option.valued) {
      // A flag takes no value; the next argument is parsed on its own, so a stray one is refused.
      if (equals !== -1) throw new ConfigError("Unexpected option value.");
      flags[option.key] = "true";
      continue;
    }
    const next = argv[i + 1];
    let value;
    if (equals !== -1) {
      value = arg.slice(equals + 1);
    } else if (next !== undefined && !next.startsWith("-")) {
      value = next;
      i++;
    }
    if (!value) throw new ConfigError("Option requires a value.");
    if (option.key === "minAgreement" && !(RATIO.test(value) && Number(value) <= 1)) {
      throw new ConfigError("Option --min-agreement must be a number from 0 to 1.");
    }
    flags[option.key] = value;
  }
  return flags;
}

export function writeCliError(script, error) {
  const reason = error instanceof ConfigError ? error.message : "unexpected failure";
  process.stderr.write(`${redact(`${script}: ${reason}`)}\n`);
  process.exitCode = 2;
}
