// ============================================================
// QikaCode —— 教师 CLI（驾驶员）
//
// 连接 Bridge 的 TCP 控制端口，交互式下发命令驱动浏览器。
// 输入命令 → 经 bridge/host → 扩展 → CDP 操作页面 → 结果回传并打印。
//
// 用法：
//   node cli/drive.js
// 然后输入命令，例如：
//   listTabs
//   navigate https://example.com
//   pageInfo
//   fill  input[name=q]  hello
//   click button
//   screenshot            (保存到 screenshots/ 目录)
//   help / exit
// ============================================================

const net = require("net");
const fs = require("fs");
const path = require("path");

const CONTROL_HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const CONTROL_PORT = Number(process.env.BRIDGE_PORT || 9204);

const SCREENSHOT_DIR = path.join(__dirname, "..", "screenshots");
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const readline = require("readline").createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "ctl> ",
});

let sock;
let idCounter = 0;
const pending = new Map();
const history = [];

function connect() {
  sock = net.createConnection({ host: CONTROL_HOST, port: CONTROL_PORT }, () => {
    console.log(`\n已连接 Native Host (${CONTROL_HOST}:${CONTROL_PORT})`);
    console.log("输入 help 查看命令。\n");
    safePrompt();
  });

  let buf = "";
  sock.on("data", (d) => {
    // host 返回的是单条 JSON（可能带换行），按行切割
    buf += d.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handleResponse(line);
    }
  });

  sock.on("close", () => {
    console.error("\n与 Native Host 的连接已断开（请确认扩展已加载、host 已注册、Brave 已重启）");
    process.exit(1);
  });
  sock.on("error", (e) => {
    console.error("连接 Native Host 失败:", e.message);
    console.error("先运行 host.js，并确认扩展已连接。");
    process.exit(1);
  });
}

function handleResponse(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, cmd } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
    printResult(cmd, msg);
  } else if (msg.type === "status") {
    console.log(`[扩展] 已连接: ${msg.extension}`);
  }
  safePrompt();
}

// 交互模式(TTY)才显示提示符；脚本/管道模式 stdin 会关闭，不能调 prompt
let interactive = process.stdin.isTTY;
function safePrompt() {
  try {
    if (interactive && !readline.closed) readline.prompt();
  } catch {}
}

function printResult(cmd, msg) {
  console.log(`\n[命令] ${cmd}\n[结果] ${msg.ok ? "成功" : "失败"}`);
  if (!msg.ok) {
    console.log("  错误:", msg.error);
    return;
  }
  const r = msg.result;
  if (r == null) {
    console.log("  (无返回值)");
    return;
  }
  console.log("  " + JSON.stringify(r, null, 2).replace(/\n/g, "\n  "));
}

function send(cmdObj) {
  return new Promise((resolve, reject) => {
    const id = ++idCounter;
    const cmdName = cmdObj.cmd;
    const full = { ...cmdObj, id };
    pending.set(id, { resolve, cmd: cmdName });
    // 事件驱动：结果回来后由 handleResponse 调用 resolve。
    // 为防止悬挂，超时兜底。
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`命令超时: ${cmdName}`));
      }
    }, 15000);
    sock.write(JSON.stringify(full) + "\n");
  });
}

// ---- 命令解析与执行 ----
const HELP = `
可用命令（对应浏览器接管的操作）：
  导航/标签：
    listTabs                      列出所有已打开的标签页
    active                        当前活动标签页
    navigate <url> [tabId]         导航到 URL
    newTab <url>                  新开标签页
    closeTab <tabId>              关闭标签页
  观察（AI 读取页面）：
    snapshot [tabId]              页面快照：可交互元素清单(role/name/selector/e编号) + 正文
    pageInfo [tabId]              读取当前页标题/URL/正文/链接
    getText <css选择器> [tabId]    读取某元素文本/值
    queryAll <css选择器> [max]     批量取元素文本/链接
  受信任操作（真实鼠标/键盘事件）：
    click <css选择器或e编号> [tabId]       点击元素（受信任）
    hover <css选择器或e编号> [tabId]       悬停元素
    fill <css选择器或e编号> <值> [tabId]   清空后输入（React 安全）
    type <css选择器或e编号> <值> [tabId]   在聚焦处追加输入
    pressKey <Enter/Tab/Esc/ArrowUp...>  按键
    scroll [css选择器] [up/down] [amount] 滚动（或 to=top/bottom）
  等待：
    waitFor <css选择器> [state] [timeout]  等待元素出现/可见/隐藏/移除
    waitFn <JS条件> [timeout]              等待自定义 JS 条件为真
  截图：
    screenshot [tabId]            截图保存到 screenshots/
    shotFull [tabId]              全页截图
    shotEl <css选择器> [tabId]    元素级截图
  底层：
    eval <JS表达式> [tabId]       在页面里执行任意 JS
  其它：
    sleep <毫秒>                 暂停（脚本里用）
    script <脚本文件>            批量执行脚本里的命令
    help / exit
`;

