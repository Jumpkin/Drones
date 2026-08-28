#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: write-deployment-log.sh <output.json>" >&2
  exit 64
fi

required=(
  DEPLOY_PRODUCT DEPLOY_ENVIRONMENT DEPLOY_COMMIT DEPLOY_IMAGE DEPLOY_METHOD
  DEPLOY_RUN_ID DEPLOY_RUN_URL DEPLOY_ATTEMPTED_AT DEPLOY_RESULT
  DEPLOY_BUILD_SECONDS DEPLOY_SERVER_SECONDS DEPLOY_TOTAL_SECONDS
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 64
  fi
done

case "$DEPLOY_RESULT" in
  success|failure|cancelled) ;;
  *) echo "Invalid DEPLOY_RESULT: $DEPLOY_RESULT" >&2; exit 64 ;;
esac

for name in DEPLOY_BUILD_SECONDS DEPLOY_SERVER_SECONDS DEPLOY_TOTAL_SECONDS; do
  [[ "${!name}" =~ ^[0-9]+$ ]] || {
    echo "$name must be an integer number of seconds" >&2
    exit 64
  }
done

jq --null-input \
  --arg schema "tael.deployment.v1" \
  --arg product "$DEPLOY_PRODUCT" \
  --arg environment "$DEPLOY_ENVIRONMENT" \
  --arg commit "$DEPLOY_COMMIT" \
  --arg image "$DEPLOY_IMAGE" \
  --arg method "$DEPLOY_METHOD" \
  --arg run_id "$DEPLOY_RUN_ID" \
  --arg run_url "$DEPLOY_RUN_URL" \
  --arg attempted_at "$DEPLOY_ATTEMPTED_AT" \
  --arg result "$DEPLOY_RESULT" \
  --argjson build_seconds "$DEPLOY_BUILD_SECONDS" \
  --argjson server_seconds "$DEPLOY_SERVER_SECONDS" \
  --argjson total_seconds "$DEPLOY_TOTAL_SECONDS" \
  '{
    schema: $schema,
    product: $product,
    environment: $environment,
    commit: $commit,
    image: $image,
    deployment: {
      method: $method,
      attempted_at: $attempted_at,
      result: $result
    },
    duration_seconds: {
      build_and_publish: $build_seconds,
      server_deploy_and_verify: $server_seconds,
      workflow_from_publish_start: $total_seconds
    },
    github: {
      run_id: $run_id,
      run_url: $run_url
    }
  }' >"$1"
