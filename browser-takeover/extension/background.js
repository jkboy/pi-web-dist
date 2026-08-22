// ============================================================
// QikaCode —— 扩展后台 Service Worker（codex 化版）
//
// 角色：浏览器侧的「执行器」。
// 架构：
//
//   Agent CLI (drive.js)
//        │  JSON 命令
//        ▼
//   Native Host (host.js，本地进程)
//        │  4字节长度前缀 JSON（Native Messaging 线协议）
//        ▼
//   本扩展 (background.js)  ←→  chrome.debugger (CDP)  ←→  目标页面
//
// 命令集（面向 AI 浏览器 agent，接近 codex 的操作能力）：
//   快照/观察：snapshot / getText / queryAll / pageInfo
//   导航：navigate / newTab / closeTab / listTabs / active
//   受信任操作：click / hover / fill / type / pressKey / scroll
//   条件等待：waitFor（selector / 自定义 JS 条件）
//   截图：screenshot（视口 / 全页 / 元素级）
//   底层：evaluate（任意 JS）
//
// 关键改进（相比教学版）：
//   1. snapshot 输出 AI 可读的「可交互元素清单」+ 稳定 CSS 选择器 + e0/e1 编号，
//      模型据此决定操作目标。
//   2. click/hover 走 CDP Input.dispatchMouseEvent（真实坐标、受信任事件），
//      替代合成 MouseEvent（isTrusted=false 的场景会不响应）。
//   3. fill/type 用 CDP Input.insertText（受信任键盘输入），并针对 React 受控
//      组件用 native setter 清值，解决「填了等于没填」的坑。
// ============================================================

const HOST_NAME = "com.example.browser_takeover";

// snapshot 结果缓存：tabId -> { e编号: 对应 css 选择器 }
// 让 agent 能用 snapshot 里的 e0/e1 编号直接操作（codex 式“用编号指元素”）。
const snapshotCache = new Map();

// 把 e编号 解析成真实 css 选择器；非 e编号则原样返回（当作 css 选择器用）。
// tabId 缺省时按“当前活动标签”解析，与操作目标保持一致。
async function resolveSel(tabId, sel) {
  if (typeof sel === "string" && /^e\d+$/.test(sel)) {
    const key = tabId ?? (await mustActiveTabId());
    const map = snapshotCache.get(key);
    if (map && map[sel]) return map[sel];
    throw new Error("快照元素 " + sel + " 不在缓存（请先对该页执行 snapshot）");
  }
  return sel;
}

// ---- 与本地 host 的双向通道 ------------------------------------
let port = null;
let connecting = false;

// 幂等连接：若已连或正在连则跳过。返回是否真正发起了连接。
function connectToHost() {
  if (port || connecting) return false;
  connecting = true;
  try {
    const p = chrome.runtime.connectNative(HOST_NAME);
    port = p;
    connecting = false;
    console.log("[browser-ctl] 已连接 Native Host:", HOST_NAME);

    p.onMessage.addListener(async (msg) => {
      console.log("[browser-ctl] 收到命令:", msg);
      // msg: { id, cmd, ...args }
      try {
        const result = await handleCommand(msg);
        // 把结果回传给 host
        if (port === p) p.postMessage({ id: msg.id, ok: true, result });
      } catch (err) {
        if (port === p) p.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });
      }
    });

    p.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      console.log("[browser-ctl] Native Host 断开:", err && err.message);
      if (port === p) port = null;
      // 断线重连：MV3 SW 可能休眠导致 setTimeout 不触发，所以这里同时触发一次
      // （若 SW 即将休眠，alarms 保活会在下次唤醒时兜底重连）。
      setTimeout(() => { if (!port) connectToHost(); }, 500);
    });
  } catch (e) {
    connecting = false;
    console.error("[browser-ctl] connectNative 失败:", e);
  }
  return true;
}

