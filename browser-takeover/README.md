# QikaCode —— 浏览器接管原理教学工程（Node.js + 浏览器扩展）

> 一套**能真正跑起来**的最小实现，向学生讲透：**如何接管本机已运行的浏览器并操作它的页面**。
> 技术栈：Chrome/Brave 扩展 + Native Messaging 本地桥 + CDP（Chrome DevTools Protocol）。
> 无第三方依赖，仅用 Node.js 内置模块（`net` / `child_process` / `fs`）。
>
> **▶ 想在新机器/给别人安装整套功能（扩展 + host + bridge + pi skill/tool）？见
> [`INSTALL.md`](INSTALL.md)。** 本 README 侧重原理与本地开发使用。

---

## 一、核心原理

要"接管"一个**已经在运行的浏览器**，需要三件套配合：

```
  上层控制器(CLI)
        │ ① JSON 命令
        ▼
   Bridge 常驻程序       ┌──────── ② 4字节长度前缀 + JSON 线协议 ─────┐
        │                ▼                                           ▼
        │           Native Host 本地进程 ◀──Native Messaging──▶ 浏览器
        │           (被Chrome按需拉起)                            │
        │                ▲                                        ▼
        └──── ④ 返回结果 ┘                              浏览器扩展(执行器)
                                                        用 chrome.debugger/CDP
                                                            操作真实页面
```

**两个最关键的技术点：**

1. **Native Messaging 线协议**：Chrome 为每个 host 启动一个本机进程，与之用
   **stdin/stdout** 交换消息，每条消息格式为：
   ```
   [ 4 字节 小端 uint32 = JSON 长度 N ][ N 字节 UTF-8 JSON ]
   ```
   这是连接"浏览器世界"与"外部世界"的通道。

2. **CDP（Chrome DevTools Protocol）**：扩展拿到命令后，用 `chrome.debugger` 对标签页
   attach 一个调试会话，再发 `Runtime.evaluate` / `Page.captureScreenshot` 等 CDP 命令，
   从而**读写页面 DOM、执行 JS、截图**。Playwright / Puppeteer 底层用的也是 CDP。
   **关键点**：`chrome.debugger.attach` 对"已打开的标签页"现场建立调试会话，
   不需要先关浏览器、不需要用调试端口重启——这正是能接管"正在用"的浏览器的原因。

**接管的两种情形：**

| 情形 | 行为 | 实现 |
|---|---|---|
| **浏览器未打开** | 控制器直接**拉起一个新浏览器窗口**（带扩展） | `browser-orchestrator.js` 的 `launchBrowser()` |
| **浏览器已打开** | 不开新窗口，在现有窗口**开一个新标签页** | 扩展的 `newTab`（`chrome.tabs.create`） |

"先探测进程、再决定拉起窗口还是开标签页"的决策，封装在 `browser-orchestrator.js`。

---

## 二、目录结构与角色

```
browser-takeover/
├─ extension/                    # 浏览器侧：执行器
│  ├─ manifest.json              #   MV3 清单，含固定 key 保证扩展 ID 稳定
│  └─ background.js              #   Service Worker：连 host、用 CDP 操作页面
├─ native-host/                  # 本地侧：桥梁
│  ├─ host.js                    #   瘦 host：Chrome 按需拉起，stdin/stdout 帧转发
│  ├─ host.cmd                   #   Windows 启动器（经 cmd.exe 拉起 node.exe + host.js）
│  ├─ bridge.js                  #   常驻程序：CLI 与 host 之间的路由中枢
│  ├─ browser-orchestrator.js    #   接管策略：探测浏览器 → 拉起窗口 or 开标签页
│  ├─ setup-host.js              #   生成 native messaging manifest（自动填路径+ID）
│  ├─ install-host.bat           #   注册 host 到 Windows 注册表
│  └─ com.example.browser_takeover.json  # native messaging 宿主配置
├─ cli/drive.js                  # CLI：连 bridge 交互式驱动浏览器
├─ demo.txt                      # 一键演示脚本（两种接管情形）
└─ screenshots/                  # 截图输出目录（运行时生成）
```

---

## 三、第一次跑通（Windows + Brave / Chrome）

### 前置
- Node.js ≥ 18（本实现用 22/24 测试）
- 已装 Brave（或 Chrome）
- **无需联网拉依赖**（只用 Node 内置模块）

### 步骤

**1. 生成 native messaging 配置**
```bash
node native-host/setup-host.js
```
自动写 `com.example.browser_takeover.json`（填好 host.cmd 的绝对路径和扩展 ID）。
> 扩展 ID 是**固定的** `hofaknjoepgnnnajgjmfdflcaceklfbg`——因为 manifest 里
> 写了固定的 `key`。有固定 ID 才能提前把 allowed_origins 写好，避免“先装扩展
> 再抄 ID”的鸡生蛋问题。
>
> **重要坑（已实测踩过）**：manifest 的 `path` 字段**不要用双引号包裹**——
> Chrome/Brave 把 path 当作“文件名”（不解析内部引号），带引号的路径会报
> `Specified native messaging host not found`，host 进程从不被拉起。
> 本仓库路径无空格，`setup-host.js` 生成的 path 就是纯路径（无引号），
> host 走 `host.cmd`（内部 `%~dp0` 定位同目录 node.exe + host.js）启动。
> 若自定义路径含空格，`path` 仍不能带引号（需把可执行文件放到无空格目录）。

