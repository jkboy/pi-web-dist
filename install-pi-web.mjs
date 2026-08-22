#!/usr/bin/env node
// ============================================================
// qika（QiKa Code）跨平台一键安装 / 配置 / 启动（Windows / macOS / Linux）
// ============================================================
// 用法： node install-pi-web.mjs
//   （或全局安装后： node "$(npm root -g)/pi-web/install-pi-web.mjs"）
//
// 交互流程：
//   1) 前置检查（Node ≥ 22、pi agent 配置）
//   2) 确认/安装全局包（npm 包名保持 pi-web，命令为 qika）
//   3) 询问运行方式：仅本机(本地) / 需要远程访问(手机/笔记本)
//      - 仅本机：配好环境变量，启动 qika
//      - 远程：进一步询问 VPS 信息、访问 token、子域、隧道端口
//              → 配环境变量 + 生成并常驻 SSH 反向隧道 + 启动 qika
//   4) 启动并验证
//
// 说明：跨平台。隧道常驻脚本生成到 ~/.pi-web-setup/，并按平台注册：
//   Windows → 计划任务(schtasks)   macOS → launchd   Linux → systemd --user
// ============================================================
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const home = os.homedir();
const confDir = path.join(home, '.pi-web-setup');
fs.mkdirSync(confDir, { recursive: true });
const logFile = path.join(confDir, 'install.log');
const isTTY = process.stdout.isTTY;