// ---- MV3 SW 保活：SW 会休眠导致长连接断开，用 alarms 周期性唤醒并重连 ----
// 浏览器启动 / 扩展安装 / 定时闹钟 都会唤醒 SW 并确保 host 连接存活。
const KEEPALIVE_NAME = "browser-ctl-keepalive";

function ensureConnected() {
  // 已连接且 port 有效则无需重建
  if (port) return;
  connectToHost();
}

function setupKeepalive() {
  // 扩展安装/更新时触发一次连接（onInstalled 是 SW 的稳定唤醒源）
  chrome.runtime.onInstalled.addListener(() => ensureConnected());
  // 浏览器启动时连接（onStartup 也是稳定唤醒源）
  chrome.runtime.onStartup.addListener(() => ensureConnected());
  // 点击扩展图标：手动触发连接（排障/使用入口）
  chrome.action.onClicked.addListener((tab) => {
    ensureConnected();
    chrome.tabs.sendMessage(tab.id, { browserCtl: "connected", time: Date.now() }).catch(() => {});
  });
  // 周期闹钟保活：Chrome MV3 最小间隔约 30s。
  try {
    chrome.alarms.create(KEEPALIVE_NAME, { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === KEEPALIVE_NAME) ensureConnected();
    });
  } catch (e) {
    console.error("[browser-ctl] alarms 保活不可用:", e);
  }
}

// 启动：先保活机制，再立即连接一次。
setupKeepalive();
ensureConnected();

// content script 唤醒：任何页面加载时触发，确保 host 连接存活。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "browserCtlPing") {
    ensureConnected();
    sendResponse({ connected: !!port, time: Date.now() });
  }
  return false;
});

// ---- 命令分发 --------------------------------------------------
async function handleCommand(msg) {
  switch (msg.cmd) {
    // 观察
    case "snapshot":    return snapshot(msg.tabId);
    case "getText":     return getText(msg.tabId, msg.selector);
    case "queryAll":    return queryAll(msg.tabId, msg.selector, msg.max);
    case "pageInfo":    return pageInfo(msg.tabId);
    // 导航 / 标签
    case "listTabs":    return listTabs();
    case "getActiveTab":return getActiveTab();
    case "navigate":    return navigate(msg.url, msg.tabId);
    case "newTab":      return newTab(msg.url);
    case "closeTab":    return closeTab(msg.tabId);
    // 受信任操作
    case "click":       return click(msg.tabId, msg.selector, msg.options || {});
    case "hover":       return hover(msg.tabId, msg.selector);
    case "fill":        return fill(msg.tabId, msg.selector, msg.value);
    case "type":        return type(msg.tabId, msg.selector, msg.value);
    case "pressKey":    return pressKey(msg.tabId, msg.key);
    case "scroll":      return scroll(msg.tabId, msg.options || {});
    // 等待
    case "waitFor":     return waitFor(msg.tabId, msg.options || {});
    // 截图
    case "screenshot":  return screenshot(msg.tabId, msg.options || {});
    // 底层
    case "evaluate":    return evaluate(msg.tabId, msg.expression, { awaitPromise: msg.awaitPromise !== false });
    default:
      throw new Error("未知命令: " + msg.cmd);
  }
}

// ---- 用 chrome.tabs 获取当前打开的标签（接管"现有浏览器"） -------
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? { id: tab.id, title: tab.title, url: tab.url } : null;
}

async function newTab(url) {
  return await chrome.tabs.create({ url });
}

async function closeTab(tabId) {
  if (tabId != null) await chrome.tabs.remove(tabId);
  return true;
}

// ---- 导航：直接用 chrome.tabs.update 改 URL ---------------------
async function navigate(url, tabId) {
  if (!/^(https?|data|file|about):/.test(url)) throw new Error("URL 需以 http(s):// 开头: " + url);
  const target = tabId != null ? { tabId } : {};
  await chrome.tabs.update(target.tabId ?? undefined, { url });
  return { url };
}

// ================================================================
// CDP 基础设施
// ================================================================

