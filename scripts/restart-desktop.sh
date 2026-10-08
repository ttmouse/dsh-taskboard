#!/bin/bash
# restart-desktop.sh — 结束 DeepSeek Harness 桌面端，等端口退净后重新拉起。
#
# 用法:
#   restart-desktop.sh [--dry-run] [关闭后到重新启动之间的等待秒数，默认 10]
#   RESTART 可从任何地方调用；被 DSH agent 的工具 shell 拉起时也安全——
#   脚本检测到自己不在独立进程组时，会用 python3 os.setsid() 脱离后转后台重入，
#   因此桌面端退出连带杀宿主进程组时，脚本仍能活到重启完成（macOS 无 setsid 命令）。
#   拉起使用 open -a，可能静默失败，所以失败会重试（默认 3 次 × 每次 30 秒）。
#
# 日志: ~/.dsh/restart-desktop.log
set -u

APP_NAME="DeepSeek Harness"
APP_PATH="/Applications/${APP_NAME}.app"
LOG_FILE="$HOME/.dsh/restart-desktop.log"
PORTS="19387 47825"   # 19387 桌面 GUI；47825 taskboard 插件服务（进程内，随宿主退出）
GRACE_SECONDS="${GRACE_SECONDS:-10}"
ATTEMPT_TIMEOUT="${ATTEMPT_TIMEOUT:-30}"   # 每次拉起的等待窗口
LAUNCH_ATTEMPTS="${LAUNCH_ATTEMPTS:-3}"    # 拉起最多重试几次

log() {
  local line
  line="$(printf '%s %s' "$(date '+%F %T')" "$*")"
  printf '%s\n' "$line" >> "$LOG_FILE"
  # 只在连着终端时回显：脱离模式下 stderr 已重定向进同一个日志文件，回显会让每行重复
  [ -t 2 ] && echo "$line" >&2
  return 0
}

# --- 自保护：非进程组长（如被 agent 工具 shell 拉起）→ 脱离进程组、转后台重入 ---
# 转后台 + setsid 后父 shell 立即返回，重启全程在日志文件里进行。
# 必须放在参数解析之前：一旦先 shift 掉 --dry-run，重入的子进程就拿不到它，
# 演练会变成真重启（2026-10-07 实际翻过一次车）。
if [ "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')" != "$$" ]; then
  log "不在独立进程组：脱离并转后台重入（日志 → ${LOG_FILE}）"
  nohup python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
    "$0" "$@" >> "$LOG_FILE" 2>&1 &
  exit 0
fi

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; shift; fi
DELAY="${1:-10}"

# --- 单实例：两次重启交叠会互相抢 App/端口（2026-10-07 实测交叠过一次）---
# 用锁目录 + pid 存活判断，而不是 pgrep 匹配命令行——后者会把「命令行里只是提到
# 本脚本路径」的进程（例如拉起它的工具 shell）误判成并发实例，把自己拦死。
LOCK_DIR="$HOME/.dsh/restart-desktop.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    log "已有重启在进行中（pid ${holder}），本次退出"
    exit 0
  fi
  log "发现过期锁（pid ${holder:-未知} 已不存在），接管"
fi
echo "$$" > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

if [ ! -d "$APP_PATH" ]; then
  log "找不到 ${APP_PATH}，退出"
  exit 1
fi

app_pids() { pgrep -f "$APP_PATH" || true; }
ports_clear() {
  local p
  for p in $PORTS; do
    if lsof -tnP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then return 1; fi
  done
  return 0
}

log "=== 重启 ${APP_NAME} 开始（dry-run=${DRY_RUN}，启动前等待 ${DELAY}s） ==="

if [ "$DRY_RUN" = "1" ]; then
  log "[dry-run] 将执行：osascript 优雅退出 → 最多 ${GRACE_SECONDS}s 等进程退净（超时 kill -9）→ 等端口 ${PORTS} 退净 → 等 ${DELAY}s → open 拉起（失败最多重试 ${LAUNCH_ATTEMPTS} 次、每次等 ${ATTEMPT_TIMEOUT}s）"
  log "[dry-run] 当前进程: $(app_pids | tr '\n' ' ')"
  log "=== dry-run 结束，未做任何变更 ==="
  exit 0
fi

