import { API_KEY_FLAG_ERROR, ConfigError } from "./config.mjs";
import { redact } from "./redact.mjs";

/** Parse both `--name value` and `--name=value` for either entry point. */
export function parseFlags(argv) {
  const flags = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (/^api[-_]?key$/i.test(name)) {
      throw new ConfigError(API_KEY_FLAG_ERROR);
    }
    const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (equals !== -1) {
      flags[key] = arg.slice(equals + 1);
    } else if (next !== undefined && !next.startsWith("--")) {
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
