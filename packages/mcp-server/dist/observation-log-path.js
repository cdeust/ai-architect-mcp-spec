/**
 * Where the server appends judge observations: beside its databases, in
 * `~/.prd-gen/`.
 *
 * The default of the benchmark package (JUDGE_OBSERVATION_LOG_PATH) is a
 * path relative to the root of a clone, for calibration runs made from
 * there. The server passed it as it was: resolved against the working
 * directory of a server a host had started in the user's project, it
 * created `packages/benchmark/calibration/data/` in that project (#243).
 *
 * PRIVACY.md names this file with the two databases; a test holds that.
 */
import { homedir } from "node:os";
import { join } from "node:path";
export const OBSERVATION_LOG_PATH = join(homedir(), ".prd-gen", "judge-observation-log.jsonl");
//# sourceMappingURL=observation-log-path.js.map