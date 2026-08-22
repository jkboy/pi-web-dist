// ============================================================
// QikaCode —— Native Messaging Host（瘦桥，被 Chrome 按需拉起）
//
// Chrome 每次扩展 connectNative 都会【新拉起一个本进程】，并只与它
// 用 stdin/stdout 交换帧（4 字节小端长度 + JSON）。
//
// 本进程不持有任何逻辑，只做两件事：
//   1. 把 Chrome(扩展) 发来的 stdin 帧，原样转发给【常驻 bridge.js】
//   2. 把 bridge 发来的帧，原样写回 stdout 给 Chrome(扩展)
//
// 为什么这样拆：Chrome 每 connectNative 都新建 host 进程，若 host 自己
// 又当 TCP 服务端，多个 host 会抢同一个端口（已实测踩坑）。
// 正解是让 host 只做薄桥，常驻主程序（bridge）持有唯一端口。
// ============================================================

const net = require("net");
const fs = require("fs");
const path = require("path");

// 诊断日志：记录 host 是否被 Chrome 拉起（正式部署排障用）
const DIAG_LOG = process.env.HOST_DIAG_LOG || path.join(__dirname, "host-diag.log");
function diag(msg) {
  try { fs.appendFileSync(DIAG_LOG, new Date().toISOString() + " " + msg + "\n"); } catch {}
}
diag("host 进程启动 pid=" + process.pid + " argv=" + JSON.stringify(process.argv));

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = Number(process.env.BRIDGE_HOST_PORT || 9205); // 连 bridge 的 host 端口

// ---- Native Messaging 帧收发（4 字节小端长度 + JSON） ------------
function sendToChrome(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(payload.length, 0);
  try {
    // 写底层 fd 1，避免 Windows 文本模式把长度里的 0x1A(^Z) 当 EOF、把 \n 翻译成 \r\n
    fs.writeSync(1, Buffer.concat([len, payload]));
  } catch {
    // stdout 已被 Chrome 关闭（断开）：无法再与扩展通信，退出防僵尸
    process.exit(0);
  }
}

function readFromChrome(forward) {
  let buf = Buffer.alloc(0);
  let needed = 4;
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < needed) break;
      if (needed === 4) {
        const len = buf.readUInt32LE(0);
        buf = buf.subarray(4);
        needed = len;
        continue;
      }
      const payload = buf.subarray(0, needed).toString("utf8");
      buf = buf.subarray(needed);
      needed = 4;
      try {
        const msg = JSON.parse(payload);
        forward(msg); // 转发给 bridge
      } catch (e) {
        console.error("[host] 解析失败:", e.message);
      }
    }
  });
}

// ---- 与常驻 bridge 的 TCP 连接 --------------------------------
let bridgeSock = null;

function connectBridge() {
  // 关闭上一个（若有），避免堆积多个连接，保证 bridge 只看到一个活动 host
  if (bridgeSock && !bridgeSock.destroyed) bridgeSock.destroy();

  const sock = net.createConnection({ host: BRIDGE_HOST, port: BRIDGE_PORT }, () => {
    console.error(`[host:${process.pid}] 已连接 bridge ${BRIDGE_HOST}:${BRIDGE_PORT}`);
    sock.write(JSON.stringify({ type: "bind", pid: process.pid }) + "\n");
  });
  bridgeSock = sock;

  sock.on("data", (d) => {
    // bridge 发来的每条是 JSON + 换行；逐条拆出并写回 stdout 给扩展
    const lines = d.toString("utf8").split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        sendToChrome(obj);
      } catch (e) {
        console.error("[host] 转发 bridge->chrome 失败:", e.message);
      }
    }
  });

  sock.on("error", (e) => {
    console.error(`[host:${process.pid}] bridge 连接失败:`, e.message);
    setTimeout(connectBridge, 1000);
  });

  sock.on("close", () => {
    if (bridgeSock === sock) bridgeSock = null;
    console.error(`[host:${process.pid}] bridge 断开，重连...`);
    setTimeout(connectBridge, 1000);
  });

  return sock;
}

// ---- 主流程 ----------------------------------------------------
connectBridge(); // 内部维护模块级 bridgeSock

// Chrome→host 的 stdin 帧 → 转发给 bridge
readFromChrome((msg) => {
  if (bridgeSock && !bridgeSock.destroyed) {
    bridgeSock.write(JSON.stringify(msg) + "\n");
  }
});

process.on("SIGINT", () => process.exit(0));

// Chrome 断开（扩展重载/浏览器退出/更新期间被摘注册）时 stdin 收到 EOF：
// 必须立即退出。否则本进程只剩 bridge 重连定时器、永不退出——而且 Chrome
// 杀的是 host.cmd 包装层（cmd.exe），子进程 node 会变孤儿堆积成僵尸
//（实测一台机器攒了 9 个，2026-08-17）。
process.stdin.on("end", () => {
  diag("stdin EOF(Chrome 断开)，退出 pid=" + process.pid);
  process.exit(0);
});
process.stdin.on("close", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
