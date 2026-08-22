#!/usr/bin/env bash
# ============================================================
# pi-web SSH 反向隧道常驻守护（跨平台：macOS / Linux / Windows-GitBash）
# 保持 ssh -R 反向隧道不掉线：VPS 127.0.0.1:<RemotePort> -> 本机 127.0.0.1:7318
#
# 设计：ssh 前台阻塞跑，掉线退出码驱动重连循环；捕获输出识别「远端端口被僵尸会话占用」
#       （带流量断链时 VPS sshd 的 ClientAlive 探测发不出去，僵尸要等内核 TCP 重传超时
#       才死，tcp_retries2 默认 15 ≈ 10~20 分钟）→ 主动 ssh 上 VPS 杀掉占端口进程，
#       秒级恢复；会话存活 >60s 后掉线重置退避；连环失败才指数退避（上限 120s）。
#
# 用法：
#   手动： bash tunnel-keepalive.sh
#   常驻：由各平台服务管理器拉起（Windows 计划任务 / macOS launchd / Linux systemd）
# 配置：通过环境变量覆盖默认值。
# ============================================================
set -u

# ---- 配置（可用环境变量覆盖）----
SSH_EXE="${SSH_EXE:-ssh}"
SSH_HOST="${SSH_HOST:-pi-vps}"            # ~/.ssh/config 里的 Host（免密）
REMOTE_PORT="${REMOTE_PORT:-17001}"        # VPS 上 sshd 监听的隧道出口端口
LOCAL_TARGET="${LOCAL_TARGET:-127.0.0.1:7318}"
LOCAL_PORT="${LOCAL_PORT:-7318}"           # 本机 pi-web 端口（存活探测）
LOG_FILE="${LOG_FILE:-$(dirname "$0")/ssh-tunnel.log}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "$LOG_FILE"; }

# 本机 pi-web 是否在监听
local_up() {
  (echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null && return 0
  return 1
}

# 杀掉 VPS 上占着 REMOTE_PORT 的 sshd 会话进程（按端口定位，只杀会话子进程，不碰 sshd 主进程）
# 注意：若两台机器误配了同一个端口，这里会互相踢——端口分配必须一人一个。
clear_remote_port() {
  r=$("$SSH_EXE" -o ConnectTimeout=10 -o BatchMode=yes "$SSH_HOST" \
    'p=$(ss -tlnp "sport = :'"$REMOTE_PORT"'" | grep -oE "pid=[0-9]+" | head -n1 | cut -d= -f2); if [ -n "$p" ]; then kill "$p" && echo "killed:$p"; else echo "no-holder"; fi' 2>&1)
  log "远端端口清理：$r"
}

backoff=5
log "SSH 隧道守护启动：$SSH_HOST  $REMOTE_PORT -> $LOCAL_TARGET"

while true; do
  if ! local_up; then
    log "本机 $LOCAL_PORT 未监听，等待 10s ..."
    sleep 10
    continue
  fi
  log "启动隧道（backoff=${backoff}s）..."
  started=$(date +%s)
  out=$("$SSH_EXE" -N -R "127.0.0.1:${REMOTE_PORT}:${LOCAL_TARGET}" \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes -o ConnectTimeout=20 -o BatchMode=yes "$SSH_HOST" 2>&1)
  code=$?
  lived=$(( $(date +%s) - started ))
  log "ssh 退出（code $code，存活 ${lived}s）：$(printf '%s\n' "$out" | tail -n 3 | tr '\n' ' ')"

  [ "$lived" -gt 60 ] && backoff=5   # 稳定会话后的掉线：快速重连，不背历史退避

  if printf '%s' "$out" | grep -qE 'remote port forwarding failed|Address already in use'; then
    clear_remote_port   # 僵尸占端口：主动清掉，否则要等 VPS 内核 TCP 重传超时（分钟级）
    sleep 5
  else
    sleep "$backoff"
    backoff=$((backoff * 2 > 120 ? 120 : backoff * 2))
  fi
done
