// ============================================================
// QikaCode —— 浏览器编排器（"接管策略"）
//
// 接管浏览器的核心决策（两种情形）：
//   1. 目标浏览器【未运行】→ 由控制器直接拉起一个新浏览器窗口
//   2. 目标浏览器【已运行】→ 不另开窗口，而是在现有浏览器里开一个新标签页
//
// 本模块封装这套决策，供 CLI / bridge 调用。它只关心"开没开浏览器"，
// 以及"开新标签页还是拉新窗口"这两个编排问题；真正驱动页面仍交给扩展。
//
// 用法：
//   const orch = require("./browser-orchestrator");
//   await orch.open("https://example.com");   // 自动按情形 1/2 处理
// ============================================================

const { execSync, spawn } = require("child_process");
const net = require("net");
const fs = require("fs");
const path = require("path");

// ---- 配置（全部可用环境变量覆盖；路径默认自动推导，便于换机器） ----

// 扩展目录：默认取本仓库的 extension/（用 __dirname 向上定位，不写死绝对路径）
const EXTENSION_PATH =
  process.env.EXT_PATH || path.join(__dirname, "..", "extension");

// 受控浏览器 profile：默认放系统临时目录下，避免污染用户真实配置
const PROFILE_DIR =
  process.env.PROFILE_DIR ||
  (process.env.LOCALAPPDATA || process.env.TEMP) + "/browser-ctl-profile";

// 浏览器可执行文件：优先环境变量，否则在常见安装路径里探测
const BRAVE_EXE = process.env.BRAVE_EXE || detectBrowserExe();

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 9204); // CLI/bridge 端口

// 常见 Brave / Chrome 安装路径，逐个探测存在的那个
function detectBrowserExe() {
  const candidates = [
    process.env.ProgramFiles + "/BraveSoftware/Brave-Browser/Application/brave.exe",
    process.env["ProgramFiles(x86)"] + "/BraveSoftware/Brave-Browser/Application/brave.exe",
    process.env.LOCALAPPDATA + "/BraveSoftware/Brave-Browser/Application/brave.exe",
    process.env.ProgramFiles + "/Google/Chrome/Application/chrome.exe",
    process.env["ProgramFiles(x86)"] + "/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
  ].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error("找不到浏览器可执行文件，请设置环境变量 BRAVE_EXE");
  return hit;
}

// 受控浏览器进程标记（用于 isBrowserRunning 区分"我们拉起的" vs "用户真实的"）
const CTL_FLAG = "browser-ctl-profile";

// ---- 1. 检测目标浏览器进程是否在运行 ---------------------------
// 通过 wmic 查浏览器进程的命令行。这里区分两种语义：
//   - 若查的是【我们的受控 profile】（带 browser-ctl-profile），则能明确判断
//     我们拉起的那台浏览器是否还活着，用于演示「情形1 拉起 / 情形2 开标签」；
//   - 若只看进程名，则任何同款浏览器在跑都算已运行（更贴近真实场景）。
function isBrowserRunning({ checkProfile = true } = {}) {
  try {
    const exe = path.basename(BRAVE_EXE, ".exe");
    const out = execSync(
      `wmic process where "name='${exe}.exe'" get commandline /format:list`,
      { encoding: "utf8", windowsHide: true }
    );
    const lines = out.split(/\r?\n/).filter((l) => new RegExp(exe + "\\.exe", "i").test(l));
    if (lines.length === 0) return false;
    if (!checkProfile) return true;
    // 默认：只看带我们受控 profile 的实例
    return lines.some((l) => l.includes(CTL_FLAG));
  } catch {
    return false;
  }
}

// ---- 2. 情形1：浏览器未运行 → 拉起新窗口（带扩展） -------------
function launchBrave(url) {
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    `--load-extension=${EXTENSION_PATH}`,
    "--no-first-run",
    `--disable-extensions-except=${EXTENSION_PATH}`,
    url || "about:blank",
  ];
  // 直接 spawn 浏览器可执行文件（detached），比套 cmd start 更稳
  const child = spawn(BRAVE_EXE, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  console.error(`[orchestrator] 情形1：浏览器未运行，已拉起新窗口 → ${url}`);
}

// ---- 3. 情形2：浏览器已运行 → 通过扩展在现有浏览器开新标签页 ----
// 需要 bridge/host/扩展链路已就绪；若链路没起，返回错误。
function openTabViaExtension(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: BRIDGE_PORT }, () => {
      sock.write(JSON.stringify({ cmd: "newTab", url, id: 1 }) + "\n");
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("通过扩展开标签页超时（确认 bridge 与扩展已连接）"));
    }, timeoutMs);
    sock.on("data", (d) => {
      clearTimeout(timer);
      const line = d.toString("utf8").trim();
      sock.end();
      try {
        const msg = JSON.parse(line);
        msg.ok ? resolve(msg.result) : reject(new Error(msg.error));
      } catch (e) {
        reject(e);
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error("连接 bridge 失败: " + e.message));
    });
  });
}

// ---- 统一的入口：open(url) ------------------------------------
async function open(url) {
  if (isBrowserRunning()) {
    console.error("[orchestrator] 情形2：浏览器已在运行 → 在现有窗口开新标签页");
    return openTabViaExtension(url);
  } else {
    console.error("[orchestrator] 情形1：浏览器未运行 → 拉起新窗口");
    launchBrave(url);
    return { launched: true, url };
  }
}

module.exports = { isBrowserRunning, launchBrave, openTabViaExtension, open, config: { BRAVE_EXE, EXTENSION_PATH, PROFILE_DIR, BRIDGE_PORT } };

// 直接运行：node browser-orchestrator.js <url>
if (require.main === module) {
  const url = process.argv[2] || "https://example.com";
  open(url)
    .then(() => process.exit(0))
    .catch((e) => { console.error("[orchestrator] 失败:", e.message); process.exit(1); });
}
