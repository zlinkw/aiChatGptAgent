// auth.openai.com 内容脚本 v2.5
// 自动登录 + 同意 codex 设备授权 + 关闭窗口
//
// ⚠️ v2.5 修复 account_deactivated 批量死号问题：
//   v2.4 里有个 while(true) tick(700ms) 的循环，密码填错或 React state 没同步时
//   会反复填同一个密码反复 submit，5 次以上失败 OpenAI 直接停号。
//   现在改成 **状态机**：每个动作（填邮箱 / 填密码 / 同意）只执行一次，
//   失败就停下来 badge 红字，绝不重试。剩下的让用户自己看。

(function () {
  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // 全局已执行标记 —— 一个 tab 内每件事只能做一次
  const DONE = {
    email: false,
    password: false,
    consent: false,
  };

  // 错误状态：一旦设了，就不再 tick，避免重试循环
  let HALTED = false;
  function halt(reason, color = "#ef4444") {
    if (HALTED) return;
    HALTED = true;
    badge(`✗ 已停止: ${reason}\n绝不再重试，避免封号`, color);
    console.error("[codex-assistant] HALT:", reason);
  }

  async function waitFor(sel, maxMs = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const el = $(sel);
      if (el && el.offsetParent !== null) return el;
      await sleep(120);
    }
    return null;
  }

  // 像真人一样逐字符输入
  async function typeLikeHuman(el, value) {
    el.focus();
    el.click();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(40);

    let acc = "";
    for (const ch of value) {
      acc += ch;
      setter.call(el, acc);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(15);
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function getUserCodeFromUrl() {
    const u = new URL(location.href);
    const q = u.searchParams.get("user_code");
    if (q) {
      sessionStorage.setItem("__codex_user_code", q.trim());
      return q.trim();
    }
    return sessionStorage.getItem("__codex_user_code") || "";
  }

  async function getUserCodeFromBackground() {
    return new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "getLatestUserCode" }, (resp) =>
        resolve((resp || {}).user_code || "")
      )
    );
  }

  async function resolveUserCode() {
    const fromUrl = getUserCodeFromUrl();
    if (fromUrl) return fromUrl;
    for (let i = 0; i < 15; i++) {
      const fromBg = await getUserCodeFromBackground();
      if (fromBg) {
        sessionStorage.setItem("__codex_user_code", fromBg);
        return fromBg;
      }
      await sleep(200);
    }
    return "";
  }

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
        maxWidth: "320px",
        whiteSpace: "pre-line",
      });
      document.body.appendChild(b);
    } else {
      b.style.background = color;
    }
    b.textContent = text;
    console.log(`[codex-assistant] ${text}`);
  }

  let CONFIG = null;
  let CRED = null;

  async function loadConfig() {
    return new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "getConfig" }, (resp) => resolve((resp || {}).config || null))
    );
  }

  async function fetchCredential() {
    const code = await resolveUserCode();
    if (!code) {
      badge("⚠️ 没拿到 user_code\nbackground/URL 都为空", "#f59e0b");
      return null;
    }
    return new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "claimCredential", user_code: code }, (resp) => {
        if (chrome.runtime.lastError) {
          badge(`✗ runtime error\n${chrome.runtime.lastError.message}`, "#ef4444");
          resolve(null);
          return;
        }
        if (!resp?.ok) {
          badge(`✗ claim 失败\n${(resp?.error || "未知").slice(0, 120)}`, "#ef4444");
          resolve(null);
          return;
        }
        resolve(resp.credential || null);
      })
    );
  }

  // 检测页面错误状态（密码错 / 验证码 / deactivated 等）
  // 任何一个匹配 → halt
  function detectErrorAndHalt() {
    const text = (document.body?.innerText || "").toLowerCase();
    if (/account_deactivated|账户已被删除或停用|account.*deactivated|account.*disabled/.test(text)) {
      halt("OpenAI 已停用此账号 (account_deactivated)\n手动登录也是一样，号已废，删除即可", "#ef4444");
      return true;
    }
    if (/incorrect.*password|password.*incorrect|密码不正确|wrong.*password/.test(text)) {
      halt("密码错误\n注册落库的密码与 OpenAI 实际密码不一致", "#ef4444");
      return true;
    }
    if (/too many.*attempts|rate.*limit|too many failed/.test(text)) {
      halt("失败次数过多 / 限流\n等几分钟再来", "#ef4444");
      return true;
    }
    if (/verification code|enter.*code.*sent.*email|输入.*验证码/.test(text)) {
      halt("OpenAI 要求输入邮箱验证码\n请到 mymail2026.xyz 后台查收并手动输入", "#f59e0b");
      return true;
    }
    if (/captcha|verify you are human|我不是机器人/i.test(text)) {
      halt("触发人机验证\n请手动完成验证", "#f59e0b");
      return true;
    }
    return false;
  }

  // ─── 单次动作：填邮箱 ───
  async function actEmailOnce() {
    if (DONE.email || HALTED) return;
    if (!CRED) return;
    const path = location.pathname;
    if (!/log-in|login/i.test(path)) return;

    const emailInput = $('input[type="email"], input[name="email"], input[name="username"]');
    if (!emailInput || emailInput.offsetParent === null) return;
    if (emailInput.value && emailInput.value.includes("@")) {
      DONE.email = true; // 已经填了（可能是浏览器自动填的），不重复
      return;
    }

    DONE.email = true; // ⚠️ 先设标记，再做事，防止竞态
    await typeLikeHuman(emailInput, CRED.email);
    badge(`📧 已填邮箱（一次性）\n${CRED.email}`);
    await sleep(500);
    const btn = $('button[type="submit"]') ||
      $$("button").find((b) => /^(continue|继续|next|下一步)$/i.test((b.textContent || "").trim()));
    if (btn) {
      btn.click();
      badge("✓ 点继续，等待密码页");
    } else {
      halt("找不到继续按钮", "#ef4444");
    }
  }

  // ─── 单次动作：填密码 ───
  async function actPasswordOnce() {
    if (DONE.password || HALTED) return;
    if (!CRED) return;

    const pwdInput = $('input[type="password"]');
    if (!pwdInput || pwdInput.offsetParent === null) return;
    if (pwdInput.value) {
      DONE.password = true;
      return;
    }

    DONE.password = true; // ⚠️ 先设标记，绝不重复填密码
    await typeLikeHuman(pwdInput, CRED.password);
    badge("🔑 已填密码（一次性，不再重试）");
    await sleep(500);
    const btn = $('button[type="submit"]') ||
      $$("button").find((b) => /^(continue|继续|sign in|登录|log in)$/i.test((b.textContent || "").trim()));
    if (btn) {
      btn.click();
      badge("✓ 提交登录（仅 1 次）");
    } else {
      halt("找不到登录按钮", "#ef4444");
    }
  }

  // ─── 单次动作：同意授权 ───
  async function actConsentOnce() {
    if (DONE.consent || HALTED) return;
    if (!/codex\/device/i.test(location.pathname)) return;

    const text = (document.body?.innerText || "").toLowerCase();

    // 已成功
    if (/已成功授权|successfully authorized|你可以关闭/.test(text)) {
      DONE.consent = true;
      badge("✅ 授权成功！1 秒后关窗", "#10b981");
      await sleep(1000);
      if (CONFIG?.auto_close) chrome.runtime.sendMessage({ type: "closeWindow" });
      return;
    }

    // 设备代码授权未启用
    if (/启用设备代码授权|enable device code/i.test(text)) {
      halt("此号未开'设备代码授权'\n登录 chatgpt.com → Settings → Security 打开", "#ef4444");
      return;
    }

    const buttons = $$("button:not([disabled])").concat($$('a[role="button"]'));
    const btn = buttons.find((b) => {
      const t = (b.textContent || "").trim().toLowerCase();
      return /^(continue|继续|allow|approve|同意|authorize|授权|确认)$/i.test(t);
    });
    if (btn) {
      DONE.consent = true; // ⚠️ 先设标记
      btn.click();
      badge("✓ 已点同意（一次性）");
    }
  }

  // 主循环 —— 但每个动作都有 DONE 守卫，绝不重复
  // 循环本身只是为了等待 DOM 异步加载（密码页是路由切换出来的）
  async function tick() {
    if (HALTED) return;
    try {
      // 错误检测优先级最高
      if (detectErrorAndHalt()) return;

      // 同意页：当前在 codex/device
      if (/codex\/device/i.test(location.pathname)) {
        await actConsentOnce();
        return;
      }
      // 登录页：先邮箱后密码
      if (/log-in|login/i.test(location.pathname)) {
        // 密码框存在 → 当前是密码页（OpenAI 路由切到第二步了）
        if ($('input[type="password"]')) {
          await actPasswordOnce();
          return;
        }
        // 否则是邮箱页
        await actEmailOnce();
        return;
      }
    } catch (e) {
      console.warn("[codex-assistant] tick error:", e);
    }
  }

  async function main() {
    badge("🤖 助手启动中 v2.5");

    CONFIG = await loadConfig();
    if (!CONFIG) {
      badge("⚠️ 扩展未配置，点扩展图标→选项", "#ef4444");
      return;
    }
    if (!CONFIG.admin_key) {
      badge("⚠️ 未填 Admin Key", "#ef4444");
      return;
    }
    if (!CONFIG.auto_login && !CONFIG.auto_consent) {
      badge("ℹ️ 自动开关都关了，纯手动模式", "#f59e0b");
      return;
    }

    const codeForBadge = (await resolveUserCode()) || "(无)";
    badge(`🤖 已配置 v2.5\nbase=${CONFIG.base_url}\nuser_code=${codeForBadge}`);
    await sleep(800);

    CRED = await fetchCredential();
    if (CRED) {
      badge(`📧 锁定账号\n${CRED.email}`);
    } else {
      badge("⚠️ 没拿到候选账号", "#f59e0b");
      // 没拿到凭据也不退出，让用户能手动登录后扩展只处理同意按钮
    }

    // 状态机循环：DONE 守卫保证每件事只做一次
    // HALTED 守卫保证报错后不再 tick
    while (!HALTED) {
      await tick();
      await sleep(700);
      // 三件事都做完了 → 退出循环（codex/device 上等关窗）
      if (DONE.email && DONE.password && DONE.consent) {
        break;
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
