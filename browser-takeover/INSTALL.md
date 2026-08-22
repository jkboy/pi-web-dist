# 安装指南（面向新机器 / 他人分发）

本工程 = **QiKa Code 内置的浏览器接管能力**：Chrome/Brave 扩展 + Native Messaging host + bridge + CLI，
另含**给 pi agent 用的 skill 与 custom tool（`browser_ctl`）**。

> 本工程已**内置进 QiKa Code**（`packages/browser-takeover/`，随 dist 分发到
> 安装包内的 `browser-takeover/` 目录）。装 QiKa Code 即自带，无需单独下载分发包。
> 安装流程：**装 QiKa Code → 首次跑一次 host 注册 → 浏览器加载扩展**。bridge 由
> QiKa Code server **启动时自动拉起**（随 server 启停），无需手动启动。

---

## 一、前置条件

| 依赖 | 要求 |
|---|---|
| 操作系统 | Windows（注册表/浏览器路径基于 Windows） |
| Node.js | ≥ 22（QiKa Code 硬性要求，装 QiKa Code 即满足） |
| 浏览器 | Brave 或 Chrome（加载未打包扩展） |
| pi agent | 已安装（若要用 `browser_ctl` 工具 / skill） |
| QiKa Code | 已安装并启动过 |

> 关键：**QiKa Code 安装目录不能含空格**（如 `C:\Users\John Doe\...` 不行）。因为
> Chromium 把 native messaging 的 `path` 当文件名、不解析引号，路径带空格会报
> `Specified native messaging host not found`。

---

## 二、安装（QiKa Code 内置版）

> **用 `qika-update` 安装/更新后，host 配置与注册表已自动完成**——安装流程末尾会自动
> 生成 manifest（含本机路径 + 复制 node.exe）并写入 HKCU 注册表（Brave + Chrome 都注册），
> 然后打印提示教你加载扩展。真正需要手动做的只有下面第 1 步（加载扩展）。

### 1. 浏览器加载扩展（唯一手动步骤）
- **Brave**：地址栏输入 `brave://extensions` → 打开右上角“开发者模式” → “加载已解压的扩展程序” → 选 `extension/` 目录。
- **Chrome**：`chrome://extensions` → 开发者模式 → 加载已解压的扩展 → 选 `extension/` 目录。

> 扩展目录路径：`$(npm root -g)/pi-web/browser-takeover/extension`（Windows 全局安装）。
> 加载后点一下扩展图标（或打开任意网页——扩展带 content script 会自动连接 host）。
> 扩展 ID 固定为 `hofaknjoepgnnnajgjmfdflcaceklfbg`（manifest 有固定 `key`），`allowed_origins` 无需改。

