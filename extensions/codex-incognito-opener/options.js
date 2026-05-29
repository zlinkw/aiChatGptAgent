const DEFAULTS = {
  base_url: "http://127.0.0.1:3001",
  admin_key: "",
  auto_login: true,
  auto_consent: true,
  auto_close: true,
  use_incognito: false,
};

function load() {
  chrome.storage.local.get(DEFAULTS, (data) => {
    document.getElementById("base_url").value = data.base_url || DEFAULTS.base_url;
    document.getElementById("admin_key").value = data.admin_key || "";
    document.getElementById("auto_login").checked = !!data.auto_login;
    document.getElementById("auto_consent").checked = !!data.auto_consent;
    document.getElementById("auto_close").checked = !!data.auto_close;
    document.getElementById("use_incognito").checked = !!data.use_incognito;
  });
}

function save() {
  const base_url = document.getElementById("base_url").value.trim().replace(/\/+$/, "");
  const admin_key = document.getElementById("admin_key").value.trim();
  const data = {
    base_url: base_url || DEFAULTS.base_url,
    admin_key,
    auto_login: document.getElementById("auto_login").checked,
    auto_consent: document.getElementById("auto_consent").checked,
    auto_close: document.getElementById("auto_close").checked,
    use_incognito: document.getElementById("use_incognito").checked,
  };
  chrome.storage.local.set(data, () => {
    const status = document.getElementById("status");
    status.textContent = "✓ 已保存";
    status.className = "ok";
    setTimeout(() => (status.textContent = ""), 2000);
  });
}

document.addEventListener("DOMContentLoaded", load);
document.getElementById("save").addEventListener("click", save);
