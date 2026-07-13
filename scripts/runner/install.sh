#!/bin/zsh
set -euo pipefail

ARTIFACT_BASE="${RUNNER_ARTIFACT_PUBLIC_BASE_URL:-}"
SERVER=""
TOKEN=""
CODEX_HOME_VALUE="${CODEX_HOME:-$HOME/.codex}"
PROFILE=""
EXECUTOR_ID=""
ASSUME_YES=false
UPGRADE=false
typeset -a WORKSPACES
WORKSPACES=()

fail() { print -u2 -- "安装失败：$*"; exit 1; }
info() { print -- "==> $*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "缺少系统命令：$1"; }
yaml_quote() { print -n -- "'$(print -n -- "$1" | sed "s/'/''/g")'"; }
xml_escape() { print -n -- "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
json_value() { /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null || fail "manifest 缺少字段：$2"; }
sha256_file() { /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'; }
slug() { print -n -- "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+|-+$//g'; }

while (( $# )); do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --artifact-base) ARTIFACT_BASE="${2:-}"; shift 2 ;;
    --codex-home) CODEX_HOME_VALUE="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --workspace) WORKSPACES+=("${2:-}"); shift 2 ;;
    --executor-id) EXECUTOR_ID="${2:-}"; shift 2 ;;
    --yes) ASSUME_YES=true; shift ;;
    --upgrade) UPGRADE=true; shift ;;
    *) fail "未知参数：$1" ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || fail "第一版只支持 macOS"
case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) fail "不支持的 CPU 架构：$(uname -m)" ;;
esac
need curl; need tar; need shasum; need plutil; need launchctl; need openssl
[[ -n "$ARTIFACT_BASE" ]] || fail "缺少 --artifact-base"
ARTIFACT_BASE="${ARTIFACT_BASE%/}"

INSTALL_ROOT="$HOME/Library/Application Support/Lark Agent Runner"
MANIFEST="$(mktemp -t lark-agent-runner-manifest).json"
PAYLOAD="$(mktemp -t lark-agent-runner-payload).json"
RESPONSE="$(mktemp -t lark-agent-runner-response).json"
STAGING=""
ENROLLED=false
cleanup() {
  rm -f "$MANIFEST" "$PAYLOAD" "$RESPONSE"
  [[ -z "$STAGING" ]] || rm -rf "$STAGING"
  if [[ "$ENROLLED" != true && -n "${INSTALL_DIR:-}" && -f "${CREDENTIAL_FILE:-}" ]]; then
    rm -f "$CREDENTIAL_FILE"
  fi
}
trap cleanup EXIT INT TERM

info "读取 Runner 发布清单"
curl -fsSL --retry 2 --connect-timeout 8 "$ARTIFACT_BASE/runner/manifest.json" -o "$MANIFEST"
VERSION="$(json_value "$MANIFEST" version)"
WORKER_PATH="$(json_value "$MANIFEST" worker.path)"
WORKER_SHA="$(json_value "$MANIFEST" worker.sha256)"
MANAGER_PATH="$(json_value "$MANIFEST" manager.path)"
MANAGER_SHA="$(json_value "$MANIFEST" manager.sha256)"
NODE_PATH="$(json_value "$MANIFEST" node.$ARCH.path)"
NODE_SHA="$(json_value "$MANIFEST" node.$ARCH.sha256)"

install_release() {
  local target="$1"
  local version_dir="$target/versions/$VERSION"
  if [[ -x "$version_dir/node/bin/node" && -f "$version_dir/worker.mjs" ]]; then
    return
  fi
  STAGING="$(mktemp -d -t lark-agent-runner-release)"
  info "下载 Runner $VERSION（$ARCH）"
  curl -fsSL --retry 2 --connect-timeout 8 "$ARTIFACT_BASE/runner/$WORKER_PATH" -o "$STAGING/worker.mjs"
  curl -fsSL --retry 2 --connect-timeout 8 "$ARTIFACT_BASE/runner/$NODE_PATH" -o "$STAGING/node.tar.gz"
  [[ "$(sha256_file "$STAGING/worker.mjs")" == "$WORKER_SHA" ]] || fail "Worker 文件校验失败"
  [[ "$(sha256_file "$STAGING/node.tar.gz")" == "$NODE_SHA" ]] || fail "Node 运行时校验失败"
  mkdir -p "$STAGING/release/node" "$target/versions"
  tar -xzf "$STAGING/node.tar.gz" --strip-components 1 -C "$STAGING/release/node"
  mv "$STAGING/worker.mjs" "$STAGING/release/worker.mjs"
  print -r -- "$VERSION" > "$STAGING/release/VERSION"
  rm -rf "$version_dir"
  mv "$STAGING/release" "$version_dir"
  STAGING=""
}

install_manager() {
  local manager_dir="$INSTALL_ROOT/bin"
  local manager_target="$manager_dir/lark-agent-runner"
  local manager_tmp
  manager_tmp="$(mktemp -t lark-agent-runner-manager)"
  info "安装本机管理命令"
  curl -fsSL --retry 2 --connect-timeout 8 "$ARTIFACT_BASE/runner/$MANAGER_PATH" -o "$manager_tmp"
  [[ "$(sha256_file "$manager_tmp")" == "$MANAGER_SHA" ]] || { rm -f "$manager_tmp"; fail "管理命令校验失败"; }
  mkdir -p "$manager_dir" "$HOME/.local/bin"
  chmod 755 "$manager_tmp"
  mv "$manager_tmp" "$manager_target"
  ln -sfn "$manager_target" "$HOME/.local/bin/lark-agent-runner"
}

update_config_runner_version() {
  local config_file="$1" runner_version="$2"
  local config_tmp
  config_tmp="$(mktemp -t lark-agent-runner-config)"
  sed -E "s/^  runner_version: .*/  runner_version: '$runner_version'/" "$config_file" > "$config_tmp"
  grep -Fq "  runner_version: '$runner_version'" "$config_tmp" || { rm -f "$config_tmp"; fail "执行器配置缺少 runner_version"; }
  chmod 600 "$config_tmp"
  mv "$config_tmp" "$config_file"
}

restart_service() {
  local label="$1" plist="$2"
  launchctl bootout "gui/$UID" "$plist" >/dev/null 2>&1 || true
  local attempt
  for attempt in {1..20}; do
    if ! launchctl print "gui/$UID/$label" >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
  launchctl bootstrap "gui/$UID" "$plist"
  launchctl kickstart -k "gui/$UID/$label"
}

wait_online() {
  local server="$1" executor="$2" credential="$3"
  local attempt
  for attempt in {1..30}; do
    if curl -fsS --connect-timeout 3 -H "Authorization: Bearer $credential" "$server/v1/runner/status/$executor" 2>/dev/null | grep -q '"online":true'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if [[ "$UPGRADE" == true ]]; then
  typeset -a installs
  installs=("$INSTALL_ROOT"/*(N/))
  (( ${#installs} > 0 )) || fail "没有找到已安装的 Lark Agent Runner"
  if (( ${#installs} == 1 )); then
    INSTALL_DIR="$installs[1]"
  elif [[ -n "$EXECUTOR_ID" && -d "$INSTALL_ROOT/$EXECUTOR_ID" ]]; then
    INSTALL_DIR="$INSTALL_ROOT/$EXECUTOR_ID"
  elif [[ -r /dev/tty ]]; then
    print -- "检测到多个执行器："
    local_index=1
    for item in "${installs[@]}"; do print -- "  $local_index) ${item:t}"; (( local_index++ )); done
    print -n -- "请选择序号：" > /dev/tty
    read choice < /dev/tty
    [[ "$choice" == <-> && "$choice" -ge 1 && "$choice" -le ${#installs} ]] || fail "选择无效"
    INSTALL_DIR="$installs[$choice]"
  else
    fail "检测到多个执行器，请使用 --executor-id 指定"
  fi
  [[ -f "$INSTALL_DIR/installation.env" && -f "$INSTALL_DIR/credentials" ]] || fail "安装目录不完整：$INSTALL_DIR"
  source "$INSTALL_DIR/installation.env"
  CREDENTIAL_FILE="$INSTALL_DIR/credentials"
  CREDENTIAL="$(<"$CREDENTIAL_FILE")"
  ENROLLED=true
  PREVIOUS_RUNNER_VERSION="$(sed -n "s/^  runner_version: '\(.*\)'$/\1/p" "$INSTALL_DIR/config.yaml" | head -1)"
  install_release "$INSTALL_DIR"
  install_manager
  update_config_runner_version "$INSTALL_DIR/config.yaml" "$VERSION"
  PREVIOUS="$(readlink "$INSTALL_DIR/current" 2>/dev/null || true)"
  ln -sfn "versions/$VERSION" "$INSTALL_DIR/current"
  if ! restart_service "$LAUNCHD_LABEL" "$PLIST_PATH" || ! wait_online "$CONTROL_PLANE_URL" "$EXECUTOR_ID" "$CREDENTIAL"; then
    [[ -z "$PREVIOUS" ]] || ln -sfn "$PREVIOUS" "$INSTALL_DIR/current"
    [[ -z "$PREVIOUS_RUNNER_VERSION" ]] || update_config_runner_version "$INSTALL_DIR/config.yaml" "$PREVIOUS_RUNNER_VERSION"
    restart_service "$LAUNCHD_LABEL" "$PLIST_PATH" || true
    fail "新版本启动失败，已回滚到上一版本；请查看 $INSTALL_DIR/logs/worker.err.log"
  fi
  info "执行器 $EXECUTOR_ID 已升级到 $VERSION"
  info "运行 lark-agent-runner help 可查看本机管理命令"
  exit 0
fi

[[ -n "$SERVER" ]] || fail "缺少 --server"
[[ -n "$TOKEN" ]] || fail "缺少 --token"
SERVER="${SERVER%/}"
curl -fsS --connect-timeout 5 "$SERVER/healthz" >/dev/null || fail "无法连接控制面：$SERVER"

CODEX_BIN="$(command -v codex || true)"
[[ -n "$CODEX_BIN" ]] || fail "没有找到 codex 命令"
CODEX_HOME_VALUE="$(cd "$CODEX_HOME_VALUE" 2>/dev/null && pwd -P)" || fail "CODEX_HOME 不存在：$CODEX_HOME_VALUE"
[[ -r "$CODEX_HOME_VALUE" && -w "$CODEX_HOME_VALUE" ]] || fail "CODEX_HOME 必须可读写"

if [[ -z "$PROFILE" ]]; then
  if [[ -f "$CODEX_HOME_VALUE/he.config.toml" ]]; then
    PROFILE="he"
  else
    typeset -a profiles
    profiles=("$CODEX_HOME_VALUE"/*.config.toml(N))
    if (( ${#profiles} == 1 )); then
      PROFILE="${profiles[1]:t:r:r}"
    elif (( ${#profiles} > 1 )) && [[ -r /dev/tty ]]; then
      print -- "可用 Codex profiles："
      local_index=1
      for item in "${profiles[@]}"; do print -- "  $local_index) ${item:t:r:r}"; (( local_index++ )); done
      print -n -- "请选择序号：" > /dev/tty
      read choice < /dev/tty
      [[ "$choice" == <-> && "$choice" -ge 1 && "$choice" -le ${#profiles} ]] || fail "选择无效"
      PROFILE="${profiles[$choice]:t:r:r}"
    else
      fail "无法自动选择 profile，请使用 --profile 指定"
    fi
  fi
fi
[[ "$PROFILE" =~ '^[A-Za-z0-9_-]+$' && -f "$CODEX_HOME_VALUE/$PROFILE.config.toml" ]] || fail "profile 文件不存在或名称无效：$PROFILE"

if (( ${#WORKSPACES} == 0 )); then WORKSPACES+=("$PWD"); fi
if [[ "$ASSUME_YES" != true && -r /dev/tty ]]; then
  while true; do
    print -n -- "添加其他总工作区绝对路径（直接回车结束）：" > /dev/tty
    read extra < /dev/tty
    [[ -n "$extra" ]] || break
    WORKSPACES+=("$extra")
  done
fi
typeset -a CANONICAL_WORKSPACES
CANONICAL_WORKSPACES=()
for workspace in "${WORKSPACES[@]}"; do
  canonical="$(cd "$workspace" 2>/dev/null && pwd -P)" || fail "总工作区不存在：$workspace"
  CANONICAL_WORKSPACES+=("$canonical")
done

HOST_SLUG="$(slug "$(scutil --get LocalHostName 2>/dev/null || hostname -s)")"
[[ -n "$EXECUTOR_ID" ]] || EXECUTOR_ID="mac-${HOST_SLUG}-$(openssl rand -hex 3)"
[[ "$EXECUTOR_ID" =~ '^[A-Za-z0-9_-]+$' ]] || fail "executor ID 只能包含字母、数字、连字符和下划线"
DISPLAY_NAME="Mac · $(scutil --get ComputerName 2>/dev/null || hostname -s)"
INSTALL_DIR="$INSTALL_ROOT/$EXECUTOR_ID"
CREDENTIAL_FILE="$INSTALL_DIR/credentials"
CONFIG_FILE="$INSTALL_DIR/config.yaml"
LOG_DIR="$INSTALL_DIR/logs"
LAUNCHD_LABEL="io.github.lark-agent.runner.$EXECUTOR_ID"
PLIST_PATH="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
mkdir -p "$INSTALL_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$INSTALL_DIR"
install_release "$INSTALL_DIR"
install_manager
ln -sfn "versions/$VERSION" "$INSTALL_DIR/current"

{
  print "control_plane:"
  print "  url: $(yaml_quote "$SERVER")"
  print "  device_token_file: $(yaml_quote "$CREDENTIAL_FILE")"
  print "executor:"
  print "  id: $(yaml_quote "$EXECUTOR_ID")"
  print "  display_name: $(yaml_quote "$DISPLAY_NAME")"
  print "  codex_home: $(yaml_quote "$CODEX_HOME_VALUE")"
  print "  codex_profile: $(yaml_quote "$PROFILE")"
  print "  codex_binary: $(yaml_quote "$CODEX_BIN")"
  print "  runner_version: $(yaml_quote "$VERSION")"
  print "  capacity: 1"
  print "  capabilities:"
  print "    - codex"
  print "  workspace_roots:"
  typeset -A used_aliases
  for workspace in "${CANONICAL_WORKSPACES[@]}"; do
    alias_name="$(slug "${workspace:t}")"; [[ -n "$alias_name" ]] || alias_name="workspace"
    base_alias="$alias_name"; suffix=2
    while [[ -n "${used_aliases[$alias_name]:-}" ]]; do alias_name="$base_alias-$suffix"; (( suffix++ )); done
    used_aliases[$alias_name]=1
    print "    - alias: $(yaml_quote "$alias_name")"
    print "      path: $(yaml_quote "$workspace")"
  done
} > "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"
print -n -- "$TOKEN" > "$CREDENTIAL_FILE"
chmod 600 "$CREDENTIAL_FILE"

print -- ""
print -- "执行器：$EXECUTOR_ID"
print -- "Codex Home：$CODEX_HOME_VALUE"
print -- "Profile：$PROFILE"
print -- "总工作区：${(j:, :)CANONICAL_WORKSPACES}"
print -- "机器人专属工作区：每个机器人首次执行任务时自动使用 <总工作区>/<App ID>/"
print -- "控制面：$SERVER"
if [[ "$ASSUME_YES" != true && -r /dev/tty ]]; then
  print -n -- "确认注册并安装？[Y/n] " > /dev/tty
  read answer < /dev/tty
  [[ -z "$answer" || "$answer" == [Yy]* ]] || fail "已取消"
fi

info "验证 Codex 配置和 App Server 协议"
WORKER_CONFIG_FILE="$CONFIG_FILE" LARK_AGENT_ENROLLMENT_TOKEN="$TOKEN" \
  "$INSTALL_DIR/current/node/bin/node" "$INSTALL_DIR/current/worker.mjs" --enrollment-json > "$PAYLOAD"
info "注册执行器"
if ! curl -fsS --connect-timeout 8 -H 'content-type: application/json' --data-binary "@$PAYLOAD" "$SERVER/v1/runner/enroll" -o "$RESPONSE"; then
  fail "控制面拒绝注册；注册链接可能已过期或使用"
fi
CREDENTIAL="$(json_value "$RESPONSE" deviceToken)"
[[ -n "$CREDENTIAL" ]] || fail "控制面没有返回设备凭据"
print -n -- "$CREDENTIAL" > "$CREDENTIAL_FILE"
chmod 600 "$CREDENTIAL_FILE"
ENROLLED=true

{
  print -r -- "CONTROL_PLANE_URL=${(q)SERVER}"
  print -r -- "ARTIFACT_BASE=${(q)ARTIFACT_BASE}"
  print -r -- "EXECUTOR_ID=${(q)EXECUTOR_ID}"
  print -r -- "LAUNCHD_LABEL=${(q)LAUNCHD_LABEL}"
  print -r -- "PLIST_PATH=${(q)PLIST_PATH}"
} > "$INSTALL_DIR/installation.env"
chmod 600 "$INSTALL_DIR/installation.env"

LABEL_XML="$(xml_escape "$LAUNCHD_LABEL")"
NODE_XML="$(xml_escape "$INSTALL_DIR/current/node/bin/node")"
NODE_DIR_XML="$(xml_escape "$INSTALL_DIR/current/node/bin")"
WORKER_XML="$(xml_escape "$INSTALL_DIR/current/worker.mjs")"
CONFIG_XML="$(xml_escape "$CONFIG_FILE")"
OUT_XML="$(xml_escape "$LOG_DIR/worker.log")"
ERR_XML="$(xml_escape "$LOG_DIR/worker.err.log")"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL_XML</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_XML</string>
    <string>$WORKER_XML</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>WORKER_CONFIG_FILE</key><string>$CONFIG_XML</string>
    <key>PATH</key><string>$NODE_DIR_XML:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$OUT_XML</string>
  <key>StandardErrorPath</key><string>$ERR_XML</string>
</dict></plist>
EOF
chmod 600 "$PLIST_PATH"
/usr/bin/plutil -lint "$PLIST_PATH" >/dev/null || fail "launchd 配置生成失败"

info "启动常驻执行器"
restart_service "$LAUNCHD_LABEL" "$PLIST_PATH"
if ! wait_online "$SERVER" "$EXECUTOR_ID" "$CREDENTIAL"; then
  fail "执行器未在 30 秒内上线，请查看 $LOG_DIR/worker.err.log"
fi
print -- ""
print -- "执行器安装完成"
print -- ""
print -- "执行器：$EXECUTOR_ID"
print -- "状态：已在线"
print -- "Runner：$VERSION"
print -- ""
if command -v lark-agent-runner >/dev/null 2>&1; then
  MANAGER_COMMAND="lark-agent-runner"
else
  MANAGER_COMMAND="$HOME/.local/bin/lark-agent-runner"
  print -- "当前 PATH 尚未包含 ~/.local/bin，可先使用下面显示的完整命令。"
  print -- "如需直接使用 lark-agent-runner，请将以下内容加入 ~/.zshrc："
  print -- '  export PATH="$HOME/.local/bin:$PATH"'
  print -- ""
fi
print -- "之后可以使用以下命令管理执行器："
print -- ""
print -- "  $MANAGER_COMMAND status $EXECUTOR_ID"
print -- "  $MANAGER_COMMAND stop $EXECUTOR_ID"
print -- "  $MANAGER_COMMAND start $EXECUTOR_ID"
print -- "  $MANAGER_COMMAND logs $EXECUTOR_ID"
print -- ""
print -- "查看全部命令："
print -- "  $MANAGER_COMMAND help"
