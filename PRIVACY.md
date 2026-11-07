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

- A **local SQLite database** at `~/.prd-gen/evidence.db` by default, or at the
  absolute path in `PRD_GEN_EVIDENCE_DB` when you set it. This database holds quality scores, strategy-execution
  records, and calibration data accumulated from your local pipeline runs. It exists
  solely on your machine.
- The database is created on first run and is never synced or uploaded anywhere.

## What data leaves your machine

Nothing, unless you explicitly pass information to other tools (e.g., Cortex recall,
`ai-architect-mcp-codebase`). This server does not make outbound network requests of its own.

## Telemetry

None. There is no analytics, usage tracking, error reporting, or crash reporting.

## Third-party services

None. The server has no external dependencies at runtime (beyond Node.js and the
optional `better-sqlite3` native addon, which executes locally).

## Data retention

The evidence database persists until you delete it. It contains only data your own
pipeline runs produced. You can delete that file (`~/.prd-gen/evidence.db` by default) at any time with no
consequence other than losing historical calibration data.

## Contact

Questions or concerns: open an issue at
<https://github.com/cdeust/ai-architect-mcp-spec/issues>.