// 统一 attach/debugger 作用域：attach 前先清掉可能残留的旧 attachment，
// 避免 "Another debugger is already attached"。返回 isNew 决定是否 detach。
async function attachDebugger(target) {
  try {
    await chrome.debugger.attach(target, "1.3");
    return true;
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg.includes("already attached")) return false;
    throw e;
  }
}

async function mustActiveTabId() {
  const t = await getActiveTab();
  if (!t) throw new Error("没有活动标签页");
  return t.id;
}

// 在 debugger 作用域内执行 fn(target)，结束后按需 detach
async function withDebugger(tabId, fn) {
  const target = { tabId: tabId ?? (await mustActiveTabId()) };
  const isNew = await attachDebugger(target);
  try {
    return await fn(target);
  } finally {
    if (isNew) {
      await chrome.debugger.detach(target).catch(() => {});
    }
  }
}

// 在页面里执行一段 JS 表达式，返回 returnByValue 的 value；
// 若执行抛异常则把异常转为 Error（便于 CLI/agent 看到真实原因）。
async function evaluate(tabId, expression, { awaitPromise = true, timeoutMs = 15000 } = {}) {
  return withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    const res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const msg = d.exception?.description || d.exception?.value || d.text || "执行 JS 出错";
      throw new Error(String(msg).split("\n")[0]);
    }
    return res.result?.value;
  });
}