# 本次重启的时间标记：用来判断启动后有没有新崩溃日志
MARKER_FILE="$(mktemp -t dsh-restart)"
log "时间标记 ${MARKER_FILE}"
# 记录插件日志当前行数：启动后只看新增行，避免读到重启前的旧结论
PLUGIN_LOG="$HOME/.dsh/storages/dsh-taskboard/plugin.log"
PLUGIN_LOG_LINES="$(wc -l < "$PLUGIN_LOG" 2>/dev/null | tr -d ' ' || echo 0)"

# 1) 优雅退出（让 Electron 落盘会话状态），超时强杀
osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || log "osascript 退出失败（可能未在运行），继续"
local_deadline=$((SECONDS + GRACE_SECONDS))
while [ -n "$(app_pids)" ]; do
  if [ "$SECONDS" -ge "$local_deadline" ]; then
    log "优雅退出超时，强制结束: $(app_pids | tr '\n' ' ')"
    kill -9 $(app_pids) 2>/dev/null
    sleep 1
    break
  fi
  sleep 0.5
done
log "桌面端进程已全部退出"

# 2) 等端口退净（旧监听不退净就 open 会撞端口）
local_deadline=$((SECONDS + GRACE_SECONDS))
until ports_clear; do
  if [ "$SECONDS" -ge "$local_deadline" ]; then
    log "失败：端口未退净: $(for p in $PORTS; do lsof -tnP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | tr '\n' ' '; done)"
    exit 1
  fi
  sleep 0.5
done
log "端口 ${PORTS} 已退净"

# 3) 等待后拉起，失败就重试
# `open -a` 会静默失败：实测过一次（2026-10-07 20:07），命令发出去了、App 没起来，
# 脚本却在原地干等到超时。所以每次拉起只给 ATTEMPT_TIMEOUT 秒，不成就再发一次。
sleep "$DELAY"
attempt=0
ready=0
while [ "$attempt" -lt "$LAUNCH_ATTEMPTS" ] && [ "$ready" = "0" ]; do
  attempt=$((attempt + 1))
  if open -a "$APP_NAME"; then
    :
  else
    log "第 ${attempt} 次拉起：open 命令本身返回非零（退出码 $?）"
  fi
  log "第 ${attempt} 次拉起，等待 19387 就绪（最多 ${ATTEMPT_TIMEOUT}s）…"
  local_deadline=$((SECONDS + ATTEMPT_TIMEOUT))
  while [ "$SECONDS" -lt "$local_deadline" ]; do
    if lsof -tnP -iTCP:19387 -sTCP:LISTEN >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [ "$ready" = "0" ] && log "第 ${attempt} 次拉起在 ${ATTEMPT_TIMEOUT}s 内没有起来"
done
if [ "$ready" = "0" ]; then
  log "失败：连续 ${LAUNCH_ATTEMPTS} 次拉起都没就绪，请手动打开 ${APP_NAME}"
  exit 1
fi
log "=== ${APP_NAME} 已重启就绪（19387 监听中，第 ${attempt} 次拉起生效） ==="

# 5) 启动后自检：看板插件是否随宿主加载 + 本次重启后有没有新崩溃日志
sleep 3
if lsof -tnP -iTCP:47825 -sTCP:LISTEN >/dev/null 2>&1; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:47825/api/projects || echo 000)"
  log "自检：看板插件已随宿主加载（47825 监听，/api/projects → HTTP ${code}）"
else
  log "自检：47825 未监听 —— 看板插件没有随宿主加载"
fi
new_crash="$(find "$HOME/Library/Logs/DeepSeek Harness" -name 'crash-*-host.log' -newer "$MARKER_FILE" 2>/dev/null | head -3)"
if [ -n "$new_crash" ]; then
  log "自检：发现本次重启后的新崩溃日志：$(echo "$new_crash" | tr '\n' ' ')"
else
  log "自检：无新的宿主崩溃日志"
fi
# 插件启动后会刷新模型目录（供应商/模型数量）——等它打点，读新增行
catalog=""
for _ in $(seq 1 25); do
  catalog="$(tail -n +"$((PLUGIN_LOG_LINES + 1))" "$PLUGIN_LOG" 2>/dev/null | grep -o 'model catalog: .*' | tail -1)"
  [ -n "$catalog" ] && break
  sleep 1
done
log "自检：${catalog:-本次未见到新的模型目录打点（插件可能没起来）}"
rm -f "$MARKER_FILE"
