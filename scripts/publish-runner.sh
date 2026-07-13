#!/bin/sh
set -eu

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
  shift
fi
[ "$#" -eq 0 ] || { echo "usage: $0 [--dry-run]" >&2; exit 2; }

PUBLIC_BASE_URL="${RUNNER_ARTIFACT_PUBLIC_BASE_URL:-}"
RSYNC_TARGET="${RUNNER_ARTIFACT_RSYNC_TARGET:-}"
PASSWORD_FILE="${RUNNER_ARTIFACT_RSYNC_PASSWORD_FILE:-}"
NODE_VERSION="${RUNNER_NODE_VERSION:-24.1.0}"
VERSION="${RUNNER_VERSION:-$(node -p "require('./package.json').version")}"
ROOT="dist/runner-release"
RUNNER_ROOT="$ROOT/runner"
RELEASE="$RUNNER_ROOT/releases/$VERSION"

case "$PUBLIC_BASE_URL" in */) PUBLIC_BASE_URL=${PUBLIC_BASE_URL%/} ;; esac
[ -n "$PUBLIC_BASE_URL" ] || { echo "缺少 RUNNER_ARTIFACT_PUBLIC_BASE_URL" >&2; exit 2; }
[ -n "$RSYNC_TARGET" ] || { echo "缺少 RUNNER_ARTIFACT_RSYNC_TARGET" >&2; exit 2; }
case "$RSYNC_TARGET" in */) ;; *) echo "RUNNER_ARTIFACT_RSYNC_TARGET 必须以 / 结尾" >&2; exit 2 ;; esac

pnpm build:runner
rm -rf "$ROOT"
mkdir -p "$RELEASE"
cp dist/runner/worker.mjs "$RELEASE/worker.mjs"
cp scripts/runner/lark-agent-runner "$RELEASE/lark-agent-runner"
cp scripts/runner/install.sh "$RUNNER_ROOT/install.sh"
chmod 755 "$RELEASE/lark-agent-runner"
chmod 755 "$RUNNER_ROOT/install.sh"

download_node() {
  arch="$1"
  target="$RELEASE/node-darwin-$arch.tar.gz"
  url="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$arch.tar.gz"
  echo "下载 $url"
  curl -fL --retry 3 --connect-timeout 15 "$url" -o "$target"
}

download_node arm64
download_node x64

worker_sha=$(shasum -a 256 "$RELEASE/worker.mjs" | awk '{print $1}')
manager_sha=$(shasum -a 256 "$RELEASE/lark-agent-runner" | awk '{print $1}')
arm_sha=$(shasum -a 256 "$RELEASE/node-darwin-arm64.tar.gz" | awk '{print $1}')
x64_sha=$(shasum -a 256 "$RELEASE/node-darwin-x64.tar.gz" | awk '{print $1}')
(cd "$RELEASE" && shasum -a 256 worker.mjs lark-agent-runner node-darwin-arm64.tar.gz node-darwin-x64.tar.gz > checksums.sha256)

published_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$RUNNER_ROOT/manifest.json" <<EOF
{
  "version": "$VERSION",
  "publishedAt": "$published_at",
  "worker": {
    "path": "releases/$VERSION/worker.mjs",
    "sha256": "$worker_sha"
  },
  "manager": {
    "path": "releases/$VERSION/lark-agent-runner",
    "sha256": "$manager_sha"
  },
  "node": {
    "arm64": {
      "path": "releases/$VERSION/node-darwin-arm64.tar.gz",
      "sha256": "$arm_sha"
    },
    "x64": {
      "path": "releases/$VERSION/node-darwin-x64.tar.gz",
      "sha256": "$x64_sha"
    }
  }
}
EOF

if [ "$DRY_RUN" = true ]; then
  echo "dry-run 完成：$RUNNER_ROOT"
  exit 0
fi

[ -n "$PASSWORD_FILE" ] || { echo "缺少 RUNNER_ARTIFACT_RSYNC_PASSWORD_FILE" >&2; exit 2; }
[ -f "$PASSWORD_FILE" ] || { echo "rsync 密码文件不存在：$PASSWORD_FILE" >&2; exit 2; }
perm=$(stat -f '%Lp' "$PASSWORD_FILE" 2>/dev/null || stat -c '%a' "$PASSWORD_FILE")
[ "$perm" = "600" ] || { echo "rsync 密码文件权限必须为 600，当前为 $perm" >&2; exit 2; }

rsync_put() {
  (cd "$ROOT" && rsync -a --relative --password-file="$PASSWORD_FILE" "$1" "$RSYNC_TARGET")
}

# 不可变版本产物先发布，稳定入口随后发布，manifest 永远最后发布。
rsync_put "runner/releases/$VERSION/"

verify_download() {
  path="$1" expected="$2"
  tmp=$(mktemp -t lark-agent-runner-verify)
  trap 'rm -f "$tmp"' EXIT INT TERM
  curl -fL --retry 3 --connect-timeout 15 "$PUBLIC_BASE_URL/runner/$path" -o "$tmp"
  actual=$(shasum -a 256 "$tmp" | awk '{print $1}')
  rm -f "$tmp"
  trap - EXIT INT TERM
  [ "$actual" = "$expected" ] || { echo "CDN 回读校验失败：$path" >&2; exit 1; }
}

verify_download "releases/$VERSION/worker.mjs" "$worker_sha"
verify_download "releases/$VERSION/lark-agent-runner" "$manager_sha"
verify_download "releases/$VERSION/node-darwin-arm64.tar.gz" "$arm_sha"
verify_download "releases/$VERSION/node-darwin-x64.tar.gz" "$x64_sha"
rsync_put "runner/install.sh"
rsync_put "runner/manifest.json"
curl -fsSL --retry 3 "$PUBLIC_BASE_URL/runner/manifest.json" | grep -Fq "\"version\": \"$VERSION\"" || {
  echo "CDN manifest 回读失败" >&2
  exit 1
}
echo "Runner $VERSION 已发布：$PUBLIC_BASE_URL/runner/manifest.json"