// 把「纯 DOM 函数 + 参数」序列化到页面执行 —— 比手写模板字符串更清晰。
// fn 必须是自包含的纯函数（不依赖外部闭包），参数以 JSON 传入。
async function inPage(tabId, fn, args) {
  const expression = `((${fn.toString()}))(${JSON.stringify(args)})`;
  return evaluate(tabId, expression);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================================================
// 快照：给 AI 的「页面状态图」（核心差异点）
// ================================================================

// 快照注入函数：必须【完全自包含】——内层 buildSelector/isInteractive 等 helper
// 定义在函数体内，才能被 toString 序列化到页面执行（否则闭包变量在页面里是 undefined）。
const snapshotCode = function snapshotPage() {
    const title = document.title;
    const url = location.href;

    // 生成稳定的 CSS 选择器：id → data-testid → name → nth-of-type 兜底。
    // 返回前用 querySelectorAll 校验唯一性，确保能反查。
    function buildSelector(el) {
      if (!el || el.nodeType !== 1) return "";
      if (el.id && !/^\d/.test(el.id)) {
        const s = "#" + CSS.escape(el.id);
        if (document.querySelectorAll(s).length === 1) return s;
      }
      for (const attr of ["data-testid", "data-test", "data-qa", "data-cy", "data-test-id"]) {
        const v = el.getAttribute(attr);
        if (v) {
          const s = `[${attr}="${CSS.escape(v)}"]`;
          if (document.querySelectorAll(s).length === 1) return s;
        }
      }
      if (el.name && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) {
        const s = `${el.tagName.toLowerCase()}[name="${CSS.escape(String(el.name))}"]`;
        if (document.querySelectorAll(s).length === 1) return s;
      }
      let parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 8) {
        if (cur.id && !/^\d/.test(cur.id)) { parts.unshift("#" + CSS.escape(cur.id)); break; }
        let sel = cur.tagName.toLowerCase();
        const parent = cur.parentElement;
        if (parent) {
          const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
          if (same.length > 1) sel += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
        }
        parts.unshift(sel);
        cur = cur.parentElement;
      }
      return parts.join(" > ");
    }

    function isInteractive(el) {
      const t = el.tagName.toLowerCase();
      if (t === "button" || t === "a" || t === "select" || t === "textarea") return true;
      if (t === "input") return true;
      if (el.isContentEditable) return true;
      const role = el.getAttribute("role");
      if (role) return /button|link|checkbox|radio|tab|menuitem|switch|combobox|option|searchbox|textbox|listbox/.test(role);
      return false;
    }
    function roleOf(el) {
      const t = el.tagName.toLowerCase();
      if (t === "button") return "button";
      if (t === "a") return "link";
      if (t === "input") {
        const ty = (el.type || "text").toLowerCase();
        if (ty === "checkbox") return "checkbox";
        if (ty === "radio") return "radio";
        if (ty === "submit" || ty === "button" || ty === "reset") return "button";
        return "textbox";
      }
      if (t === "select") return "combobox";
      if (t === "textarea") return "textbox";
      if (el.isContentEditable) return "textbox";
      return el.getAttribute("role") || t;
    }
    function nameOf(el) {
      if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
      if (el.title) return el.title;
      if (el.placeholder) return el.placeholder;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
        if (el.id) {
          const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lab) return lab.innerText.trim();
        }
        if (el.closest("label")) return el.closest("label").innerText.trim();
      }
      const txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
      return txt;
    }

    const out = [];
    const seen = new Set();
    const all = document.querySelectorAll("body *");
    for (const el of all) {
      if (seen.has(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue; // 跳过不可见/零尺寸
      if (!isInteractive(el)) continue;
      seen.add(el);
      out.push({
        id: "e" + out.length,
        role: roleOf(el),
        name: nameOf(el),
        tag: el.tagName.toLowerCase(),
        type: el.type ? el.type.toLowerCase() : undefined,
        value: el.value !== undefined ? String(el.value).slice(0, 60) : undefined,
        placeholder: el.placeholder || undefined,
        disabled: !!el.disabled,
        checked: el.checked !== undefined ? !!el.checked : undefined,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        selector: buildSelector(el),
      });
    }
    const bodyText = (document.body ? document.body.innerText : "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .slice(0, 4000);
    return { title, url, elementCount: out.length, elements: out, bodyText };
};

async function snapshot(tabId) {
  const t = tabId ?? (await mustActiveTabId());
  const s = await inPage(t, snapshotCode, {});
  const map = {};
  for (const e of s.elements || []) if (e.id && e.selector) map[e.id] = e.selector;
  snapshotCache.set(t, map);
  return s;
}

// ================================================================
// 受信任操作（CDP Input —— 真实鼠标/键盘事件）
// ================================================================

// 定位元素中心点（先滚动到可视区中央）。返回 {found, x, y, tag, text}
const locateCode = () => function locate(a) {
  const el = document.querySelector(a.selector);
  if (!el) return { found: false };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName, text: (el.innerText || "").slice(0, 60) };
};

async function click(tabId, selector, opts = {}) {
  selector = await resolveSel(tabId, selector);
  if (!selector) throw new Error("click 需要 selector");
  const pt = await inPage(tabId, locateCode(), { selector });
  if (!pt?.found) throw new Error("找不到元素: " + selector);
  const double = !!opts.double;
  return withDebugger(tabId, async (target) => {
    const clickCount = double ? 2 : 1;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount });
    return { x: Math.round(pt.x), y: Math.round(pt.y), tag: pt.tag, text: pt.text, double };
  });
}

async function hover(tabId, selector) {
  selector = await resolveSel(tabId, selector);
  if (!selector) throw new Error("hover 需要 selector");
  const pt = await inPage(tabId, locateCode(), { selector });
  if (!pt?.found) throw new Error("找不到元素: " + selector);
  return withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
    return { x: Math.round(pt.x), y: Math.round(pt.y) };
  });
}

// 聚焦并清空（React 受控组件用 native setter，避免被覆盖）
const focusClearCode = () => function focusClear(a) {
  const el = document.querySelector(a.selector);
  if (!el) return { found: false };
  el.scrollIntoView({ block: "center" });
  el.focus();
  const tag = el.tagName.toLowerCase();
  const type = el.type ? el.type.toLowerCase() : "";
  if (tag === "input" || tag === "textarea") {
    const proto = tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { found: true, tag, type };
};

// fill：清空后用受信任键盘输入输入 value（React 安全）
async function fill(tabId, selector, value) {
  selector = await resolveSel(tabId, selector);
  if (!selector) throw new Error("fill 需要 selector");
  const info = await inPage(tabId, focusClearCode(), { selector });
  if (!info?.found) throw new Error("找不到元素: " + selector);
  if (info.type === "checkbox" || info.type === "radio") throw new Error("checkbox/radio 请用 click");
  if (info.tag === "select") {
    return inPage(tabId, (a) => {
      const el = document.querySelector(a.selector);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(el, a.value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { tag: el.tagName, value: el.value };
    }, { selector, value: String(value) });
  }
  if (info.tag === "input" && info.type === "file") {
    throw new Error("file input 请用 evaluate 注入（原型暂不支持文件上传）");
  }
  await withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.insertText", { text: String(value) });
  });
  return { tag: info.tag, type: info.type, value: String(value) };
}

