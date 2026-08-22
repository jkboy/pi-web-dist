---
name: browser-agent
description: 驱动本机浏览器（浏览器接管）。用户要求操作真实浏览器、网页自动化（填表单、点按钮、抓页面数据、截图）、或让 AI 像 codex 一样"打开网页操作"时使用；需要浏览器已装扩展 + bridge 在跑（见 references/setup.md）。
---

# 浏览器接管（browser-agent）

让 pi agent 通过 `browser_ctl` 工具像 codex 一样操作本机浏览器。底层是
`~/.pi/tools/browser-takeover/` 的「Chrome/Brave 扩展 + Native Messaging + CDP」链路，
`browser_ctl` 工具把这条链路封装成 agent 可直接调用的语义化动作。

## 何时使用

- 用户要求操作真实浏览器 / 打开网页 / 网页自动化。
- 需要在网页上填表、点按钮、抓取页面数据、登录、截图。
- 需要把某个网页流程（比如提交表单后验证结果）做成可重复的自动步骤。

## 前置条件

- 浏览器（Brave/Chrome）已加载 `extension/` 未打包扩展（开发者模式 → 加载已解压的扩展程序）。
- Native Messaging host 已注册（`register.bat`，含 manifest 路径）。
- `bridge.js` 常驻程序在跑（端口 9204/9205）。
- 详细安装与排障见 [`references/setup.md`](references/setup.md)。

`browser_ctl` 每次调用都会连 bridge；若 bridge 没起或扩展没连接，工具会报错，先把链路拉起来。

## 工作流（codex 式闭环）

**核心铁律：先 snapshot 观察，再操作，后验证。别猜选择器。**

1. **snapshot** —— 拿到页面可交互元素清单（每个元素带 `e0/e1` 编号 + 稳定 css 选择器 + role/名称/值/占位符）+ 正文摘要。
   ```
   browser_ctl(action="snapshot")
   ```
2. **选目标** —— 从 snapshot 结果里挑要操作的元素，用它的 `e0/e1` 编号**或** css 选择器。
3. **操作** —— 用受信任事件操作：
   - `click`：点按钮/链接/复选框
   - `fill`：清空后输入（React 受控组件也安全）
   - `type`：在聚焦处追加输入
   - `pressKey`：按键（Enter/Tab/Esc/ArrowUp/ArrowDown/Backspace/Delete...）
   - `scroll`：滚动（元素 / up/down / top/bottom）
4. **等待** —— 页面加载、元素出现用 `waitFor`（比裸 sleep 可靠）：
   ```
   browser_ctl(action="waitFor", selector=".result", options={state:"visible", timeout:8000})
   ```
5. **验证** —— 每次操作后用 `getText`/`screenshot` 核对结果，再决定下一步。

## 命令速查

| action | 参数 | 说明 |
|---|---|---|
| `snapshot` | — | 页面快照：可交互元素清单 + 正文（**先调这个**） |
| `getText` | `selector` | 读元素文本/值/位置 |
| `queryAll` | `selector`, `max?` | 批量读元素文本/链接（抓列表数据） |
| `pageInfo` | — | 标题/URL/正文（简版） |
| `listTabs` | — | 列出所有标签页 |
| `active` | — | 当前活动标签 |
| `navigate` | `url`, `tabId?` | 导航到 URL |
| `newTab` / `closeTab` | `url` / `tabId` | 新开 / 关闭标签 |
| `click` | `selector`, `tabId?` | 受信任点击（支持 e编号或 css） |
| `hover` | `selector` | 悬停 |
| `fill` | `selector`, `value` | 清空后输入（React 安全） |
| `type` | `selector`, `value` | 聚焦处追加输入 |
| `pressKey` | `key` | 按键 |
| `scroll` | `options` | 滚动 |
| `waitFor` | `selector` 或 `options` | 条件等待（state=visible/hidden/removed, timeout） |
| `screenshot` | `options` | 截图；`options={fullPage:true}` 全页，`options={selector}` 元素级 |
| `evaluate` | `expression` | 任意 JS（逃生舱） |

## 注意事项

- **selector 用 snapshot 给的 css 或 e编号**，不要凭空猜。猜错会让点击落在错误元素上。
- **`waitFor` 替代裸 sleep**：页面是异步的，`navigate` 后等元素出现比固定 sleep 稳。
- **React 表单**：`fill` 已处理受控组件；复选框/单选用 `click` 而非 `fill`。
- **截图确认**：对视觉敏感的操作（布局、弹窗、加载态）用 `screenshot` 看一眼，不要只信文本。
- **多步任务**：做完一步用 `getText`/`screenshot` 验证，再决定下一步，别一次性连发可能落空的命令。

## 面向模型的设计说明

- 模型看到的工具面：`browser_ctl` 一个工具 + action 枚举 + 少量可选参数。`promptSnippet`/`promptGuidelines` 常驻系统提示。
- Token 影响：工具 schema 固定（每请求一小段）；`snapshot` 结果含元素清单 + 正文（可到数百 token），`queryAll` 可限量。
- KV Cache：工具面固定，无按 turn 变化的前缀；追加式稳定。
- 归类：这是**补下限**机制（把"操作真实浏览器"这个能力补上，不约束模型发挥），对更强模型同样成立，可放心长期使用。
