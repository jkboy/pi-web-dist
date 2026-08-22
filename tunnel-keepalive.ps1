# SSH 反向隧道常驻守护（本机 Windows）
# 保持 ssh -R 反向隧道不掉线：VPS 127.0.0.1:<remotePort> -> 本机 127.0.0.1:7318
# 配合 Caddy 反代（VPS: reverse_proxy 127.0.0.1:<remotePort>）实现公网远程访问。
#
# 设计（比用 ssh -f 后台更可靠）：
#   - ssh 以【前台阻塞】方式跑，掉线/被杀时 ssh 进程退出、返回非零退出码，循环据此重连。
#   - ServerAliveInterval+ServerAliveCountMax 让 ssh 主动探测掉线，避免半死连接挂死。
#   - 启动前探测本机 7318 在监听（防隧道空跑）。
#   - 捕获 ssh 输出：命中「remote port forwarding failed」= VPS 上旧会话（僵尸）还占着端口。
#     带流量断链时 sshd 的 ClientAlive 探测发不出去，僵尸要等内核 TCP 重传超时才死
#     （tcp_retries2 默认 15 ≈ 10~20 分钟，实测挂 10 分钟+）。此时主动 ssh 上 VPS
#     杀掉占端口的会话进程，5s 后重连，把恢复时间从分钟级压到秒级。
#   - 会话存活超 60s 说明上次连接是稳定的，掉线后重置退避从 5s 重来；
#     连环失败才指数退避（上限 120s，防崩溃风暴）。
#   - 日志追加写 ssh-tunnel.log。
#
# 用法：手动跑，或注册计划任务常驻（推荐 XML 方式注册，见 install-pi-web.mjs registerTunnel）。
#   powershell -ExecutionPolicy Bypass -File tunnel-keepalive.ps1

$ErrorActionPreference = "Continue"   # ssh 的 stderr 不能触发异常中断——输出要捕获下来分析

# ---- 配置（按需修改）----
$SshExe = "C:\Windows\System32\OpenSSH\ssh.exe"
$SshHost = "pi-vps"                 # 匹配 ~/.ssh/config 里的 Host（免密登录）
$RemotePort = "17001"               # VPS 上由 sshd 监听的隧道出口端口
$LocalTarget = "127.0.0.1:7318"     # 本机 pi-web
$LogFile = Join-Path $PSScriptRoot "ssh-tunnel.log"
$LocalPort = 7318                   # 本机 pi-web 端口（用于存活探测）
# --------------------------

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Write-Host $line
  Add-Content -Path $LogFile -Value $line
}

# 本机 pi-web 是否在监听（防止隧道空跑）
function LocalUp {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect("127.0.0.1", $LocalPort)
    $c.Close()
    return $true
  } catch { return $false }
}

# 杀掉 VPS 上占着 $RemotePort 的 sshd 会话进程（按端口定位，只杀会话子进程，不碰 sshd 主进程）。
# 注意：若两台机器误配了同一个端口，这里会互相踢——端口分配必须一人一个。
function ClearRemotePort {
  $cmd = 'p=$(ss -tlnp "sport = :' + $RemotePort + '" | grep -oE "pid=[0-9]+" | head -n1 | cut -d= -f2); ' +
         'if [ -n "$p" ]; then kill "$p" && echo "killed:$p"; else echo "no-holder"; fi'
  try {
    $r = & $SshExe -o ConnectTimeout=10 -o BatchMode=yes $SshHost $cmd 2>&1 | ForEach-Object { "$_" }
    Log "远端端口清理：$($r -join ' ')"
  } catch { Log "远端端口清理失败：$_" }
}

$backoff = 5
Log "SSH 隧道守护启动：$SshHost  $RemotePort -> $LocalTarget"

while ($true) {
  if (-not (LocalUp)) {
    Log "本机 $LocalPort 未监听，等待 10s ..."
    Start-Sleep -Seconds 10
    continue
  }
  Log "启动隧道（backoff=${backoff}s）..."
  $started = Get-Date
  $out = New-Object System.Collections.Generic.List[string]
  try {
    & $SshExe -N -R "127.0.0.1:${RemotePort}:${LocalTarget}" `
      -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
      -o ExitOnForwardFailure=yes -o ConnectTimeout=20 -o BatchMode=yes $SshHost 2>&1 |
      ForEach-Object { $out.Add("$_") }
    $code = $LASTEXITCODE
  } catch {
    $code = -1
    $out.Add("$_")
  }
  $lived = [int]((Get-Date) - $started).TotalSeconds
  $outText = $out -join "`n"
  Log "ssh 退出（code $code，存活 ${lived}s）：$(($out | Select-Object -Last 3) -join ' | ')"

  if ($lived -gt 60) { $backoff = 5 }   # 稳定会话后的掉线：快速重连，不背历史退避

  if ($outText -match 'remote port forwarding failed|Address already in use') {
    ClearRemotePort   # 僵尸占端口：主动清掉，否则要等 VPS 内核 TCP 重传超时（分钟级）
    Start-Sleep -Seconds 5
  } else {
    Start-Sleep -Seconds $backoff
    $backoff = [Math]::Min($backoff * 2, 120)
  }
}