// type：不清空，直接在当前聚焦处追加输入（受信任键盘）
async function type(tabId, selector, value) {
  selector = await resolveSel(tabId, selector);
  if (!selector) throw new Error("type 需要 selector");
  const info = await inPage(tabId, (a) => {
    const el = document.querySelector(a.selector);
    if (!el) return { found: false };
    el.scrollIntoView({ block: "center" });
    el.focus();
    return { found: true, tag: el.tagName.toLowerCase(), type: el.type ? el.type.toLowerCase() : "" };
  }, { selector });
  if (!info?.found) throw new Error("找不到元素: " + selector);
  if (info.tag === "select") throw new Error("select 请用 fill");
  await withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.insertText", { text: String(value) });
  });
  return { tag: info.tag, value: String(value) };
}

// 按键：特殊键用 CDP Input.dispatchKeyEvent，单字符用 insertText
const SPECIAL_KEYS = {
  enter: { key: "Enter", code: "Enter" }, tab: { key: "Tab", code: "Tab" },
  escape: { key: "Escape", code: "Escape" }, backspace: { key: "Backspace", code: "Backspace" },
  delete: { key: "Delete", code: "Delete" }, arrowup: { key: "ArrowUp", code: "ArrowUp" },
  arrowdown: { key: "ArrowDown", code: "ArrowDown" }, arrowleft: { key: "ArrowLeft", code: "ArrowLeft" },
  arrowright: { key: "ArrowRight", code: "ArrowRight" }, home: { key: "Home", code: "Home" },
  end: { key: "End", code: "End" }, pageup: { key: "PageUp", code: "PageUp" },
  pagedown: { key: "PageDown", code: "PageDown" }, space: { key: " ", code: "Space" },
  f5: { key: "F5", code: "F5" }, f12: { key: "F12", code: "F12" },
};
const VK = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, F5: 116, F12: 123, " ": 32 };

async function pressKey(tabId, key) {
  if (!key) throw new Error("pressKey 需要 key");
  const spec = SPECIAL_KEYS[String(key).toLowerCase()] || SPECIAL_KEYS[String(key)];
  if (spec) {
    await withDebugger(tabId, async (target) => {
      const vk = VK[spec.key] ?? 0;
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyDown", key: spec.key, code: spec.code, windowsVirtualKeyCode: vk });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", key: spec.key, code: spec.code, windowsVirtualKeyCode: vk });
    });
    return { key: spec.key };
  }
  if (String(key).length === 1) {
    await withDebugger(tabId, async (target) => {
      await chrome.debugger.sendCommand(target, "Input.insertText", { text: String(key) });
    });
    return { key: String(key), mode: "char" };
  }
  throw new Error("未知按键: " + key + "（特殊键见 help）");
}

