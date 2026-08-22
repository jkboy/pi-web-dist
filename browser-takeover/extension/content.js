// browser-ctl content script：页面加载时唤醒后台 SW 并确保 host 连接。
// 用途：MV3 SW 是惰性的，不主动运行。本脚本在任何页面加载时向 SW 发消息，
// 让 SW 被唤醒并调用 connectNative，从而把 Native Messaging host 拉起并连上 bridge。
chrome.runtime.sendMessage({ type: "browserCtlPing" }).catch(() => {});