### 2. （可选）手动补 host 配置/注册
> 若 `qika-update` 的自动注册失败，或你想手动重做，跑：
> ```bash
> cd <QiKa Code 安装目录>/browser-takeover/native-host
> node setup-host.js        # 生成 manifest + 复制 node.exe
> cmd /c "register.bat"     # 写 HKCU 注册表（Brave + Chrome）
> ```
> 写入：`HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.example.browser_takeover`
> 和 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.example.browser_takeover`。
> （`register.bat` 用 `%~dp0` 定位同目录 manifest，在哪个目录跑就注册哪个。）

### 4. bridge：自动启动，无需手动
**QiKa Code server 启动时会自动拉起 bridge**（随 server 启停），监听 `127.0.0.1:9204`（CLI）与
`9205`（host）。无需 `node bridge.js`。

> 若 server 检测到已有 bridge 在跑（端口被占）则不重复拉起。可用环境变量关掉自动启动：
> `PI_WEB_BRIDGE_AUTO_START=0`。端口可用 `BRIDGE_PORT` / `BRIDGE_HOST_PORT` 换。

### 5. 验证链路
```bash
netstat -ano | grep ":9204"        # 应看到 LISTENING
node cli/drive.js                  # 进入 CLI，输入 listTabs
```
或直接看 QiKa Code server 日志，应出现：
```
[bridge] 已自动拉起 bridge ...
[bridge] 就绪。CLI 请连 tcp://127.0.0.1:9204
[bridge] host 请连 tcp://127.0.0.1:9205
```
浏览器打开网页后追加：
```
[bridge] host 已连接 ...（pid=...）
[bridge] 绑定 native messaging 通道（host pid=...）
```
出现“host 已连接”即链路通。

---

## 三、给 pi agent 部署（skill + `browser_ctl` 工具）

分发包自带 pi 文件副本（`pi-agent/` 目录），直接拷到 `~/.pi/agent/` 即可：

### 1. 部署 custom tool
```bash
# 把 pi-agent/extensions/browser-ctl.ts 拷到 pi 的扩展目录
cp pi-agent/extensions/browser-ctl.ts ~/.pi/agent/extensions/browser-ctl.ts
```

### 2. 部署 skill
```bash
# 把整个 browser-agent 技能目录拷到 pi 的技能目录
cp -r pi-agent/skills/browser-agent ~/.pi/agent/skills/browser-agent
```
（含 `SKILL.md` 和 `references/setup.md`）

### 3. 确认 pi 加载
重启 pi（或触发扩展重新发现）。成功后：
- `browser_ctl` 工具注册可用（action 含 snapshot/click/fill/pressKey/waitFor/screenshot 等）；
- skill `browser-agent` 出现在技能列表。

> `browser_ctl` 工具通过 **TCP 连接 bridge**（`127.0.0.1:9204`），所以它本身不关心
> bridge 装在哪、也不引用任何文件路径——只要 bridge 在跑、浏览器扩展已连上，工具即可用。

> 若后续更新了分发包里的 `browser-ctl.ts` / `SKILL.md`，把改动同步回你机器上的
> `~/.pi/agent/` 对应位置即可（或反之，修改 pi 里的版本后同步回 `pi-agent/` 副本）。
> 本仓库里 browser-takeover 已内置在 `packages/browser-takeover/`，`pi-agent/` 副本在它下面。

---

## 四、常见问题

| 现象 | 原因 / 解决 |
|---|---|
| `Specified native messaging host not found`，host 进程从不拉起 | ① QiKa Code 安装目录含空格 → 换无空格路径，重跑 setup-host.js + register.bat；② manifest 的 `path` 带了双引号（Chromium 把它当文件名）→ 确认 setup-host.js 生成的是纯路径；③ 注册表没写成功 → 重跑 register.bat 并重启浏览器 |
| `browser_ctl` 报“无法连接 bridge” | bridge 没自动拉起 → 确认 server 已启动且日志有“已自动拉起 bridge”；若被 `PI_WEB_BRIDGE_AUTO_START=0` 关了，手动 `node bridge.js` |
| bridge 日志看不到“host 已连接” | 扩展没加载/没连接 → `brave://extensions` 重新加载扩展，或重启浏览器 |
| 改了扩展代码不生效 | `brave://extensions` 点“重新加载”，或重启浏览器 |
| 换机器 | 重跑 `setup-host.js`（自动填本机路径 + node.exe）+ `register.bat`；bridge 随 server 自动起 |
| 端口冲突 | 设 `BRIDGE_PORT` / `BRIDGE_HOST_PORT` 换端口（需与扩展里的端口配置一致） |

---

## 五、一键脚本（可选）

如果想让别人更快装好，可提供一个一键 `install.bat`（Windows）：
```bat
@echo off
cd /d %~dp0
node native-host\setup-host.js   && echo [1/3] 配置已生成
call native-host\register.bat    && echo [2/3] 已注册
echo 请手动: 1) 启动 QiKa Code（自动拉起 bridge）  2) 浏览器加载扩展
pause
```
（此脚本未包含在仓库中，可按需创建。安装完 QiKa Code 起 server 后 bridge 即自动运行。）
