# ============================================================
# pi-web 一键安装 / 配置 / 启动（Windows）
# ============================================================
# 用法：在 PowerShell（管理员）里运行：
#   powershell -ExecutionPolicy Bypass -File .\install-pi-web.ps1
#
# 交互流程：
#   1) 前置检查（Node ≥ 22、pi agent 配置）
#   2) 确认/安装 pi-web 全局包
#   3) 询问运行方式：仅本机(本地) / 需要远程访问(手机/笔记本)
#      - 仅本机：配好基础环境，启动 pi-web
#      - 远程：进一步询问 VPS 信息、访问 token、子域、隧道端口
#              → 配置环境变量 + 生成并常驻 SSH 反向隧道 + 启动 pi-web
#   4) 启动并验证
#
# 说明：本脚本自包含——会把隧道常驻脚本生成为 <安装目录>\tunnel-keepalive.ps1。
# ============================================================
[CmdletBinding()]
param(
  [switch]$SkipInstall,      # 跳过 pi-web 安装（仅配置/启动）
  [switch]$LocalOnly,        # 跳过交互，直接按本地模式配置启动
  [switch]$NoStart           # 只配置，不启动 pi-web
)
$ErrorActionPreference = "Stop"
$Script:Dir = $PSScriptRoot
$Script:ConfDir = Join-Path $env:USERPROFILE ".pi-web-setup"
New-Item -ItemType Directory -Force -Path $Script:ConfDir | Out-Null
$Script:LogFile = Join-Path $Script:ConfDir "install.log"