// ---------- 输出 / 日志 ----------
const C = {
  reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', bold: '\x1b[1m',
};
function color(code, s) { return isTTY ? `${C[code]}${s}${C.reset}` : s; }
function step(m) { console.log(`\n>>> ${color('bold', color('cyan', m))}`); }
function ok(m)   { console.log(`  ${color('green', '[OK]')} ${m}`); }
function warn(m) { console.log(`  ${color('yellow', '[!!]')} ${m}`); }
function err(m)  { console.log(`  ${color('red', '[XX]')} ${m}`); }
function log(msg) { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`); } catch {} }
log('=== install start ===');

// 独立生成隧道脚本入口（无需完整安装/交互）：node install-pi-web.mjs --gen-tunnel <sshHost> <port>
// 按平台生成：Windows→tunnel-keepalive.ps1（含 BOM），macOS/Linux→tunnel-keepalive.sh
const genT = process.argv.indexOf('--gen-tunnel');
if (genT >= 0) {
  // 端口一人一个（VPS 管理员分配），不提供默认值——17001 是他人端口，误用会与其隧道互相踢线
  const sshHost = process.argv[genT + 1];
  const port = process.argv[genT + 2];
  if (!sshHost || !/^\d+$/.test(port ?? '')) {
    err('用法：node install-pi-web.mjs --gen-tunnel <sshHost> <port>（端口为 VPS 管理员分配的专属端口，必填）');
    process.exit(1);
  }
  const out = isWin
    ? path.join(confDir, 'tunnel-keepalive.ps1')
    : path.join(confDir, 'tunnel-keepalive.sh');
  const content = isWin ? '\uFEFF' + renderTunnelPs1(sshHost, port) : renderTunnelSh(sshHost, port);
  fs.writeFileSync(out, content, { mode: 0o755 });
  ok(`已生成隧道脚本：${out}`);
  console.log(out);
  process.exit(0);
}

// ---------- 交互 ----------
// 单一直读 readline：持续监听 line 事件，用队列分发给等待者。
// 管道输入与真实终端均可靠（不依赖 pause/resume）。进程退出时由 stdin 自然关闭。
let _rl = null;
let _pending = [];
let _buffer = [];   // 队列：管道输入时多行答案一次性到达，单槽会互相覆盖丢答案
let _stdinClosed = false;
function ensureRL() {
  if (_rl) return;
  _rl = createInterface({ input: process.stdin, output: process.stdout });
  _rl.on('line', (line) => {
    if (_pending.length) { _pending.shift()(line); }
    else { _buffer.push(line); }
  });
  // stdin 关闭（管道 EOF / 用户 Ctrl+D）：未应答者用空串兜底（ask 会回落到默认值）；
  // 之后的新提问也须立即回空串，否则 Promise 永不 resolve（top-level await 挂起，进程 exit 13）
  _rl.on('close', () => {
    _stdinClosed = true;
    while (_pending.length) _pending.shift()('');
  });
  process.stdin.on('end', () => {
    if (_rl) _rl.close();
  });
}
function readLine() {
  ensureRL();
  return new Promise((resolve) => {
    if (_buffer.length) { resolve(_buffer.shift()); }
    else if (_stdinClosed) { resolve(''); }
    else _pending.push(resolve);
  });
}
function ask(question, { default: def } = {}) {
  return new Promise((resolve) => {
    const suffix = def !== undefined ? ` [${def}]` : '';
    process.stdout.write(`  ${question}${suffix}: `);
    readLine().then((ans) => {
      const a = ans.trim();
      resolve(a === '' && def !== undefined ? String(def) : a);
    });
  });
}
async function confirm(question) {
  const a = await ask(`${question} [Y/n]`);
  return !/^[nN]/.test(a);
}

// ---------- 执行命令 ----------
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.silent ? 'ignore' : 'inherit', shell: opts.shell ?? isWin, ...opts });
  return r.status ?? 1;
}
function runOut(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: opts.shell ?? isWin });
  return (r.stdout || '').trim();
}
// 带退出码/stderr 的执行：注册类命令必须校验结果（schtasks /create 静默失败实锤过）
function runRes(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: opts.shell ?? isWin });
  return { status: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// ---------- 1. 前置检查 ----------
step('1/5 前置检查');
const nodeVer = runOut('node', ['--version']).replace(/^v/, '');
const nodeMajor = Number(nodeVer.split('.')[0]);
if (!nodeVer || nodeMajor < 22) {
  err(`未检测到 Node.js ≥ 22（当前: ${nodeVer || '无'}）。请先安装 Node.js LTS：https://nodejs.org`);
  process.exit(1);
}
ok(`Node.js ${nodeVer}（${process.platform}）`);

const agentModels = path.join(home, '.pi', 'agent', 'models.json');
const hasModels = fs.existsSync(agentModels);
const hasAnthropic = !!(process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_KEY);
if (!hasModels && !hasAnthropic) {
  warn(`未检测到 pi agent 模型配置（${agentModels} 或 ANTHROPIC_* 环境变量）。`);
  warn('qika 需要 pi agent 有可用模型才能对话；若还没配，可稍后配置。');
}

// ---------- 2. 安装 / 确认 qika ----------
step('2/5 确认 qika 安装');
const distUrl = 'git+https://github.com/jkboy/qika-dist.git';
// 版本检测：读全局包的 package.json，而非 pi-web --version（后者在实例已运行时被单实例锁拦截返回空）
function globalPkg() {
  try {
    const g = runOut('npm', ['root', '-g']);
    if (!g) return null;
    return JSON.parse(fs.readFileSync(path.join(g, 'pi-web', 'package.json'), 'utf8'));
  } catch { return null; }
}
let ver = globalPkg()?.version || '';
if (await confirm('确认 qika 已安装？')) {
  if (/^[0-9]/.test(ver)) { ok(`qika 已安装（v${ver}）`); }
  else {
    warn('未检测到 qika，或版本过旧。开始安装...');
    run('npm', ['install', '-g', distUrl]);
    ver = globalPkg()?.version || '';
    if (/^[0-9]/.test(ver)) { ok(`已安装 qika（v${ver}）`); }
    else { err(`安装后仍找不到 qika。可能需新开终端后重跑。`); process.exit(1); }
  }
} else {
  err('跳过安装。请自行安装后再运行。');
  process.exit(0);
}
log(`qika v${ver}`);

// 安装时步骤钩子（host 注册 + 扩展提示，随包分发、幂等、失败不阻断）。
// 已装未装都跑：钩子幂等，保证存量安装也补上 host 注册。
const postInstallHook = path.join(runOut('npm', ['root', '-g']), 'pi-web', 'post-install.mjs');
if (fs.existsSync(postInstallHook)) {
  const hr = spawnSync(process.execPath, [postInstallHook], { stdio: 'inherit' });
  if ((hr.status ?? 1) !== 0) warn('post-install 钩子报告了失败（不影响安装，详见上方输出）');
}

// ---------- 3. 运行方式 ----------
step('3/5 运行方式');
let mode = 'local';
if (process.argv.includes('--local')) mode = 'local';
else if (process.argv.includes('--remote')) mode = 'remote';
else {
  // 已配过远程隧道的机器重跑安装器：默认给 R——远程侧修复要靠重跑安装器刷新守护脚本，
  // 习惯性回车若落到 L 会静默跳过隧道刷新，用户误以为已更新（同事机器实锤过）
  const hadRemote = fs.existsSync(path.join(confDir, 'tunnel-keepalive.ps1'))
    || fs.existsSync(path.join(confDir, 'tunnel-keepalive.sh'));
  console.log('请选择运行方式：');
  console.log('  [L] 仅本机使用（http://localhost:7318）—— 最简单');
  console.log('  [R] 需要远程访问（手机/笔记本通过域名访问，配置 SSH 隧道）');
  if (hadRemote) warn('检测到本机已有远程隧道配置：回车默认 R，将重新生成守护脚本并刷新常驻任务');
  const ans = await ask('选择 [L/R]', { default: hadRemote ? 'R' : 'L' });
  mode = /^[rR]/.test(ans) ? 'remote' : 'local';
}
log(`mode=${mode}`);

// ---------- 环境变量持久化（跨平台） ----------
function envFile() {
  // 选择 macOS/Linux 的 shell 配置文件
  const shell = process.env.SHELL || '';
  if (isMac || isLinux) {
    if (shell.includes('zsh')) return path.join(home, '.zshrc');
    if (shell.includes('bash')) return path.join(home, '.bashrc');
    return path.join(home, '.zshrc');
  }
  return null;
}
function setEnvUser(name, value) {
  if (isWin) {
    // Windows：写用户级注册表（新终端生效）+ 当前进程同步
    // shell:false —— 避免 cmd 拼接吃双引号（spawnSync shell:true 会丢 "，导致 PS 语法错）
    runOut('powershell', ['-NoProfile', '-Command',
      `[Environment]::SetEnvironmentVariable("${name}", "${value}", "User")`], { shell: false });
    process.env[name] = value;
  } else {
    // macOS/Linux：写 shell profile + 当前进程
    const f = envFile();
    const esc = value.replace(/"/g, '\\"');
    if (f) {
      let content = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
      const line = `export ${name}="${esc}"`;
      if (content.includes(`export ${name}=`)) {
        content = content.replace(new RegExp(`export\\s+${name}=.*`), line);
      } else {
        content += `\n# pi-web\n${line}\n`;
      }
      fs.writeFileSync(f, content);
      ok(`已写入 ${f}`);
    }
    process.env[name] = value;
  }
}

// ---------- 4. 配置 ----------
step('4/5 配置环境');
const hasToken = !!(await readEnvUser('PI_WEB_ACCESS_TOKEN'));
let token = '';
if (hasToken) {
  token = await readEnvUser('PI_WEB_ACCESS_TOKEN');
  ok('已存在 PI_WEB_ACCESS_TOKEN（保留）');
} else {
  const defToken = crypto.randomBytes(24).toString('hex');
  const custom = await ask('输入自定义访问 token，或回车用随机生成', { default: defToken });
  token = custom || defToken;
  setEnvUser('PI_WEB_ACCESS_TOKEN', token);
  ok(`已设置访问 token（请妥善保管）：${color('bold', token)}`);
}

let remoteHost = '';
if (mode === 'remote') {
  step('-- 远程访问配置 --');
  const hosts = await readEnvUser('PI_WEB_ALLOWED_HOSTS');
  if (hosts) {
    ok(`PI_WEB_ALLOWED_HOSTS 已存在：${hosts}`);
  } else {
    const sub = await ask('你的远程子域（如 jk.pi.example.com）');
    if (!sub) { err('子域必填'); process.exit(1); }
    setEnvUser('PI_WEB_ALLOWED_HOSTS', sub);
    remoteHost = sub;
  }
  remoteHost = remoteHost || hosts;

  // 重跑安装器时从既有守护脚本回读上次的 host/port 作默认值（幂等重跑免重记参数）
  const prev = parseExistingTunnel();
  const sshHost = await ask('SSH 免密 Host 名（~/.ssh/config 里的 Host，如 pi-vps）', prev.host ? { default: prev.host } : {});
  if (!sshHost) { err('SSH Host 必填（远程隧道靠它）'); process.exit(1); }
  // 端口一人一个（VPS 管理员分配），不提供固定默认值——17001 是他人端口，误用会与其隧道互相踢线
  const port = await ask('隧道端口（VPS 管理员分配的专属端口，每人一个）', prev.port ? { default: prev.port } : {});
  if (!/^\d+$/.test(port)) { err('隧道端口必填且须为数字（向 VPS 管理员索取你的专属端口，不要填别人的）'); process.exit(1); }

  // 生成各平台隧道守护脚本：Windows 用 .ps1（带 BOM，PowerShell 5.1 中文兼容），macOS/Linux 用 .sh
  let tunnelScript;
  if (isWin) {
    tunnelScript = path.join(confDir, 'tunnel-keepalive.ps1');
    fs.writeFileSync(tunnelScript, '\uFEFF' + renderTunnelPs1(sshHost, port));
  } else {
    tunnelScript = path.join(confDir, 'tunnel-keepalive.sh');
    fs.writeFileSync(tunnelScript, renderTunnelSh(sshHost, port), { mode: 0o755 });
  }
  ok(`隧道守护脚本已生成：${tunnelScript}`);

  // 注册平台常驻
  registerTunnel(tunnelScript, sshHost, port);
} else {
  ok('本地模式：无需隧道。');
}

// ---------- 5. 启动 ----------
step('5/5 启动 qika');
if (process.argv.includes('--no-start')) {
  ok('已配置完成（--no-start）。启动：qika');
  process.exit(0);
}
stopExistingPiWeb();
ok(`启动 qika（http://localhost:7318）...`);
const outLog = path.join(confDir, 'pi-web.log');
// 直接用 node 拉 bin/pi-web.js,不走 cmd shim:Windows 上 detached 的 cmd 无控制台,
// 其子进程 node 会被分配可见的新控制台窗口(关窗即杀服务);node 直接 detached 则无窗口
const binJs = path.join(runOut('npm', ['root', '-g']), 'pi-web', 'bin', 'pi-web.js');
const child = spawn(process.execPath, [binJs], {
  stdio: ['ignore', fs.openSync(outLog, 'a'), fs.openSync(outLog, 'a')],
  detached: true, windowsHide: true,
});
child.unref();

// 验证
const health = await waitHealth('http://127.0.0.1:7318/api/meta/health', 6, 3000);
if (health) {
  ok('qika 已启动：http://localhost:7318');
  console.log('\n完成！');
  console.log(`  - 本机浏览器打开 http://localhost:7318，输入访问 token 登录`);
  if (mode === 'remote') {
    const hosts = await readEnvUser('PI_WEB_ALLOWED_HOSTS');
    console.log(`  - 手机/笔记本打开 https://${hosts}，输入同一 token 登录`);
  }
  console.log(`  - 访问 token 存于环境变量 PI_WEB_ACCESS_TOKEN（请牢记，或见日志 ${logFile}）`);
} else {
  warn(`未能确认 qika 启动，查看日志：${outLog}`);
  warn('可能需从新终端手动启动：qika');
}

// ============================================================
// 辅助函数
// ============================================================
async function readEnvUser(name) {
  if (isWin) {
    // shell:false 避免双引号被 cmd 吃掉
    return runOut('powershell', ['-NoProfile', '-Command',
      `[Environment]::GetEnvironmentVariable("${name}","User")`], { shell: false });
  }
  const f = envFile();
  if (f && fs.existsSync(f)) {
    const m = fs.readFileSync(f, 'utf8').match(new RegExp(`export\\s+${name}=["']?([^"'\\n]*)["']?`));
    if (m) return m[1];
  }
  return process.env[name] || '';
}
function stopExistingPiWeb() {
  if (isWin) {
    const out = runOut('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ? { $_.CommandLine -match \'pi-web\' } | % { $_.ProcessId }']);
    for (const pid of out.split(/\s+/).filter(Boolean)) { runOut('taskkill', ['/PID', pid, '/F']); }
  } else {
    runOut('pkill', ['-f', 'pi-web']);
  }
}
function waitHealth(url, tries, interval) {
  return new Promise((resolve) => {
    let n = 0;
    const t = setInterval(async () => {
      n++;
      try {
        const r = await fetch(url);
        if (r.ok) { clearInterval(t); resolve(true); return; }
      } catch {}
      if (n >= tries) { clearInterval(t); resolve(false); }
    }, interval);
  });
}
function parseExistingTunnel() {
  // 重跑安装器：从既有守护脚本回读上次的 host/port 作交互默认值（与生成模板的赋值行一一对应）
  for (const f of ['tunnel-keepalive.ps1', 'tunnel-keepalive.sh']) {
    try {
      const t = fs.readFileSync(path.join(confDir, f), 'utf8');
      const host = (t.match(/\$SshHost = "([^"]+)"/) || t.match(/^SSH_HOST="([^"]+)"/m))?.[1];
      const port = (t.match(/\$RemotePort = "([^"]+)"/) || t.match(/^REMOTE_PORT="([^"]+)"/m))?.[1];
      if (host || port) return { host, port };
    } catch {}
  }
  return {};
}
function renderTunnelSh(sshHost, port) {
  return `#!/usr/bin/env bash
# pi-web SSH 隧道守护（由 install-pi-web.mjs 生成，跨平台）
# 掉线重连；识别「远端端口被僵尸会话占用」时主动上 VPS 清理（否则要等内核 TCP 重传超时，可达 10 分钟+）
set -u
SSH_EXE="\${SSH_EXE:-ssh}"
SSH_HOST="${sshHost}"
REMOTE_PORT="${port}"
LOCAL_TARGET="\${LOCAL_TARGET:-127.0.0.1:7318}"
LOCAL_PORT="\${LOCAL_PORT:-7318}"
LOG_FILE="\${LOG_FILE:-$(dirname "$0")/ssh-tunnel.log}"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "$LOG_FILE"; }
local_up() { (echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null && return 0; return 1; }
# 只杀监听 REMOTE_PORT 的会话子进程，不碰 sshd 主进程（端口必须一人一个，误共用会互相踢）
clear_remote_port() {
  r=$("$SSH_EXE" -o ConnectTimeout=10 -o BatchMode=yes "$SSH_HOST" \\
    'p=$(ss -tlnp "sport = :'"$REMOTE_PORT"'" | grep -oE "pid=[0-9]+" | head -n1 | cut -d= -f2); if [ -n "$p" ]; then kill "$p" && echo "killed:$p"; else echo "no-holder"; fi' 2>&1)
  log "远端端口清理：$r"
}
backoff=5
log "SSH 隧道守护启动：$SSH_HOST  $REMOTE_PORT -> $LOCAL_TARGET"
while true; do
  if ! local_up; then log "本机 $LOCAL_PORT 未监听，等待 10s ..."; sleep 10; continue; fi
  log "启动隧道（backoff=\${backoff}s）..."
  started=$(date +%s)
  out=$("$SSH_EXE" -N -R "127.0.0.1:\${REMOTE_PORT}:\${LOCAL_TARGET}" \\
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \\
    -o ExitOnForwardFailure=yes -o ConnectTimeout=20 -o BatchMode=yes "$SSH_HOST" 2>&1)
  code=$?
  lived=$(( $(date +%s) - started ))
  log "ssh 退出（code $code，存活 \${lived}s）：$(printf '%s\\n' "$out" | tail -n 3 | tr '\\n' ' ')"
  [ "$lived" -gt 60 ] && backoff=5   # 稳定会话后的掉线：快速重连，不背历史退避
  if printf '%s' "$out" | grep -qE 'remote port forwarding failed|Address already in use'; then
    clear_remote_port
    sleep 5
  else
    sleep "$backoff"
    backoff=$((backoff * 2 > 120 ? 120 : backoff * 2))
  fi
done
`;
}
function renderTunnelPs1(sshHost, port) {
  // Windows PowerShell 隧道守护（带 BOM 由调用方加）；前台阻塞版，掉线重连 + 僵尸端口主动清理
  return `# SSH 反向隧道常驻守护（由 install-pi-web.mjs 生成，Windows）
# 掉线重连；识别「远端端口被僵尸会话占用」时主动上 VPS 清理（否则要等内核 TCP 重传超时，可达 10 分钟+）
$ErrorActionPreference = "Continue"
$SshExe = "C:\\Windows\\System32\\OpenSSH\\ssh.exe"
if (-not (Test-Path $SshExe)) { $SshExe = "ssh" }
$SshHost = "${sshHost}"
$RemotePort = "${port}"
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
  Log "启动隧道（backoff=\${backoff}s）..."
  $started = Get-Date
  $out = New-Object System.Collections.Generic.List[string]
  try {
    & $SshExe -N -R "127.0.0.1:\${RemotePort}:\${LocalTarget}" \`
      -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \`
      -o ExitOnForwardFailure=yes -o ConnectTimeout=20 -o BatchMode=yes $SshHost 2>&1 |
      ForEach-Object { $out.Add("$_") }
    $code = $LASTEXITCODE
  } catch {
    $code = -1
    $out.Add("$_")
  }
  $lived = [int]((Get-Date) - $started).TotalSeconds
  $outText = $out -join "\`n"
  Log "ssh 退出（code $code，存活 \${lived}s）：$(($out | Select-Object -Last 3) -join ' | ')"
  if ($lived -gt 60) { $backoff = 5 }   # 稳定会话后的掉线：快速重连，不背历史退避
  if ($outText -match 'remote port forwarding failed|Address already in use') {
    ClearRemotePort
    Start-Sleep -Seconds 5
  } else {
    Start-Sleep -Seconds $backoff
    $backoff = [Math]::Min($backoff * 2, 120)
  }
}
`;
}
function registerTunnel(tunnelScript, sshHost, port) {
  // PI_WEB_DRY_REGISTER=1：仅打印要执行的命令，不真正注册/启动（便于预览与测试）
  if (process.env.PI_WEB_DRY_REGISTER === '1') {
    ok(`[dry-run] 将注册隧道常驻（脚本 ${tunnelScript}，host ${sshHost}，port ${port}）`);
    return;
  }
  if (isWin) {
    const taskName = 'pi-web-ssh-tunnel';
    log(`注册计划任务 ${taskName}`);
    // 不用 schtasks /tr：CLI 传参会 mangle 内层引号（实测生成 `-File " C:\...\` 的坏动作，
    // 任务注册成功但从未跑起来过），且 CLI 建的任务默认带 72h 执行上限 + 电池策略限制。
    // 改用 XML 注册：引号无歧义，并显式设 ExecutionTimeLimit=PT0S（守护进程不限时）。
    const psArgs = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${tunnelScript}"`;
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>10</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>powershell.exe</Command><Arguments>${esc(psArgs)}</Arguments></Exec>
  </Actions>
</Task>`;
    const xmlPath = path.join(confDir, 'pi-web-ssh-tunnel.task.xml');
    fs.writeFileSync(xmlPath, '\uFEFF' + taskXml, 'utf16le');
    // /create 可能静默失败（同事机器实锤：报「已注册」实则没建成，机器重启后隧道不自启断远程）
    // ——必须校验退出码，并用 /query 独立确认任务真实存在
    const created = runRes('schtasks', ['/create', '/tn', taskName, '/xml', xmlPath, '/f']);
    if (created.status !== 0) {
      err(`计划任务注册失败（exit ${created.status}）：${created.stderr || created.stdout || '无输出'}`);
      err('重启后隧道将不会自动拉起。请用管理员 PowerShell 手动执行下面命令后重跑安装器：');
      err(`  schtasks /create /tn ${taskName} /xml "${xmlPath}" /f`);
      process.exit(1);
    }
    const queried = runRes('schtasks', ['/query', '/tn', taskName]);
    if (queried.status !== 0) {
      err(`计划任务注册后查询不到（${queried.stderr || queried.stdout || '无输出'}），请以管理员身份重跑安装器`);
      process.exit(1);
    }
    const ran = runRes('schtasks', ['/run', '/tn', taskName]);
    if (ran.status !== 0) {
      warn(`任务已注册但立即启动失败（${ran.stderr || ran.stdout || '无输出'}）；重启会自动拉起，或手动执行：schtasks /run /tn ${taskName}`);
    }
    ok(`隧道常驻已注册${ran.status === 0 ? '并启动' : ''}（计划任务 ${taskName}，XML：${xmlPath}）`);
  } else if (isMac) {
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.pi-web.tunnel.plist');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.pi-web.tunnel</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>${tunnelScript}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${confDir}/tunnel-launchd.log</string>
  <key>StandardErrorPath</key><string>${confDir}/tunnel-launchd.err</string>
</dict></plist>`;
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
    runOut('launchctl', ['unload', plistPath]);
    runOut('launchctl', ['load', plistPath]);
    ok(`隧道常驻已注册（launchd ${plistPath}）`);
  } else if (isLinux) {
    const svcPath = path.join(home, '.config', 'systemd', 'user', 'pi-web-tunnel.service');
    const svc = `[Unit]
Description=pi-web SSH reverse tunnel
After=network-online.target

[Service]
ExecStart=/bin/bash ${tunnelScript}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
    fs.mkdirSync(path.dirname(svcPath), { recursive: true });
    fs.writeFileSync(svcPath, svc);
    runOut('systemctl', ['--user', 'daemon-reload']);
    runOut('systemctl', ['--user', 'enable', 'pi-web-tunnel.service']);
    runOut('systemctl', ['--user', 'start', 'pi-web-tunnel.service']);
    ok(`隧道常驻已注册（systemd --user ${svcPath}）`);
  }
}
