#!/usr/bin/env bash
# Source: package.json and .github/workflows/ci.yml at 50d2f389.
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${1:?phase required}" in
  setup)
    pnpm install --frozen-lockfile
    pnpm build
    pnpm bundle
    ;;
  unit)
    # Preserve the existing statements >=80 coverage configuration.
    pnpm test:coverage
    ;;
  regression)
    pnpm test:perf
    pnpm test:external-judge
    ;;
  e2e)
    # Executes shipped commands and calls the verifier over real stdio.
    pnpm test:portable:runtime
    ;;
  environment)
    pnpm test:portable
    pnpm check:identity
    git diff --exit-code -- mcp-server/
    ;;
  installation)
    bash scripts/release/smoke-mcpb.sh
    ;;
  release-version)
    node -e 'const v=require("./package.json").version; console.log("version="+v); console.log("tag=v"+v)'
    ;;
  *) echo "Unknown phase: $1" >&2; exit 2 ;;
esac
