# Native reconciliation integration, 2026-10-28

The final production hashes and validation results are recorded in native-review-proof-first-20261028.md. The scheduled workflow includes checks:read and the four bounded completion jobs. Workflows were regenerated from the canonical native template while preserving ci.json byte-for-byte.

The first integration used canonical PR201 aaf31d377e0b17731b54211883654a6553e2f42a; the final correction adds authenticated proof before REST discovery and isolates known per-PR NOT_FOUND errors. Existing full proof remains the rerun authorizer. Spec107 local native CI contracts, Ruff and actionlint pass. Hosted fallback acceptance follows installation on main.
