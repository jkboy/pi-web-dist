# browser-agent 安装与排障

`browser_ctl` 工具依赖「浏览器扩展 + Native Messaging host + bridge」链路。这套链路已**内置进 QiKa Code**
（分发包 `browser-takeover/`），bridge 由 QiKa Code server **启动时自动拉起**。以下是从零配置与排障。

## 一键配置（Windows + Brave/Chrome）

> **用 `qika-update` 安装/更新 QiKa Code 后，host 配置与注册表已自动完成**，真正要手动做的
> 只剩浏览器加载扩展一步（见下第 1 条）。下面命令仅供手动补/重做时用。

```bash
cd <QiKa Code 安装目录>/browser-takeover   # 全局安装: $(npm root -g)/pi-web/browser-takeover

# 1. 浏览器加载未打包扩展（qika-update 自动注册后，这一步是唯一手动门槛）
#    brave://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 extension/ 目录

# 2. （可选，qika-update 已自动做）生成 host 配置 + 注册：
node native-host/setup-host.js      # 生成 manifest + 复制 node.exe
cmd /c "native-host\register.bat"  # 写 HKCU 注册表（Brave + Chrome）

# 3. bridge 自动启动：启动 QiKa Code server 即自动拉起（无需手动 node bridge.js）
```

扩展 ID 固定为 `hofaknjoepgnnnajgjmfdflcaceklfbg`（manifest 里有固定 key），
`setup-host.js` 已把 allowed_origins 写好，无需手动抄 ID。

> bridge 随 QiKa Code server 启停。若 server 检测到已有 bridge 在跑则不重复拉起。
> 可用 `PI_WEB_BRIDGE_AUTO_START=0` 关闭自动启动（则需手动 `node native-host/bridge.js`）。

## 验证链路

```bash
# bridge 起后应监听 9204 / 9205
netstat -ano | grep -E ":9204|:9205"

# QiKa Code server 日志应出现：
#   [bridge] 已自动拉起 bridge ...
#   [bridge] 就绪。CLI 请连 tcp://127.0.0.1:9204

# 浏览器加载扩展后，追加：
#   [bridge] host 已连接 ...（pid=...）
#   [bridge] 绑定 native messaging 通道（host pid=...）
```

看到"host 已连接"即链路通，此时 `browser_ctl` 即可用。

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| `browser_ctl` 报"无法连接 bridge" | bridge 没自动拉起 → 确认 QiKa Code server 已启动、日志有"已自动拉起 bridge"；若被 `PI_WEB_BRIDGE_AUTO_START=0` 关了，手动 `node native-host/bridge.js` |
| bridge 日志看不到"host 已连接" | 扩展没加载/没连接：`brave://extensions` 重新加载扩展，或重启浏览器 |
| `无法连接 bridge ... 请先启动 bridge.js` | 端口被占 → 设 `BRIDGE_PORT`/`BRIDGE_HOST_PORT` 换端口 |
| 改了 `extension/background.js` 不生效 | `brave://extensions` 点"重新加载"，或重启浏览器 |
| 换机器 | 重跑 `setup-host.js`（自动填本机路径）+ `register.bat`；bridge 随 server 自动起 |

## 排障提示

- 改了扩展代码后**必须重新加载扩展**，否则用的是旧版（验证前先核对）。
- manifest 的 `path` **不要加引号**（Chromium 把 path 当文件名，带引号报 host not found）。
  `setup-host.js` 会自动把当前 node 复制到 `native-host/node.exe`（无空格路径），规避
  node 在 `Program Files` 等带空格路径的坑——所以 host 用 `host.cmd`（内部 `%~dp0` 定位
  node.exe + host.js）拉起，**别再手工把 path 改成带引号的 node.exe 写法**。
- 受控浏览器（临时 profile）在 MV3 下扩展 SW 可能不自动连接，真实验证优先用真实浏览器加载扩展。

> 完整安装指南见分发包内 **`browser-takeover/INSTALL.md`**（含一键配置、注册、bridge 自动启动、
> 浏览器加载扩展、pi skill/tool 部署与常见坑）。分发包自带 `pi-agent/` 副本
> （browser-ctl.ts + skill），可直接拷到 `~/.pi/agent/`。

## 架构参考

扩展 + Native Messaging + CDP 的完整原理见分发包内 **`browser-takeover/README.md`**。
`browser_ctl` 工具只是把这条链路的命令集（snapshot/click/fill/...）封装给 agent。

## 文件位置总览

| 组件 | 正式位置 |
|---|---|
| pi custom tool（`browser_ctl`） | `~/.pi/agent/extensions/browser-ctl.ts` |
| skill | `~/.pi/agent/skills/browser-agent/` |
| 浏览器扩展 + host + bridge + CLI（分发包） | QiKa Code 安装目录内 `browser-takeover/`（源码在 `packages/browser-takeover/`） |
