# Privacy Policy — AI Architect MCP Spec

**Effective date:** 2026-06-19

## What this server does

AI Architect MCP Spec is a local MCP server that turns a feature description into a
verified PRD (Product Requirements Document). It runs as a Node.js process on your
machine and communicates exclusively over stdio — it does not open any network port
and does not phone home.

## What data it processes

- **Feature descriptions and PRD text** you provide as tool arguments.
- **PRD context metadata** (context type, section types, strategy choices).
- **Codebase paths** you optionally pass to `start_pipeline` (read locally; not transmitted).

## What data it stores

Three files, all on your machine, in `~/.prd-gen/`. None is synced or uploaded
anywhere.

- `~/.prd-gen/evidence.db`, a **SQLite database**, or the absolute path in
  `PRD_GEN_EVIDENCE_DB` when you set it. It holds the quality score of each
  pipeline run and strategy-execution records. It is created the first time
  a tool reads it or a pipeline run writes to it.
- `~/.prd-gen/reliability.db`, a **SQLite database**. It holds, per judge and
  per type of claim, counts of how often the judge's verdict agreed with the
  outcome retained for the claim. It is created when the server starts, and
  written when a verification concludes with the types of its claims: at the
  self-check of each pipeline run, and when `conclude_verification` is called
  with `claim_types`.
- `~/.prd-gen/judge-observation-log.jsonl`, a **text log**, one line per
  judge verdict, created and written at the moment `reliability.db` is
  written. A line holds the judge's name, the claim's identifier and type,
  the verdict and the outcome as booleans, the run identifier and a
  timestamp; for a claim that carries an external check, also that check's
  result and the evidence string it returned, which can quote what the claim
  was checked on: a mathematical expression, or the first characters of a
  code snippet and of the compiler's message about it. Apart from that
  string it holds no text of your PRD.

In versions up to 0.9.0 the log was written at a path relative to the
directory the server was started in,
`packages/benchmark/calibration/data/judge-observation-log.jsonl`. If a host
started the server in one of your projects and called `conclude_verification`
with `claim_types`, that directory may exist there; it can be deleted.

## What data leaves your machine

Nothing, unless you explicitly pass information to other tools (e.g., Cortex recall,
`ai-architect-mcp-codebase`). This server does not make outbound network requests of its own.

## Telemetry

None. There is no analytics, usage tracking, error reporting, or crash reporting.

## Third-party services

None. The server has no external dependencies at runtime (beyond Node.js and the
optional `better-sqlite3` native addon, which executes locally).

## Data retention

The three files persist until you delete them. They contain only data your own
runs produced. You can delete any of them at any time: without `evidence.db`
you lose the quality history and the strategy records, without
`reliability.db` the consensus goes back to its default weights, and nothing
in the server reads the log: it is a record you can hand to calibration
tooling.

## Contact

Questions or concerns: open an issue at
<https://github.com/cdeust/ai-architect-mcp-spec/issues>.
