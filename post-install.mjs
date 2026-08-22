#!/usr/bin/env node
// post-install.mjs —— 安装时步骤钩子（随包分发，装完由更新器/安装器显式调用）。
//
// 为什么存在：qika-update 自身也是被更新的包的一部分，更新器里写死的安装时
// 步骤永远晚一班车（0.2.66→0.2.67 的 host 自动注册第一遍没跑，实锤）。安装时
// 步骤放本文件，随新包落盘、装完立即被外部调用，新步骤当次生效；更新器退化
// 为稳定外壳（停旧 → 装 → 调钩子 → 拉起），以后加安装时步骤只改本文件。
//
// 千万不要改成 npm postinstall 生命周期：git 依赖带 scripts 会触发 npm 的
// "内嵌 install 预备"流程，嵌套 npm 继承外层 global 配置后在全局树里自我冲突
// (ENOTEMPTY/junction 残留，v0.2.19 实测)。必须由调用方显式 `node post-install.mjs`。
//
// 约定：幂等（重复跑无副作用）；失败退出码非 0，但调用方只警告不阻断安装。
// 用法：node post-install.mjs [--no-hint]   （--no-hint 跳过扩展加载提示）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';
// 本文件位于包根（<全局>/pi-web/post-install.mjs），相对自身定位包内资源——
// 保证"新装的包的钩子操作新装的包自己"，不依赖 npm root -g 的解析时机。
const pkgRoot = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(`[post-install] ${m}`);
let failed = false;

setupNativeHost();
if (!process.argv.includes('--no-hint')) printExtensionHint();
process.exit(failed ? 1 : 0);

// 注册内置 browser-takeover 的 Native Messaging host。
// 步骤：跑 setup-host.js（生成含本机绝对路径的 manifest + 复制 node.exe）
// → Windows 跑 register.bat 写 HKCU 注册表（Brave + Chrome）。失败只警告不阻断
// （可手动补：进 native-host/ 跑 setup-host.js && register.bat）。
function setupNativeHost() {
  const hostDir = path.join(pkgRoot, 'browser-takeover', 'native-host');
  const setupJs = path.join(hostDir, 'setup-host.js');
  if (!fs.existsSync(setupJs)) {
    log('未找到内置 browser-takeover 的 host 配置脚本，跳过 host 自动注册。');
    return;
  }
  try {
    log(`生成 host 配置:${setupJs}`);
    const r = spawnSync(process.execPath, [setupJs], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || 'setup-host.js 退出码 ' + r.status);
    if (isWin) {
      const regBat = path.join(hostDir, 'register.bat');
      log('注册 host 到浏览器注册表（Brave + Chrome）…');
      const rr = spawnSync('cmd', ['/c', regBat], { encoding: 'utf8', stdio: 'inherit' });
      if (rr.status !== 0) throw new Error('register.bat 退出码 ' + rr.status);
      log('host 已注册。');
    } else {
      log('（非 Windows：已生成 host 配置，请按需手动注册 Native Messaging host）');
    }
  } catch (e) {
    failed = true;
    log(`host 自动注册失败（不影响安装，可稍后手动补）：${e.message}`);
  }
}

// 安装结束的提示：教用户怎么在浏览器里加载未打包扩展（自动化绕不开的一步）。
function printExtensionHint() {
  const extDir = path.join(pkgRoot, 'browser-takeover', 'extension');
  console.log('\n' + '='.repeat(60));
  console.log('下一步：在浏览器里加载扩展（这是唯一需要手动的一步）');
  console.log('='.repeat(60));
  console.log(`  扩展目录: ${extDir}\n`);
  console.log('  Brave  : 地址栏输入 brave://extensions');
  console.log('  Chrome : 地址栏输入 chrome://extensions');
  console.log('  步骤   : 打开右上角“开发者模式” →');
  console.log('          “加载已解压的扩展程序” → 选中上面的扩展目录');
  console.log('          （本包 manifest 带固定 key，扩展 ID 稳定，无需改配置）');
  console.log('  完成   : 重启 QiKa Code 后 bridge 自动启动，即可用 browser_ctl 操作浏览器。\n');
}