**2. 注册到 Windows 注册表**
```bash
native-host\register.bat
```
（会同时注册给 Brave 和 Chrome 两个 NativeMessagingHosts 键。）

**3. 启动常驻 Bridge**
```bash
node native-host/bridge.js
```

**4. 打开浏览器并加载扩展**
- 手动法：`brave://extensions` → 开发者模式 → "加载已解压的扩展程序" → 选 `extension/` 目录。
- 或让 orchestrator 自动拉起（见第四节情形 1）。

**5. 驱动浏览器**
```bash
node cli/drive.js demo.txt     # 一键演示
# 或交互式
node cli/drive.js
ctl> listTabs
ctl> navigate https://example.com
ctl> snapshot              # AI 可读的页面快照：可交互元素清单(role/name/e编号/css选择器)
ctl> click e3              # 点击（支持 snapshot 里的 e0/e1 编号，也支持 css 选择器）
ctl> fill e5 hello         # 输入（React 安全，受信任键盘事件）
ctl> pressKey Enter
ctl> waitFor .result       # 条件等待元素出现
ctl> getText .result       # 读取元素文本
ctl> screenshot

# 完整命令见 help，或 README 第四节
```

---

## 四、AI 浏览器 agent 使用指南（codex 式闭环）

这套原型不只给人敲命令，更适合作为 **AI agent 的浏览器操作后端**。核心思路是
**「先快照观察，再受信任操作，后验证」**：

```
① snapshot   → AI 拿到页面可交互元素清单（role/name/e编号/稳定css选择器）+ 正文
② 选目标     → 用 e编号或 css 选择器决定点哪、填哪
③ 操作       → click / fill / type / pressKey / scroll（真实鼠标/键盘事件，受信任）
④ 等待       → waitFor 条件等待（替代裸 sleep，更可靠）
⑤ 验证       → screenshot（视口/全页/元素级）+ getText/queryAll 读结果
```

### 完整命令集

| 类别 | 命令 | 说明 |
|---|---|---|
| 观察 | `snapshot` | **页面快照**：可交互元素清单(role/name/type/value/placeholder/checked/rect) + 稳定 css 选择器 + e0/e1 编号 + 正文摘要 |
| 观察 | `getText <sel>` | 读取某元素文本/值/位置 |
| 观察 | `queryAll <sel> [max]` | 批量取元素文本/链接，读结构化数据 |
| 观察 | `pageInfo` | 标题/URL/正文/链接（旧版简版） |
| 导航 | `navigate <url>` / `newTab` / `closeTab` / `listTabs` / `active` | 标签与导航 |
| 操作 | `click <sel>` | 受信任点击（支持 `e3` 或 css） |
| 操作 | `hover <sel>` | 悬停（受信任 mouseMoved） |
| 操作 | `fill <sel> <值>` | 清空后输入（React 受控组件安全，受信任键盘） |
| 操作 | `type <sel> <值>` | 在聚焦处追加输入（不先清空） |
| 操作 | `pressKey <key>` | 按键（Enter/Tab/Esc/ArrowUp/.../单字符） |
| 操作 | `scroll [sel|up/down|top/bottom] [amount]` | 滚动 |
| 等待 | `waitFor <sel> [visible/hidden/removed] [timeout]` | 条件等待元素 |
| 等待 | `waitFn <JS条件>` | 等待自定义 JS 条件为真 |
| 截图 | `screenshot` / `shotFull` / `shotEl <sel>` | 视口 / 全页 / 元素级截图 |
| 底层 | `eval <JS>` | 任意 JS（逃生舱） |

### 对 AI 关键的设计点

1. **snapshot 是给模型看的「页面状态图」**：不是原始 `innerText`，而是把 DOM 里的
   可交互元素（按钮/链接/输入框/下拉/复选框等）提炼成紧凑清单，每个都带 role、名称、
   当前值、placeholder、以及**能稳定反查的 css 选择器**和递增编号 `e0/e1/...`。模型据此
   决定点哪个、填哪个，避免瞎猜选择器。
2. **受信任事件**：`click`/`hover` 走 CDP `Input.dispatchMouseEvent`（真实坐标），
   `fill`/`type` 走 CDP `Input.insertText`（受信任键盘）。依赖 `isTrusted` 的库、
   React 受控组件都能正常响应——这是教学版合成事件做不到的。
3. **条件等待**：`waitFor`/`waitFn` 轮询页面状态，比裸 `sleep` 更能应对加载时序。
4. **验证闭环**：每次操作后用 `getText`/`screenshot` 核对结果，模型可据此决定下一步。