function Write-Step($msg) { Write-Host "`n>>> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)  { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg){ Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err($msg){ Write-Host "  [XX] $msg" -ForegroundColor Red }

function Log($msg) { Add-Content -Path $Script:LogFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" }

# ---------- 1. 前置检查 ----------
Write-Step "1/5 前置检查"
Log "=== install start ==="

$nodeOk = $false
try {
  $nodeVer = (& node --version 2>$null) -replace '^v',''
  if ($nodeVer -and [int]($nodeVer.Split('.')[0]) -ge 22) { $nodeOk = $true }
} catch {}
if (-not $nodeOk) {
  Write-Err "未检测到 Node.js ≥ 22。请先安装 Node.js LTS（https://nodejs.org）后重试。"
  exit 1
}
Write-Ok "Node.js $nodeVer"

# pi agent 配置检查
$agentModels = Join-Path $env:USERPROFILE ".pi\agent\models.json"
$hasModels = Test-Path $agentModels
$hasAnthropic = [bool]$env:ANTHROPIC_BASE_URL -or [bool]$env:ANTHROPIC_API_KEY
if (-not $hasModels -and -not $hasAnthropic) {
  Write-Warn "未检测到 pi agent 模型配置（$agentModels 或 ANTHROPIC_* 环境变量）。"
  Write-Warn "qika 需要 pi agent 有可用模型才能对话；若还没配，可稍后配置。"
}

# ---------- 2. 安装 / 确认 qika ----------
Write-Step "2/5 确认 qika 安装"
$piWebCmd = Get-Command qika -ErrorAction SilentlyContinue
if (-not $piWebCmd) {
  if ($SkipInstall) { Write-Err "未找到 qika 且已指定 -SkipInstall。先运行 npm i -g git+https://github.com/jkboy/qika-dist.git"; exit 1 }
  $yes = Read-Host "未安装 qika。现在安装吗？[Y/n]"
  if ($yes -notmatch '^[nN]') {
    Write-Host "  正在安装 qika（公开产物仓库，零凭证）..."
    npm install -g git+https://github.com/jkboy/qika-dist.git
    if ($LASTEXITCODE -ne 0) { Write-Err "安装失败，请检查网络后重试"; exit 1 }
    $piWebCmd = Get-Command qika -ErrorAction SilentlyContinue
    if (-not $piWebCmd) { Write-Err "安装完成但找不到 qika 命令（可能需要新开终端）；请重跑本脚本"; exit 1 }
    Write-Ok "已安装 qika"
  } else {
    Write-Warn "跳过安装。请自行安装后再运行。"
    exit 0
  }
} else {
  Write-Ok "qika 已安装"
}
# 版本（qika --version 读取产物 package.json）
$ver = (& qika --version 2>$null | Out-String).Trim()
if (-not $ver -or $ver -match '已有实例') { $ver = "（版本未知，请更新：npm i -g git+https://github.com/jkboy/qika-dist.git）" }
Write-Ok "qika $ver"

# ---------- 3. 运行方式交互 ----------
Write-Step "3/5 运行方式"
$mode = ""
if ($LocalOnly) { $mode = "local" }
else {
  # 已配过远程隧道的机器重跑安装器：空回车默认 R（重新生成守护脚本并刷新常驻任务），
  # 防习惯性回车落到 L 静默跳过隧道更新（同事机器实锤过）
  $hadRemote = Test-Path (Join-Path $Script:ConfDir "tunnel-keepalive.ps1")
  Write-Host "请选择运行方式："
  Write-Host "  [L] 仅本机使用（http://localhost:7318）—— 最简单"
  Write-Host "  [R] 需要远程访问（手机/笔记本通过域名访问，配置 SSH 隧道）"
  if ($hadRemote) { Write-Warn "检测到本机已有远程隧道配置：回车默认 R，将重新生成守护脚本并刷新常驻任务" }
  $def = if ($hadRemote) { "R" } else { "L" }
  $ans = Read-Host "  选择 [L/R]（默认 $def）"
  if (-not $ans) { $ans = $def }
  $mode = if ($ans -match '^[rR]') { "remote" } else { "local" }
}
Log "mode=$mode"

# ---------- 4. 配置 ----------
Write-Step "4/5 配置环境"

# 访问 token（本地与远程都需要；本地若已设则保留）
$hasToken = [bool][Environment]::GetEnvironmentVariable("PI_WEB_ACCESS_TOKEN","User")
if (-not $hasToken) {
  $defaultToken = (& node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" 2>$null)
  Write-Host "设置访问口令 PI_WEB_ACCESS_TOKEN（应用登录门，本机/远程登录都用它）："
  $tok = Read-Host "  输入自定义 token，或回车用随机生成的"
  if (-not $tok) { $tok = $defaultToken }
  [Environment]::SetEnvironmentVariable("PI_WEB_ACCESS_TOKEN", $tok, "User")
  $env:PI_WEB_ACCESS_TOKEN = $tok   # 同步当前进程（Start-Process 继承）
  Write-Ok "已设置访问 token（请妥善保管）：$tok"
} else {
  $env:PI_WEB_ACCESS_TOKEN = [Environment]::GetEnvironmentVariable("PI_WEB_ACCESS_TOKEN","User")
  Write-Ok "已存在 PI_WEB_ACCESS_TOKEN（已同步到当前进程环境）"
}

if ($mode -eq "remote") {
  # ---- 远程：额外交互 ----
  Write-Host "`n--- 远程访问配置 ---"
  $hosts = [Environment]::GetEnvironmentVariable("PI_WEB_ALLOWED_HOSTS","User")
  if (-not $hosts) {
    $sub = Read-Host "  你的远程子域（如 jk.pi.example.com）"
    if (-not $sub) { Write-Err "子域必填"; exit 1 }
    [Environment]::SetEnvironmentVariable("PI_WEB_ALLOWED_HOSTS", $sub, "User")
    $env:PI_WEB_ALLOWED_HOSTS = $sub   # 同步当前进程（Start-Process 继承）
    Write-Ok "PI_WEB_ALLOWED_HOSTS = $sub"
  } else {
    $env:PI_WEB_ALLOWED_HOSTS = $hosts
    Write-Ok "PI_WEB_ALLOWED_HOSTS 已存在：$hosts"
  }

  # SSH 隧道配置
  $sshHost = Read-Host "  SSH 免密 Host 名（~/.ssh/config 里的 Host，如 pi-vps）"
  if (-not $sshHost) { Write-Err "SSH Host 必填（远程隧道靠它）"; exit 1 }
  # 端口一人一个（VPS 管理员分配），不提供固定默认——17001 是他人端口，误用会与其隧道互相踢线；
  # 重跑时从既有守护脚本回读上次端口作默认值
  $prevPort = ""
  $tunnelOld = Join-Path $Script:ConfDir "tunnel-keepalive.ps1"
  if (Test-Path $tunnelOld) {
    $tOld = Get-Content $tunnelOld -Raw
    if ($tOld -match '\$RemotePort = "([^"]+)"') { $prevPort = $Matches[1] }
  }
  $portPrompt = if ($prevPort) { "  隧道端口（VPS 管理员分配的专属端口，回车用上次的 $prevPort）" } else { "  隧道端口（VPS 管理员分配的专属端口，每人一个）" }
  $port = Read-Host $portPrompt -ErrorAction SilentlyContinue
  if (-not $port -and $prevPort) { $port = $prevPort }
  if ($port -notmatch '^\d+$') { Write-Err "隧道端口必填且须为数字（向 VPS 管理员索取你的专属端口，不要填别人的）"; exit 1 }

  # 生成隧道常驻脚本到 ConfDir（自包含，内嵌模板）
  $tunnelScript = Join-Path $Script:ConfDir "tunnel-keepalive.ps1"
  $tpl = @'
# SSH 反向隧道常驻守护（由 install-pi-web.ps1 生成）
# 掉线重连；识别「远端端口被僵尸会话占用」时主动上 VPS 清理（否则要等内核 TCP 重传超时，可达 10 分钟+）
$ErrorActionPreference = "Continue"
$SshExe = "C:\Windows\System32\OpenSSH\ssh.exe"
$SshHost = "__SSHHOST__"
$RemotePort = "__PORT__"
$LocalTarget = "127.0.0.1:7318"
$LogFile = Join-Path $PSScriptRoot "ssh-tunnel.log"
$LocalPort = 7318
function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Write-Host $line
  Add-Content -Path $LogFile -Value $line
}
function LocalUp {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect("127.0.0.1", $LocalPort)
    $c.Close()
    return $true
  } catch { return $false }
}
# 只杀监听 $RemotePort 的会话子进程，不碰 sshd 主进程（端口必须一人一个，误共用会互相踢）
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
    ClearRemotePort
    Start-Sleep -Seconds 5
  } else {
    Start-Sleep -Seconds $backoff
    $backoff = [Math]::Min($backoff * 2, 120)
  }
}
'@
  $tpl = $tpl -replace '__SSHHOST__', $sshHost
  $tpl = $tpl -replace '__PORT__', $port
  Set-Content -Path $tunnelScript -Value $tpl -Encoding UTF8
  Write-Ok "隧道常驻脚本已生成：$tunnelScript"

  # 注册为计划任务（以当前用户运行，读到 ~/.ssh；比 SYSTEM 服务稳）
  # 不用 schtasks /tr：CLI 传参会 mangle 内层引号（实测生成 `-File " C:\...\` 的坏动作，
  # 任务注册成功但从未跑起来过），且 CLI 建的任务默认 72h 执行上限 + 电池策略限制。
  $taskName = "pi-web-ssh-tunnel"
  Write-Host "  注册隧道常驻计划任务（开机自启+掉线重连）..."
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $tunnelScript)
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
  # 注册返回成功≠任务真实在场：独立查询确认（同类静默失败在 mjs 安装器/schtasks 路径实锤过）
  if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    Write-Err "计划任务注册后查询不到，重启后隧道不会自动拉起——请以管理员身份重跑安装器"
    exit 1
  }
  Start-ScheduledTask -TaskName $taskName
  Write-Ok "隧道常驻已启动（任务名 $taskName）"
} else {
  Write-Ok "本地模式：无需隧道。"
}

