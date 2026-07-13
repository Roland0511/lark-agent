#!/bin/sh
set -eu

: "${CODEX_HOME:?CODEX_HOME is set by the worker}"
WORKSPACE="${1:?workspace path is required}"
exec codex app "$WORKSPACE"