> 想把这套能力正式接入 pi agent（作为 custom tool / skill），见工程外整理的可选方案。

---

## 五、两种接管情形怎么演示

**情形 2（浏览器已打开 → 开新标签页）**——最常演示：
```
ctl> newTab https://example.org   # 在现有窗口新增一个标签页
ctl> listTabs                      # 能看到两个标签并排
```

**情形 1（浏览器未打开 → 拉起新窗口）**：
```bash
node native-host/browser-orchestrator.js https://example.com
```
它会先 `isBrowserRunning()` 探测：没有受控浏览器就 `spawn` 一个带扩展的新窗口；
有就直接在现有窗口开标签页。

### 可配置项（全部可用环境变量覆盖）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `BRAVE_EXE` | 自动探测常见安装路径 | 浏览器可执行文件路径 |
| `EXT_PATH` | 自动指向本工程 `extension/` | 扩展目录 |
| `PROFILE_DIR` | 系统临时目录 | 受控浏览器 profile（避免污染真实配置） |
| `BRIDGE_PORT` | 9204 | CLI 连接的端口 |
| `BRIDGE_HOST_PORT` | 9205 | host 连接的端口 |

> 换机器只需重跑 `setup-host.js`（它用 `__dirname` / `process.execPath` 自动推导路径），
> 再 `register.bat` 注册即可，**无需改任何代码**。

---

## 六、关键代码讲解（划重点）

### 1. 线协议收发 —— `native-host/host.js`
```js
function sendToChrome(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(payload.length, 0);        // 4字节小端长度
  fs.writeSync(1, Buffer.concat([len, payload])); // 写底层 fd1，避开文本模式
}
```
> 为什么用 `fs.writeSync(1, ...)` 而不是 `process.stdout.write`？Windows 文本模式会把
> 长度字节里的 `0x1A`(^Z) 误当 EOF、把 `\n` 翻译成 `\r\n`，从而破坏协议。

### 2. 用 CDP 驱动页面 —— `extension/background.js`
```js
await chrome.debugger.attach({ tabId }, "1.3");
const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
  expression: "document.title", returnByValue: true,
});
// res.result.value 就是返回值（注意 sendCommand 直接 resolve 为 params，不是包装层）
```
`click` / `fill` / `pageInfo` 都是往页面注入 JS 实现的；`screenshot` 用 `Page.captureScreenshot`。

### 3. 常驻路由 —— `native-host/bridge.js`
持有两份监听：`CLI端口(9204)` 和 `host端口(9205)`。CLI 的命令带 `id` 转给当前
活动 host，扩展执行完按同样 `id` 回传，bridge 找到对应 CLI 连接回写。
> 踩坑实录：Chrome 每次 `connectNative` 都会**新拉起一个 host 进程**，若 host 自己又当
> TCP 服务端，多个进程会抢同一端口。所以 host 只做"薄桥"，真正的常驻端口由
> bridge 持有——这也是本实现把"路由中枢"独立成 bridge 的原因。

---

## 七、教学演练建议

- **先静态讲**：画第一节那条管线图，讲清"4 字节长度前缀"和"CDP 三件套"。
- **再跑情形 2**：开着一个浏览器，跑 `newTab` + `pageInfo` + `screenshot`，让学生
  看到"现有浏览器被开了新标签并被读取/截图"。
- **跑情形 1**：关掉浏览器，用 orchestrator 看它"先探测→拉起新窗口"。
- **现场改**：改 `demo.txt` 里的选择器/URL，演示 `click`/`fill` 操作真实网页。
- **进阶**：给 `host.js` 加日志，抓 4 字节长度前缀帧，直观看到线协议。

---

## 八、常见问题

| 现象 | 原因 / 解决 |
|---|---|
| `扩展尚未连接` | host 没注册、浏览器没重启、或扩展没加载。重跑 `register.bat` + 重启浏览器 |
| `Another debugger is already attached` | 页面调试器残留。扩展已用"attach 前先清理"规避 |
| 端口 `9204 EACCES` | Windows 保留端口段占用，改用 `BRIDGE_PORT` 换个端口 |
| 改了 `background.js` 没生效 | 到 `brave://extensions` 点"重新加载"扩展，或重启浏览器 |
| 想在 Chrome 上跑 | 设 `BRAVE_EXE` 指向 chrome.exe，注册表用 Chrome 键（`register.bat` 已同时注册） |

---

## 九、参考（官方文档，供学生自学，不包含任何抄作业内容）

- Chrome 扩展 Native Messaging：developer.chrome.com（`chrome.runtime.connectNative` / 线协议）
- Chrome DevTools Protocol：chromedevtools.github.io（`chrome.debugger`、`Runtime.evaluate`、`Page.captureScreenshot`）
- Chrome 扩展 `chrome.debugger` API：developer.chrome.com

> 工程完全从零实现，不包含任何外部产品代码。建议学生**先理解原理、再独立实现**，
> 遇到卡点可对照本工程验证自己的思路，而不是照抄。
