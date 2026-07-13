#!/bin/sh
set -eu

ENV_FILE="${LARK_AGENT_ENV_FILE:-$HOME/.config/lark-agent/worker.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

: "${WORKER_CONFIG_FILE:?WORKER_CONFIG_FILE must be set}"
exec node dist/worker/main.js
