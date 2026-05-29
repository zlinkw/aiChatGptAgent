function row(label, value, level = "ok") {
  const div = document.createElement("div");
  div.className = "row";
  const v = document.createElement("span");
  v.className = level;
  v.textContent = level === "ok" ? "✓" : level === "warn" ? "⚠" : "✗";
  div.appendChild(v);
  const t = document.createElement("span");
  t.innerHTML = `${label}: <span class="key">${value}</span>`;
  div.appendChild(t);
  return div;
}

async function getConfig() {
  return new Promise((r) => chrome.storage.local.get(null, r));
}

async function isAllowedInIncognito() {
  return new Promise((r) => chrome.extension.isAllowedIncognitoAccess?.((v) => r(v)) || r(null));
}

async function render() {
  const status = document.getElementById("status");
  status.innerHTML = "";

  const cfg = await getConfig();
  status.appendChild(
    row("Base URL", cfg.base_url || "(未填)", cfg.base_url ? "ok" : "err")
  );
  status.appendChild(
    row("Admin Key", cfg.admin_key ? `已填 (${cfg.admin_key.slice(0, 4)}...)` : "(未填)", cfg.admin_key ? "ok" : "err")
  );
  status.appendChild(row("自动填表", cfg.auto_login ? "开" : "关", cfg.auto_login ? "ok" : "warn"));
  status.appendChild(row("自动同意", cfg.auto_consent ? "开" : "关", cfg.auto_consent ? "ok" : "warn"));
  status.appendChild(row("自动关窗", cfg.auto_close ? "开" : "关", cfg.auto_close ? "ok" : "warn"));

  const incog = await isAllowedInIncognito();
  status.appendChild(
    row("隐身模式权限", incog ? "已开启" : (incog === false ? "未开启" : "未知"),
        incog ? "ok" : "err")
  );
}

document.getElementById("open_options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("test_api").addEventListener("click", async () => {
  const cfg = await getConfig();
  const out = document.getElementById("api_result");
  out.textContent = "测试中...";
  if (!cfg.base_url || !cfg.admin_key) {
    out.innerHTML = '<span class="err">需要先填 Base URL 和 Admin Key</span>';
    return;
  }
  try {
    const r = await fetch(`${cfg.base_url}/api/codex/pool/candidates`, {
      headers: { Authorization: `Bearer ${cfg.admin_key}` },
    });
    if (!r.ok) {
      out.innerHTML = `<span class="err">HTTP ${r.status}: ${await r.text()}</span>`;
      return;
    }
    const data = await r.json();
    const n = (data.items || []).length;
    out.innerHTML = `<span class="ok">✓ 连通，候选账号 ${n} 个</span>`;
  } catch (e) {
    out.innerHTML = `<span class="err">连接失败: ${e.message}</span>`;
  }
});

document.addEventListener("DOMContentLoaded", render);
