// chatgpt.com 内容脚本：
//   - 第一次扫码遇到"必须先在安全设置里开'设备代码授权'"被拦的情况
//     用户被踢到 chatgpt.com → settings → security
//     这里检测开关，如果是关的就用 ChatGPT 网页 PATCH API 帮它开
//
// 这个脚本主要做兜底；多数情况下扩展里直接调 background API 帮你处理就行。
// 这里就提示一下，不要乱动用户的 chatgpt 设置（避免误关其他号）。

(function () {
  // 只在 settings 路径里激活，避免在普通聊天页瞎动
  if (!/settings|security/i.test(location.href)) return;

  function badge(text, color = "#7c3aed") {
    let b = document.getElementById("__codex_assistant_badge");
    if (!b) {
      b = document.createElement("div");
      b.id = "__codex_assistant_badge";
      Object.assign(b.style, {
        position: "fixed",
        top: "12px",
        right: "12px",
        zIndex: 999999,
        padding: "8px 12px",
        background: color,
        color: "white",
        fontSize: "12px",
        fontWeight: "600",
        borderRadius: "6px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
        pointerEvents: "none",
        maxWidth: "300px",
      });
      document.body.appendChild(b);
    } else {
      b.style.background = color;
    }
    b.textContent = text;
  }

  badge("ℹ️ 在安全设置：把'为 Codex 启用设备代码授权'打开后回到 auth 页继续");
})();