// snapshot 结果打印（精简，元素清单逐行列出）
function printSnapshot(r) {
  if (!r.ok || !r.result) return;
  const s = r.result;
  console.log(`\n[页面] ${s.url}`);
  console.log(`[标题] ${s.title}（可交互元素 ${s.elementCount} 个）`);
  for (const e of s.elements || []) {
    const loc = e.selector || "?";
    const extra = [e.type && `type=${e.type}`, e.value && `value=${JSON.stringify(e.value)}`, e.placeholder && `ph=${JSON.stringify(e.placeholder)}`, e.disabled && "disabled", e.checked && "checked"].filter(Boolean).join(" ");
    console.log(`  ${e.id} [${e.role}] "${e.name}"  ${e.tag} ${extra ? `(${extra}) ` : ""}css=${loc}`);
  }
  if (s.bodyText) {
    console.log(`\n[正文] ${s.bodyText.slice(0, 400)}\n...`);
  }
}

async function runCommand(line) {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  try {
    switch (cmd) {
      case "help": console.log(HELP); break;
      case "exit": sock.end(); process.exit(0); break;

      case "listTabs":
        await send({ cmd: "listTabs" });
        break;
      case "active":
        await send({ cmd: "getActiveTab" });
        break;
      case "navigate": {
        const url = args[0];
        if (!url) return console.log("用法: navigate <url>");
        const tabId = toNum(args[1]);
        await send({ cmd: "navigate", url, ...(tabId ? { tabId } : {}) });
        break;
      }
      case "snapshot": {
        const r = await send({ cmd: "snapshot", ...(toNum(args[0]) ? { tabId: toNum(args[0]) } : {}) });
        printSnapshot(r);
        break;
      }
      case "pageInfo": {
        await send({ cmd: "pageInfo", ...(toNum(args[0]) ? { tabId: toNum(args[0]) } : {}) });
        break;
      }
      case "getText": {
        const sel = args[0];
        if (!sel) return console.log("用法: getText <css选择器>");
        await send({ cmd: "getText", selector: sel, ...(toNum(args[1]) ? { tabId: toNum(args[1]) } : {}) });
        break;
      }
      case "queryAll": {
        const sel = args[0];
        if (!sel) return console.log("用法: queryAll <css选择器> [max]");
        await send({ cmd: "queryAll", selector: sel, ...(toNum(args[1]) ? { max: toNum(args[1]) } : {}) });
        break;
      }
      case "click": {
        const sel = args[0];
        if (!sel) return console.log("用法: click <css选择器或e编号>");
        await send({ cmd: "click", selector: sel, ...(toNum(args[1]) ? { tabId: toNum(args[1]) } : {}) });
        break;
      }
      case "hover": {
        const sel = args[0];
        if (!sel) return console.log("用法: hover <css选择器或e编号>");
        await send({ cmd: "hover", selector: sel, ...(toNum(args[1]) ? { tabId: toNum(args[1]) } : {}) });
        break;
      }
      case "fill": {
        const { sel, val, tabId } = parseSelValTab(args);
        if (!sel || !val) return console.log("用法: fill <css选择器或e编号> <值> [tabId]");
        await send({ cmd: "fill", selector: sel, value: val, ...(tabId ? { tabId } : {}) });
        break;
      }
      case "type": {
        const { sel, val, tabId } = parseSelValTab(args);
        if (!sel || !val) return console.log("用法: type <css选择器或e编号> <值> [tabId]");
        await send({ cmd: "type", selector: sel, value: val, ...(tabId ? { tabId } : {}) });
        break;
      }
      case "pressKey": {
        const k = args[0];
        if (!k) return console.log("用法: pressKey <Enter/Tab/Esc/ArrowUp/...>");
        await send({ cmd: "pressKey", key: k });
        break;
      }
      case "scroll": {
        const opts = {};
        if (args[0] && !["up", "down", "top", "bottom"].includes(args[0])) opts.selector = args[0];
        else if (args[0]) opts.to = args[0];
        if (args[0] === "up" || args[0] === "down") opts.direction = args[0];
        if (toNum(args[1]) && args[0] !== "top" && args[0] !== "bottom") opts.amount = toNum(args[1]);
        await send({ cmd: "scroll", options: opts });
        break;
      }
      case "waitFor": {
        const sel = args[0];
        if (!sel) return console.log("用法: waitFor <css选择器> [state] [timeout]");
        const state = args[1] && ["visible", "hidden", "removed"].includes(args[1]) ? args[1] : "visible";
        const timeout = toNum(args[2]) || toNum(args[1]) || 10000;
        await send({ cmd: "waitFor", options: { selector: sel, state, timeout } });
        break;
      }
      case "waitFn": {
        const fn = args.join(" ");
        if (!fn) return console.log("用法: waitFn <JS条件>");
        await send({ cmd: "waitFor", options: { fn, timeout: 10000 } });
        break;
      }
      case "eval": {
        const expr = args.join(" ");
        if (!expr) return console.log("用法: eval <JS表达式>");
        await send({ cmd: "evaluate", expression: expr });
        break;
      }
      case "screenshot": {
        const r = await send({ cmd: "screenshot", ...(toNum(args[0]) ? { tabId: toNum(args[0]) } : {}) });
        saveScreenshot(r);
        break;
      }
      case "shotFull": {
        const r = await send({ cmd: "screenshot", options: { fullPage: true }, ...(toNum(args[0]) ? { tabId: toNum(args[0]) } : {}) });
        saveScreenshot(r);
        break;
      }
      case "shotEl": {
        const sel = args[0];
        if (!sel) return console.log("用法: shotEl <css选择器>");
        const r = await send({ cmd: "screenshot", options: { selector: sel }, ...(toNum(args[1]) ? { tabId: toNum(args[1]) } : {}) });
        saveScreenshot(r);
        break;
      }
      case "newTab": {
        await send({ cmd: "newTab", url: args[0] });
        break;
      }
      case "sleep": {
        const ms = Number(args[0]) || 500;
        console.log(`  (等待 ${ms}ms)`);
        await new Promise((r) => setTimeout(r, ms));
        break;
      }
      case "closeTab": {
        const tabId = toNum(args[0]);
        if (!tabId) return console.log("用法: closeTab <tabId>");
        await send({ cmd: "closeTab", tabId });
        break;
      }
      case "script": {
        const file = args[0];
        if (!file) return console.log("用法: script <脚本文件>");
        await runScript(file);
        break;
      }
      default:
        console.log("未知命令: " + cmd + "（输入 help 查看）");
    }
  } catch (e) {
    console.log("错误:", e.message);
  }
  safePrompt();
}