// 滚动：selector 定位元素 / 或方向滚动窗口 / 或 to=top|bottom
async function scroll(tabId, opts = {}) {
  if (opts.selector) opts.selector = await resolveSel(tabId, opts.selector);
  return inPage(tabId, (a) => {
    if (a.selector) {
      const el = document.querySelector(a.selector);
      if (!el) return { ok: false, error: "找不到元素: " + a.selector };
      el.scrollIntoView({ block: a.to === "top" ? "start" : "center", inline: "center" });
      return { ok: true, tag: el.tagName, to: a.to || "center" };
    }
    if (a.to === "top") { window.scrollTo({ top: 0, behavior: "instant" }); return { ok: true, y: window.scrollY }; }
    if (a.to === "bottom") { window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }); return { ok: true, y: window.scrollY }; }
    const amount = (a.direction === "up" ? -1 : 1) * (a.amount || 400);
    window.scrollBy({ top: amount, behavior: "instant" });
    return { ok: true, y: window.scrollY };
  }, { selector: opts.selector, direction: opts.direction, amount: opts.amount, to: opts.to });
}

// ================================================================
// 条件等待
// ================================================================

// waitFor: selector 出现/可见/隐藏/移除，或 fn(自定义 JS 条件，返回真值)
async function waitFor(tabId, opts = {}) {
  const { selector, fn, state = "visible", timeout = 10000 } = opts;
  if (!selector && !fn) throw new Error("waitFor 需要 selector 或 fn");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await inPage(tabId, (a) => {
      if (a.selector) {
        const el = document.querySelector(a.selector);
        if (!el) return a.state === "removed";
        if (a.state === "removed") return false;
        if (a.state === "hidden") {
          const cs = getComputedStyle(el);
          return cs.visibility === "hidden" || cs.display === "none" || el.offsetParent === null;
        }
        return true;
      }
      if (a.fn) { try { return !!eval("(" + a.fn + ")()"); } catch { return false; } }
      return true;
    }, { selector, fn, state });
    if (v) return { waited: Date.now() - start, satisfied: selector || fn };
    await sleep(100);
  }
  throw new Error("waitFor 超时(" + timeout + "ms): " + (selector || fn || "条件"));
}

// ================================================================
// 结构化提取
// ================================================================

async function getText(tabId, selector) {
  selector = await resolveSel(tabId, selector);
  if (!selector) throw new Error("getText 需要 selector");
  const v = await inPage(tabId, (a) => {
    const el = document.querySelector(a.selector);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return {
      found: true,
      text: (el.innerText || el.textContent || "").trim().slice(0, 3000),
      value: el.value !== undefined ? String(el.value).slice(0, 300) : undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }, { selector });
  if (!v?.found) throw new Error("找不到元素: " + selector);
  return v;
}

async function queryAll(tabId, selector, max = 50) {
  if (!selector) throw new Error("queryAll 需要 selector");
  return inPage(tabId, (a) => {
    const els = [...document.querySelectorAll(a.selector)].slice(0, a.max);
    return {
      count: els.length,
      truncated: els.length === a.max && document.querySelectorAll(a.selector).length > a.max,
      items: els.map((el, i) => ({
        index: i,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
        href: el.tagName === "A" ? el.href : undefined,
        value: el.value !== undefined ? String(el.value).slice(0, 80) : undefined,
      })),
    };
  }, { selector, max: Number(max) || 50 });
}

async function pageInfo(tabId) {
  const expression = `({
    title: document.title,
    url: location.href,
    text: (document.body ? document.body.innerText : '').slice(0, 2000),
    links: [...document.querySelectorAll('a')].slice(0,20).map(a=>({t:a.innerText.trim().slice(0,30), href:a.href}))
  })`;
  const r = await evaluate(tabId, expression);
  return r;
}

// ================================================================
// 截图（视口 / 全页 / 元素级）
// ================================================================

async function screenshot(tabId, opts = {}) {
  const { fullPage = false, selector } = opts;
  let clip;
  if (selector) {
    selector = await resolveSel(tabId, selector);
    const r = await inPage(tabId, (a) => {
      const el = document.querySelector(a.selector);
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    }, { selector });
    if (!r) throw new Error("找不到元素: " + selector);
    clip = r;
  }
  return withDebugger(tabId, async (target) => {
    const params = { format: "png", captureBeyondViewport: !!fullPage, fromSurface: true };
    if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 };
    const res = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", params);
    return { dataUrl: "data:image/png;base64," + res.data };
  });
}
