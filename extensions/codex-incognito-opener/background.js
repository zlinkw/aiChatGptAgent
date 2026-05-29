// service worker
//
// 主要工作：
//   1. 拦截 codex-pool 页面"打开授权页"点击 → 先清 OpenAI 相关 cookie/cache → 再开新窗口
//   2. 给 auth.openai.com 内容脚本提供配置 + 凭据查询代理
//   3. 收到关窗请求时把当前 tab/window 关掉

const DEFAULTS = {
  base_url: "http://127.0.0.1:3001",
  admin_key: "",
  auto_login: true,
  auto_consent: true,
  auto_close: true,
  use_incognito: false, // v2.2 起默认普通窗口 + 清 cookie；要的话可以打开
};

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (data) => resolve(data));
  });
}

// 清掉所有跟 OpenAI 相关的 cookie（auth.openai.com / chatgpt.com / *.openai.com）
async function clearOpenaiCookies() {
  const origins = [
    "https://auth.openai.com",
    "https://chatgpt.com",
    "https://platform.openai.com",
    "https://openai.com",
    "https://accounts.openai.com",
    "https://auth0.openai.com",
  ];
  try {
    await chrome.browsingData.remove(
      { origins },
      { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true }
    );
    console.log("[codex-bg] cleared cookies for", origins.join(", "));
  } catch (e) {
    console.warn("[codex-bg] clear cookies failed", e);
    // 退化方案：逐个 cookie 删
    try {
      const all = await chrome.cookies.getAll({ domain: ".openai.com" });
      const all2 = await chrome.cookies.getAll({ domain: ".chatgpt.com" });
      for (const c of [...all, ...all2]) {
        const proto = c.secure ? "https" : "http";
        await chrome.cookies.remove({
          url: `${proto}://${c.domain.replace(/^\./, "")}${c.path}`,
          name: c.name,
          storeId: c.storeId,
        });
      }
      console.log("[codex-bg] removed", all.length + all2.length, "cookies fallback");
    } catch (ee) {
      console.warn("[codex-bg] fallback cookie clear failed", ee);
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "openIncognito" && typeof message.url === "string") {
    (async () => {
      const cfg = await getConfig();
      // 每次打开都先清掉 OpenAI 系列 cookie，避免多账号串
      await clearOpenaiCookies();

      // 解析 user_code 存进 chrome.storage，方便 auth content script 读取
      // （OpenAI 的 device 页可能重定向把 user_code 从 URL 里丢掉，
      // 用 storage 兜底永远拿得到）
      let userCode = "";
      try {
        const u = new URL(message.url);
        userCode = u.searchParams.get("user_code") || "";
      } catch (_) {}

      const opts = { url: message.url, focused: true };
      if (cfg.use_incognito) opts.incognito = true;

      chrome.windows.create(opts, async (win) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        // 把 user_code 存到 storage，给新窗口的 content_auth.js 用
        if (userCode) {
          try {
            await chrome.storage.local.set({
              [`pending_user_code_${win.id}`]: userCode,
              latest_user_code: userCode,
            });
          } catch (_) {}
        }
        sendResponse({ ok: true, windowId: win?.id || 0 });
      });
    })();
    return true;
  }

  if (message?.type === "getConfig") {
    getConfig().then((cfg) => sendResponse({ ok: true, config: cfg }));
    return true;
  }

  if (message?.type === "getLatestUserCode") {
    chrome.storage.local.get(["latest_user_code"], (data) => {
      sendResponse({ ok: true, user_code: data.latest_user_code || "" });
    });
    return true;
  }

  if (message?.type === "claimCredential") {
    (async () => {
      try {
        const cfg = await getConfig();
        if (!cfg.base_url || !cfg.admin_key) {
          sendResponse({ ok: false, error: "扩展未配置 base_url / admin_key" });
          return;
        }
        const resp = await fetch(`${cfg.base_url}/api/codex/pool/login/claim-credential`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.admin_key}`,
          },
          body: JSON.stringify({ user_code: message.user_code }),
        });
        if (!resp.ok) {
          sendResponse({ ok: false, error: `HTTP ${resp.status}: ${await resp.text()}` });
          return;
        }
        const data = await resp.json();
        sendResponse({ ok: true, credential: data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  // 关闭当前窗口（auth.openai.com 同意完用）
  if (message?.type === "closeWindow") {
    if (sender?.tab?.windowId) {
      chrome.windows.remove(sender.tab.windowId);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: "no windowId" });
    }
    return true;
  }
});
