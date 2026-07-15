#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$root"

files=$(git ls-files --cached --others --exclude-standard | grep -v '^scripts/check-public-safety\.sh$' || true)
[ -n "$files" ] || exit 0

patterns='happyelements|inner-h5|pan\.sho\.|10\.160\.|/Users/[A-Za-z0-9._-]+/|lark-azhu-agent|Azhu Agent|Azhu\.Skill|com\.happyelements|(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{12,}|(^|[^A-Za-z0-9])cli_[A-Za-z0-9]{12,}|(^|[^A-Za-z0-9])ou_[A-Za-z0-9]{12,}|(^|[^A-Za-z0-9])oc_[A-Za-z0-9]{12,}'

matches=$(printf '%s\n' "$files" | xargs grep -nEI "$patterns" 2>/dev/null || true)
if [ -n "$matches" ]; then
  echo "公开发布检查失败：发现内部标识、绝对路径或疑似凭据。" >&2
  printf '%s\n' "$matches" >&2
  exit 1
fi

echo "公开发布检查通过"
