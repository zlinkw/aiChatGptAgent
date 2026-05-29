// 在 Codex 号池页面（localhost:3001 等）注入。
// 拦截所有指向 https://auth.openai.com/codex/device 的链接点击，
// 改成发消息让 background.js 打开隐私窗口。

(function () {
  function isCodexAuthLink(url) {
    if (!url) return false;
    try {
      const u = new URL(url, location.href);
      return u.hostname === "auth.openai.com" && u.pathname.startsWith("/codex/device");
    } catch {
      return false;
    }
  }

  function findAnchor(target) {
    let node = target;
    while (node && node.nodeType === 1) {
      if (node.tagName === "A" && node.href) return node;
      node = node.parentElement;
    }
    return null;
  }

  document.addEventListener(
    "click",
    function (e) {
      const a = findAnchor(e.target);
      if (!a) return;
      if (!isCodexAuthLink(a.href)) return;
      // 拦截
      e.preventDefault();
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: "openIncognito", url: a.href }, function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            // 扩展挂了，退化成普通新标签
            window.open(a.href, "_blank", "noopener,noreferrer");
          }
        });
      } catch {
        window.open(a.href, "_blank", "noopener,noreferrer");
      }
    },
    true // capture 阶段，比 React onClick 先触发
  );

  // 给页面加个小标记，证明扩展生效（用户能看到）
  function tag() {
    if (document.getElementById("__codex_incognito_badge")) return;
    if (!document.body) return;
    const badge = document.createElement("div");
    badge.id = "__codex_incognito_badge";
    badge.textContent = "🕵️ 无痕授权助手已启用";
    Object.assign(badge.style, {
      position: "fixed",
      bottom: "12px",
      right: "12px",
      zIndex: 999999,
      padding: "6px 10px",
      background: "rgba(124,58,237,0.92)",
      color: "white",
      fontSize: "12px",
      fontWeight: "600",
      borderRadius: "6px",
      boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
      pointerEvents: "none",
    });
    document.body.appendChild(badge);
    // 5 秒后淡出
    setTimeout(() => {
      badge.style.transition = "opacity .8s";
      badge.style.opacity = "0";
      setTimeout(() => badge.remove(), 1200);
    }, 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tag);
  } else {
    tag();
  }
})();
