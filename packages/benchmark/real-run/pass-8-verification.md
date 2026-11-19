# Real-run benchmark verification, pass 8

Tested locally on macOS from base `8949933` through implementation commit `10018b2`, using canned replies and local executable stand-ins.

| Check | Result |
|---|---|
| `pnpm build` and `pnpm lint` | Both exited 0 |
| `pnpm vitest run packages/benchmark`, developer default TMPDIR | 494 tests passed in 51 files |
| Same command, TMPDIR set to a freshly created directory symlink under the system temporary directory | 494 tests passed in 51 files |
| Compiled CLI dry run, smoke plan | 12 calls, zero reported USD |
| Compiled CLI dry run, pilot plan | 27, 12, 27, 12 and 27 calls in plan order, zero reported USD across all arms |

The retained-workspace regression initially read the symlink alias from the journal while the stand-in reported its physical working directory. After the fix, the journal, record and summary agreed with the stand-in.

Separate compiled CLI processes received SIGTERM, SIGHUP and SIGQUIT at the CLI PID alone. Each exited with code 1, journaled the interrupted probe, removed its workspace and left neither the stand-in nor its descendant alive.

In the six-call parallel batch, the original CLI removed handlers after the 22nd journal attempt. With the fix, all 27 attempts finished before disposal. The injected write failure propagated, and all five siblings recorded their SIGKILL errors.

Five sections containing “ok” produced a reducer outcome of `passed` and a hard-output score of 1. The bench reported 10 total characters, a minimum of 2 and the quality warning. Separate fixtures exercised distinct short sections, identical long sections and distinct sections at the 200-character boundary.

The installed Stryker 10.1.1 instrumenter generated 59 mutants whose spans overlapped changed production lines relative to `8949933`. Each replacement was applied alone to a disposable source copy and produced a failing Vitest run. The unmodified control passed. No new mutation suppression was added. The full delivery gate and live model behavior remain unverified.