# ---------- 5. 启动 ----------
Write-Step "5/5 启动 qika"
if ($NoStart) {
  Write-Ok "已配置完成（-NoStart）。启动：qika"
  exit 0
}

# 关键：从本进程启动（本进程已带当前用户环境变量）。先确认无旧实例。
$old = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'pi-web' }
if ($old) {
  $old | ForEach-Object { Write-Warn "停止旧实例 PID $($_.ProcessId)..."; Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
}

Write-Host "  启动 qika（http://localhost:7318）..."
# 用 Start-Process 起，避免本脚本阻塞；qika 是 npm 全局 .cmd，用 cmd /c 包装确保能找到
$log = Join-Path $Script:ConfDir "pi-web.log"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "qika" `
  -RedirectStandardOutput $log -RedirectStandardError (Join-Path $Script:ConfDir "pi-web.err.log") -WindowStyle Hidden
Start-Sleep -Seconds 5

# 验证
$health = $null
for ($i=0; $i -lt 6; $i++) {
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:7318/api/meta/health" -TimeoutSec 3; break }
  catch { Start-Sleep -Seconds 3 }
}
if ($health) {
  Write-Ok "qika 已启动：http://localhost:7318"
  Write-Host "`n完成！"
  Write-Host "  - 本机浏览器打开 http://localhost:7318，输入访问 token 登录"
  if ($mode -eq "remote") {
    $hosts = [Environment]::GetEnvironmentVariable("PI_WEB_ALLOWED_HOSTS","User")
    Write-Host "  - 手机/笔记本打开 https://$hosts ，输入同一 token 登录"
  }
  Write-Host "  - 访问 token 存于系统环境变量 PI_WEB_ACCESS_TOKEN（可从本脚本日志查看，建议牢记）"
} else {
  Write-Warn "未能确认 qika 启动，查看日志：$log"
  Write-Warn "可能需从新终端手动启动：qika"
}
