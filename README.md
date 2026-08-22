# QiKa Code

pi coding agent 的网页控制台（命令 `qika`，npm 包名保持 pi-web）。本仓库只含构建产物（源码私有维护），公开可装、零认证。

> 版权保留（UNLICENSED）：允许安装使用；未经作者许可请勿修改、再分发或商用。

## 免安装运行

```bash
npx github:jkboy/qika-dist
```

## 全局安装

```bash
npm install -g git+https://github.com/jkboy/qika-dist.git

qika              # http://localhost:7318
qika --port 8000
```

## 交互式安装/配置（推荐首次用）

装完后，包内自带一个**跨平台 Node 交互式安装器**（Windows/macOS/Linux 通用），引导完成本地/远程配置、访问 token、SSH 隧道常驻等：

```bash
# 找到全局包里的安装脚本路径（跨平台）
node "$(npm root -g)/pi-web/install-pi-web.mjs"
```

它会提问：仅本机使用，还是要远程访问（手机/笔记本）？远程模式会进一步引导配置 VPS 隧道，并自动按平台注册隧道常驻（Windows 计划任务 / macOS launchd / Linux systemd）。

> 旧版 Windows-only PowerShell 安装器（install-pi-web.ps1）仍保留在包内，存量用户可继续使用。

## 前置要求

- Node.js >= 22
- 已配置 pi agent（~/.pi/agent/models.json 或 ANTHROPIC_* 环境变量）

## 更新

```bash
qika-update   # 一键:停旧实例 → 装新版 → 自动拉起（活跃会话会被切断,请择机更新）
```

> **不要在服务运行中直接 `npm i -g` 更新**（Windows 下运行中实例锁定原生模块,
> 安装会 EBUSY 失败并可能把全局安装搬成半残）。`qika-update` 会先停旧实例再装,
> 并自动清理历史坏状态；更新前服务没在跑则只装不启动。
>
> 从旧版（≤0.2.40，命令还叫 `pi-web`）升级：再跑一次 `pi-web-update` 即可，
> 装完命令自动换成 `qika` / `qika-update`，旧命令名随之消失。
