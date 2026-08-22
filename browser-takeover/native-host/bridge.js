// ============================================================
// QikaCode —— Bridge（常驻主程序）
//
// 角色：持久的 TCP 服务端，教师 CLI 连它、被 Chrome 拉起的瘦 host 也连它。
// 它负责把「CLI 的命令」转发给「当前活动的 native messaging 通道（host→扩展）」,
// 再把「扩展的执行结果」原路送回 CLI。
//
//   教师 CLI ──TCP──▶ bridge ──▶ host(瘦) ──stdout帧──▶ Chrome ──▶ 扩展(执行)
//   教师 CLI ◀──TCP── bridge ◀── host(瘦) ◀──stdin帧─── Chrome ◀─── 扩展(结果)
//
// 用法：node native-host/bridge.js
// ============================================================

const net = require("net");

const PORT = Number(process.env.BRIDGE_PORT || 9204);      // CLI 连这个
const HOST_PORT = Number(process.env.BRIDGE_HOST_PORT || 9205); // host(Chrome拉起)连这个
const HOST = "127.0.0.1";

let msgId = 0;
const pending = new Map();   // id -> CLI socket（等待结果）
let activeHost = null;       // 当前活动的 host 连接（Chrome 可能按需拉起多个，取最新）

// ---- 处理来自 CLI（教师驾驶员）的连接 --------------------------
const cliServer = net.createServer((cli) => {
  console.error(`[bridge] 教师 CLI 已连接: ${cli.remoteAddress}`);
  let buf = "";
  cli.on("data", (d) => {
    buf += d.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handleCliLine(cli, line);
    }
  });
  cli.on("error", () => {});
  cli.on("close", () => {
    console.error("[bridge] 教师 CLI 断开");
  });
});

function handleCliLine(cli, line) {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    cli.write(JSON.stringify({ ok: false, error: "非法命令" }) + "\n");
    return;
  }

  if (!activeHost || activeHost.destroyed) {
    cli.write(
      JSON.stringify({
        ok: false,
        error: "没有活动的扩展连接（请确认扩展已加载、host 已注册、浏览器已开）",
      }) + "\n"
    );
    return;
  }

  // 优先用 CLI 自带的 id（便于 CLI 与回包配对），否则自增生成
  const id = cmd.id != null ? cmd.id : ++msgId;
  pending.set(id, cli);
  // 给 host 的消息带上 id；host→chrome→扩展执行后，扩展会回带同样 id
  activeHost.write(JSON.stringify({ ...cmd, id }) + "\n");
  console.error(`[bridge] 转发命令 #${id}: ${cmd.cmd}`);
}

// ---- 处理来自 host（Chrome 拉起的瘦桥）的连接 -------------------
const hostServer = net.createServer((host) => {
  console.error(`[bridge] host 已连接: ${host.remoteAddress}:${host.remotePort}（pid=${host.localPort}）`);
  // 新 host 成为「当前活动通道」（Chrome 每次 connectNative 拉新进程）
  activeHost = host;

  let buf = "";
  host.on("data", (d) => {
    buf += d.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handleHostLine(host, line);
    }
  });

  host.on("error", () => {});
  host.on("close", () => {
    console.error("[bridge] host 断开");
    if (activeHost === host) activeHost = null;
  });
});

// host 发来的可能是：绑定消息 / 扩展回传的命令结果
function handleHostLine(host, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // 绑定消息
  if (msg.type === "bind") {
    console.error(`[bridge] 绑定 native messaging 通道（host pid=${msg.pid}）`);
    return;
  }

  // 扩展回传的命令结果：msg 里有我们发出去的 id
  if (msg.id != null && pending.has(msg.id)) {
    const cli = pending.get(msg.id);
    pending.delete(msg.id);
    if (!cli.destroyed) {
      cli.write(JSON.stringify(msg) + "\n");
      console.error(`[bridge] 命令 #${msg.id} 结果已回传 CLI`);
    }
  }
}

cliServer.listen(PORT, HOST, () => {
  console.error(`[bridge] 就绪。CLI 请连 tcp://${HOST}:${PORT}`);
});
hostServer.listen(HOST_PORT, HOST, () => {
  console.error(`[bridge] host 请连 tcp://${HOST}:${HOST_PORT}`);
});

// 端口绑定失败（如 Windows 偶发 EACCES/端口被占）时不崩溃，重试
function retryBind(server, port, label) {
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" || e.code === "EACCES") {
      console.error(`[bridge] ${label} ${port} 绑定失败（${e.code}），1s 后重试`);
      setTimeout(() => retryBind(server, port, label), 1000);
    } else {
      console.error(`[bridge] ${label} ${port} 出错:`, e.message);
    }
  });
}
retryBind(cliServer, PORT, "CLI 端口");
retryBind(hostServer, HOST_PORT, "host 端口");

// 兜底：若 CLI 断开但命令没回，清掉等待，避免内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [id, cli] of pending) {
    if (cli.destroyed) pending.delete(id);
  }
}, 5000).unref();

process.on("SIGINT", () => process.exit(0));
