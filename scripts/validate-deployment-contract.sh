#!/usr/bin/env bash

set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workflow="$repo_dir/.github/workflows/deploy-development.yml"
logger="$repo_dir/scripts/write-deployment-log.sh"

fail() {
  echo "Deployment contract violation: $1" >&2
  exit 1
}

[[ -f "$repo_dir/AGENTS.md" ]] || fail "AGENTS.md is missing"
[[ -f "$workflow" ]] || fail "deployment workflow is missing"
[[ -x "$logger" ]] || fail "deployment log generator is missing or not executable"

require_workflow_text() {
  local expected="$1"
  local description="$2"
  grep --fixed-strings --quiet -- "$expected" "$workflow" || fail "$description"
}

require_workflow_text 'cache-from type=gha' 'BuildKit read cache is required'
require_workflow_text 'cache-to type=gha,mode=max' 'BuildKit write cache is required'
require_workflow_text 'needs: validate' 'main must validate before publishing'
require_workflow_text 'Verify and scan the published digest' 'the published digest must be runtime-verified'
require_workflow_text 'StrictHostKeyChecking=yes' 'strict SSH host-key checking is required'
require_workflow_text 'Deploy and verify with automatic rollback' 'verified rollback deployment step is required'
require_workflow_text 'if: always()' 'failure-path logging is required'
require_workflow_text './scripts/write-deployment-log.sh deployment-log.json' 'deployment receipt generation is required'
require_workflow_text 'name: tael-deployment-log-${{ github.run_id }}' 'stable deployment artifact name is required'
require_workflow_text 'retention-days: 90' '90-day deployment receipt retention is required'
require_workflow_text 'if-no-files-found: error' 'missing deployment receipts must fail CI'

bash -n "$logger"
echo "Tael deployment contract is valid."
