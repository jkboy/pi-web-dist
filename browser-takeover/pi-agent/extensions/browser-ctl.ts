/**
 * browser-ctl —— 让 pi agent 能像 codex 一样操作浏览器
 *
 * 能力来源：`~/.pi/tools/browser-takeover/`（Chrome 扩展 + Native Messaging + CDP）。
 * 本 extension 只是把那条链路封装成一个 custom tool，供 LLM 调用：
 *
 *    LLM ── browser_ctl(action=...) ──▶ 本 tool ──TCP──▶ bridge:9204 ──▶ host ──▶ 扩展 ──CDP──▶ 页面
 *
 * 前置：bridge 常驻程序需在跑（`node native-host/bridge.js`），浏览器扩展需已加载。
 * 若 bridge 没起，工具会报"无法连接 bridge"，提示先启动。
 *
 * 用法（快照→选目标→操作→验证 的 codex 式闭环）：
 *   browser_ctl(action=snapshot)            → 拿可交互元素清单(e0/e1编号 + css选择器)
 *   browser_ctl(action=click, selector="e3")
 *   browser_ctl(action=fill, selector="e5", value="hello")
 *   browser_ctl(action=pressKey, key="Enter")
 *   browser_ctl(action=waitFor, selector=".result", options={state:"visible",timeout:8000})
 *   browser_ctl(action=getText, selector="#result")
 *   browser_ctl(action=screenshot)          → 返回图片给模型
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { connect } from "node:net";

const BRIDGE_HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 9204);

const ACTIONS = [
  // 观察
  "snapshot", "getText", "queryAll", "pageInfo", "listTabs", "active",
  // 导航/标签
  "navigate", "newTab", "closeTab",
  // 受信任操作
  "click", "hover", "fill", "type", "pressKey", "scroll",
  // 等待
  "waitFor",
  // 截图
  "screenshot",
  // 底层
  "evaluate",
] as const;

const browserCtlTool = defineTool({
  name: "browser_ctl",
  label: "Browser Control",
  description: "像 codex 一样操作本机浏览器：snapshot 读取页面可交互元素清单(e0/e1编号+css选择器)，然后 click/fill/pressKey/waitFor/screenshot 等受信任事件操作并验证。用于需要驱动真实浏览器(如填表单、点按钮、抓页面数据、截图)的场景。",
  promptSnippet: "操作本机浏览器（snapshot 看页面元素 / click / fill / pressKey / waitFor / screenshot）",
  promptGuidelines: [
    "Use browser_ctl when the user asks to operate a real browser or automate a web page.",
    "Always call browser_ctl(action=snapshot) first to get the interactive element list, then target elements by their e0/e1 id or css selector — do not guess selectors.",
    "After an action, verify with browser_ctl(action=getText) or browser_ctl(action=screenshot) before concluding.",
  ],
  parameters: Type.Object({
    action: StringEnum(ACTIONS as unknown as string[]),
    selector: Type.Optional(Type.String({ description: "css 选择器，或 snapshot 里的 e0/e1 编号（click/hover/fill/type/getText/screenshot/scroll 用）" })),
    url: Type.Optional(Type.String({ description: "要导航/新开的 URL（navigate/newTab 用）" })),
    value: Type.Optional(Type.String({ description: "要输入的文本（fill/type 用）" })),
    key: Type.Optional(Type.String({ description: "按键名，如 Enter/Tab/Esc/ArrowUp/ArrowDown/Backspace/Delete（pressKey 用）" })),
    tabId: Type.Optional(Type.Number({ description: "目标标签页 id；缺省用当前活动标签" })),
    expression: Type.Optional(Type.String({ description: "任意 JS 表达式（evaluate 用）" })),
    max: Type.Optional(Type.Number({ description: "queryAll 最大返回条数，默认 50" })),
    options: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "扩展选项：waitFor:{selector,state,timeout,fn}; scroll:{selector,direction,amount,to}; screenshot:{fullPage,selector}" })),
  }),

  async execute(_toolCallId, params, signal) {
    const cmd = params.action;
    if (!ACTIONS.includes(cmd)) throw new Error("未知 action: " + cmd);

    const body: Record<string, unknown> = { cmd };
    if (params.selector !== undefined) body.selector = params.selector;
    if (params.url !== undefined) body.url = params.url;
    if (params.value !== undefined) body.value = params.value;
    if (params.key !== undefined) body.key = params.key;
    if (params.tabId !== undefined) body.tabId = params.tabId;
    if (params.expression !== undefined) body.expression = params.expression;
    if (params.max !== undefined) body.max = params.max;
    if (params.options !== undefined) body.options = params.options;

    const msg = await bridgeRequest(cmd, body, signal);

    // 截图：转成图片 content 给模型看
    if (cmd === "screenshot" && msg.result?.dataUrl) {
      const base64 = String(msg.result.dataUrl).replace(/^data:image\/png;base64,/, "");
      return {
        content: [
          { type: "text", text: "截图完成，见下方图片。" },
          { type: "image", data: base64, mimeType: "image/png" },
        ],
        details: { action: cmd },
      };
    }

    // 其余：序列化结果
    return {
      content: [{ type: "text", text: formatResult(cmd, msg.result) }],
      details: { action: cmd, result: msg.result },
    };
  },
});

// 通过 TCP 向 bridge 发一条命令，等待对应 id 的响应。
function bridgeRequest(cmd: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.floor(Math.random() * 1e6);
    let sock: ReturnType<typeof connect> | null = null;
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock?.destroy();
        reject(new Error("browser_ctl 超时（bridge/扩展可能未就绪），请确认 bridge 已启动、扩展已加载"));
      }
    }, 20000);

    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        sock?.destroy();
        reject(new Error("browser_ctl 已取消"));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    sock = connect({ host: BRIDGE_HOST, port: BRIDGE_PORT }, () => {
      sock!.write(JSON.stringify({ ...body, id }) + "\n");
    });

    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed && parsed.id === id) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            sock!.end();
            resolve(parsed);
          }
          return;
        }
      }
    });
    sock.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`无法连接 bridge(${BRIDGE_HOST}:${BRIDGE_PORT}): ${e.message}。请先启动 bridge.js`));
      }
    });
  });
}

// 把结果格式化成文本。snapshot 精简成逐行元素清单。
function formatResult(cmd: string, r: unknown): string {
  if (r == null) return "(无返回值)";
  if (cmd === "snapshot" && r && typeof r === "object") {
    const s = r as any;
    const lines = [
      `页面: ${s.url}`,
      `标题: ${s.title}（可交互元素 ${s.elementCount} 个）`,
    ];
    for (const e of s.elements || []) {
      const extra = [
        e.type && `type=${e.type}`,
        e.value != null && `value=${JSON.stringify(e.value)}`,
        e.placeholder && `ph=${JSON.stringify(e.placeholder)}`,
        e.disabled && "disabled",
        e.checked && "checked",
      ].filter(Boolean).join(" ");
      lines.push(`${e.id} [${e.role}] "${e.name}" ${e.tag}${extra ? ` (${extra})` : ""} css=${e.selector || "?"}`);
    }
    if (s.bodyText) lines.push(`\n正文:\n${String(s.bodyText).slice(0, 800)}${String(s.bodyText).length > 800 ? "\n..." : ""}`);
    return lines.join("\n");
  }
  try { return JSON.stringify(r, null, 2); } catch { return String(r); }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(browserCtlTool);
}
