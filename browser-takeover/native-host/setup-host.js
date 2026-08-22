// setup-host.js —— 生成 Native Messaging manifest（自动填绝对路径 + 扩展 ID）
// 在 native-host/ 目录运行: node setup-host.js
//
// 一键准备：
//   1. 自动复制 process.execPath（当前 node）→ 本目录 node.exe（host.cmd 依赖）；
//   2. 生成 com.example.browser_takeover.json（host.cmd 绝对路径 + 扩展 ID）。
// 然后跑 register.bat 注册到注册表即可。
//
// 关键：Windows 下 Chrome 原生消息 host 的 path 指向 host.cmd（单一 .cmd 包装）。
// host.cmd 内部用 %~dp0 定位同目录的 node.exe + host.js。
// 直接写 node.exe+脚本参数会因 Chromium 对“exe+空格参数”解析不可靠而报
// “Specified native messaging host not found”（已实测），.cmd 包装规避。
// 已实测 host.cmd 经 cmd.exe 能把 stdin/stdout 管道透传给 node（bridge 能连上）。
// 另：manifest 的 path 不要带双引号（Chrome 把 path 当文件名，带引号报 not found）。
const fs = require("fs");
const path = require("path");

const EXT_ID = process.env.EXT_ID || "hofaknjoepgnnnajgjmfdflcaceklfbg";

// —— 准备本地 node.exe 副本（host.cmd 依赖它）——
// host.cmd 里 `%~dp0node.exe` 必须存在。直接用 `process.execPath`（当前 node）
// 复制一份到本目录，顺带解决两个坑：
//   1) 别人没有 `native-host/node.exe`（本脚本自动生成，无需手工拷）；
//   2) node 若在带空格的路径（如 `Program Files`），manifest path 不能带引号，
//      复制到无空格的本目录即可规避 host not found。
const execPath = process.execPath;
const localNode = path.join(__dirname, "node.exe");
if (!fs.existsSync(localNode)) {
  fs.copyFileSync(execPath, localNode);
  console.log("[OK] 已复制 node.exe 到本目录（来自", execPath, "）");
} else {
  console.log("[OK] node.exe 已存在于本目录（若 node 版本过旧，可删除后重跑本脚本）");
}

// host.cmd 绝对路径（无空格，不需要引号——Chrome 把 path 当作文件名，带引号反而不匹配）
const hostCmdPath = path.join(__dirname, "host.cmd").replace(/\\/g, "/");
const hostCmd = hostCmdPath;

const manifest = {
  name: "com.example.browser_takeover",
  description: "QikaCode - Native Messaging Host",
  path: hostCmd,
  type: "stdio",
  allowed_origins: [`chrome-extension://${EXT_ID}/`],
};

const out = path.join(__dirname, "com.example.browser_takeover.json");
fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log("[OK] 已生成:", out);
console.log("host.cmd:", hostCmd);
console.log(JSON.stringify(manifest, null, 2));
console.log("\n说明：本文件包含本机绝对路径。拷到别的机器后必须重跑一次本脚本重新生成。");