function saveScreenshot(r) {
  if (!r.ok || !r.result || !r.result.dataUrl) return;
  const data = r.result.dataUrl.replace(/^data:image\/png;base64,/, "");
  const file = path.join(SCREENSHOT_DIR, `shot_${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  截图已保存: ${file}`);
}

async function runScript(file) {
  if (!fs.existsSync(file)) return console.log("脚本文件不存在: " + file);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const ln of lines) {
    const t = ln.trim();
    if (!t || t.startsWith("#") || t.startsWith("//")) continue;
    console.log(`\n>>> ${t}`);
    await runCommand(t);
  }
}

function toNum(v) {
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// 解析 <sel> <值...> [tabId]：值可能含空格，尾随的纯数字 token（≥4位）视为 tabId。
function parseSelValTab(args) {
  const sel = args[0];
  if (!sel) return { sel: null, val: null, tabId: null };
  let valParts = args.slice(1);
  let tabId = null;
  // 值至少 2 个 token 时，若最后一个 token 是纯数字，视为 tabId
  if (valParts.length >= 2) {
    const last = valParts[valParts.length - 1];
    if (/^\d{4,}$/.test(last)) {
      tabId = Number(last);
      valParts = valParts.slice(0, -1);
    }
  }
  return { sel, val: valParts.join(" "), tabId };
}

readline.on("line", (line) => {
  if (!line.trim()) return safePrompt();
  runCommand(line);
});

// 支持在 CLI 里直接带脚本参数执行：node cli/drive.js demo.txt
if (process.argv[2]) {
  connect();
  readline.once("connect", () => {});
  setTimeout(() => {
    runScript(process.argv[2]);
  }, 800);
} else {
  connect();
}
