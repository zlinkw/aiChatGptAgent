"""Codex 设备授权流程封装。

OpenAI 在 2026 年 GPT-5.5 发布时给所有 ChatGPT 账号开放了 Codex API 通道
（包括 Free/Go），通过 OAuth Device Flow 完成绑定。

整套流程对 OpenAI 服务端来说是这样的：

    1. POST /api/accounts/deviceauth/usercode  client_id=<codex>
       → device_auth_id + user_code
    2. （可选）开"设备代码授权"开关
       PATCH /backend-api/settings/account_user_setting?feature=enable_device_code_auth&value=true
       Header: ChatGPT-Account-ID: <account_id>
    3. GET /codex/device?user_code=<code>&_data=routes/codex/device
       → continue_url（已嵌入服务端生成的 PKCE challenge）
    4. GET continue_url（已登录态会自动 silent 走完到 /deviceauth/callback）
    5. POST /api/accounts/deviceauth/token  device_auth_id+user_code
       → authorization_code + code_verifier
    6. POST /oauth/token  authorization_code grant
       → access_token + refresh_token + id_token

第 4 步是"已登录态"才能 silent 通过的关键 —— OpenAI 不允许用 refresh_token
重建 web session，所以这套流程必须**在密码登录之后立刻执行**（同一 session）。

模块对外只暴露一个函数 `obtain_codex_tokens(session)`，调用方负责保证 session
是已登录态（比如刚跑完 PlatformRegistrar 的注册流程）。
"""

from __future__ import annotations

import base64
import json
import time
from datetime import datetime, timezone
from typing import Any

# Codex CLI 在 OpenAI 这边注册的 OAuth client（从 codex Rust 源码反推）
CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_SCOPE = "openid profile email offline_access"

# OpenAI Auth0 域
_AUTH_BASE = "https://auth.openai.com"
_CHATGPT_BASE = "https://chatgpt.com"

# 这些是 device flow 协议端点
_USERCODE_URL = f"{_AUTH_BASE}/api/accounts/deviceauth/usercode"
_TOKEN_POLL_URL = f"{_AUTH_BASE}/api/accounts/deviceauth/token"
_TOKEN_EXCHANGE_URL = f"{_AUTH_BASE}/oauth/token"
_DEVICE_REDIRECT_URI = f"{_AUTH_BASE}/deviceauth/callback"
_DEVICE_PAGE_URL = f"{_AUTH_BASE}/codex/device"

# ChatGPT 设置 API（开启 enable_device_code_auth 开关用）
_SETTINGS_TOGGLE_URL = f"{_CHATGPT_BASE}/backend-api/settings/account_user_setting"
_ACCOUNTS_CHECK_URL = f"{_CHATGPT_BASE}/backend-api/accounts/check/v4-2023-04-27"


class CodexAuthError(RuntimeError):
    """Codex 授权流程任意一步失败时统一抛这个。"""


def _decode_jwt_payload(token: str) -> dict:
    if not token:
        return {}
    try:
        payload = token.split(".")[1]
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += "=" * padding
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}


def _get_chatgpt_account_id(session: Any, access_token: str) -> str:
    """从 chatgpt.com /accounts/check 拿到当前默认 chatgpt account_id。

    这个 ID 是 PATCH 设置开关时必须的请求头。如果拿不到就返回空串，
    上层可以选择跳过开关检查（部分号默认就开着）。
    """
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
    }
    try:
        resp = session.get(_ACCOUNTS_CHECK_URL, headers=headers, timeout=30)
        if resp.status_code != 200:
            return ""
        data = resp.json() if resp.content else {}
        ordering = data.get("account_ordering") or []
        accounts = data.get("accounts") or {}
        if isinstance(ordering, list) and ordering:
            return str(ordering[0])
        if isinstance(accounts, dict) and accounts:
            return next(iter(accounts.keys()))
    except Exception:
        return ""
    return ""


def enable_device_code_auth(session: Any, access_token: str, account_id: str = "") -> bool:
    """开启账号的"设备代码授权"开关。

    没传 account_id 时会自动去 /accounts/check 拿。返回 True/False 表示
    是否成功（找不到 account_id 也算失败但不抛）。
    """
    if not account_id:
        account_id = _get_chatgpt_account_id(session, access_token)
    if not account_id:
        return False
    headers = {
        "Authorization": f"Bearer {access_token}",
        "ChatGPT-Account-ID": account_id,
        "Accept": "application/json",
    }
    try:
        resp = session.patch(
            _SETTINGS_TOGGLE_URL,
            params={"feature": "enable_device_code_auth", "value": "true"},
            headers=headers,
            timeout=30,
        )
        return resp.status_code == 200
    except Exception:
        return False


def request_device_code(session: Any) -> dict:
    """第 1 步：调 /api/accounts/deviceauth/usercode 拿 device_auth_id + user_code。

    返回 {device_auth_id, user_code, interval, expires_at, verification_url}
    """
    resp = session.post(
        _USERCODE_URL,
        headers={"Content-Type": "application/json"},
        data=json.dumps({"client_id": CODEX_CLIENT_ID}),
        timeout=30,
    )
    if resp.status_code != 200:
        raise CodexAuthError(
            f"deviceauth/usercode failed http={resp.status_code} body={(getattr(resp,'text','') or '')[:200]}"
        )
    body = resp.json() if resp.content else {}
    user_code = str(body.get("user_code") or "").strip()
    device_auth_id = str(body.get("device_auth_id") or "").strip()
    if not user_code or not device_auth_id:
        raise CodexAuthError(f"deviceauth/usercode bad body: {body}")
    return {
        "device_auth_id": device_auth_id,
        "user_code": user_code,
        "interval": int(str(body.get("interval") or "5") or 5),
        "expires_at": str(body.get("expires_at") or ""),
        "verification_url": _DEVICE_PAGE_URL,
    }


def consent_silent(session: Any, user_code: str) -> bool:
    """第 3 + 4 步：用已登录 session 走完同意流程。

    1) 先 GET /codex/device?user_code=... 的 HTML 页（"暖一下" Cloudflare，
       让 session 拿到这个特定路径的 __cf_bm 等 cookies）
    2) GET /codex/device?_data=... 拿 continue_url
    3) GET continue_url，跟着重定向走到 /deviceauth/callback。

    成功的标志是最终落到 /deviceauth/callback 而不是 /log-in。
    """
    # 1) HTML 暖场（不带 _data）
    try:
        session.get(
            _DEVICE_PAGE_URL,
            params={"user_code": user_code},
            headers={"Accept": "text/html,application/xhtml+xml,*/*"},
            timeout=30,
        )
    except Exception:
        pass

    # 2) 拿 continue_url
    resp = session.get(
        _DEVICE_PAGE_URL,
        params={"user_code": user_code, "_data": "routes/codex/device"},
        headers={"Accept": "application/json"},
        timeout=30,
    )
    if resp.status_code != 200:
        raise CodexAuthError(
            f"loader failed http={resp.status_code} body={(getattr(resp,'text','') or '')[:200]}"
        )
    body = resp.json() if resp.content else {}
    continue_url = (
        body.get("continue_url")
        or body.get("page", {}).get("payload", {}).get("url", "")
    )
    if not continue_url:
        raise CodexAuthError(f"loader returned no continue_url, body={body}")

    # 2) 跟跳，最多 10 hop（auth flow 一般 3-5 hop）
    url = continue_url
    for _ in range(10):
        resp = session.get(url, allow_redirects=False, timeout=30)
        location = ""
        try:
            location = resp.headers.get("Location", "") or ""
        except Exception:
            location = ""
        # 命中 callback = 服务器内部已经把 device_auth_id mark 成已授权
        if "/deviceauth/callback" in location or "/deviceauth/callback" in str(getattr(resp, "url", "")):
            # 跟一下 callback 让服务器 finalize（一般是 302 → 一个成功页）
            try:
                session.get(
                    location if location else str(resp.url),
                    allow_redirects=True,
                    timeout=30,
                )
            except Exception:
                pass
            return True
        # 落到 /log-in 表示 session 不是登录态
        if "/log-in" in location or (resp.status_code == 200 and "/log-in" in (resp.text or "")[:5000]):
            raise CodexAuthError("silent consent failed: session not authenticated")
        if resp.status_code not in (301, 302, 303, 307, 308) or not location:
            break
        url = location if location.startswith("http") else f"{_AUTH_BASE}{location}"
    return False


def poll_for_authorization_code(
    session: Any, device_auth_id: str, user_code: str, interval: int = 5, max_attempts: int = 6
) -> dict:
    """第 5 步：轮询 /api/accounts/deviceauth/token 拿 authorization_code。

    silent consent 成功后这个端点立刻就返回 200，所以默认只轮询 6 次（30 秒），
    超时就抛 CodexAuthError。
    """
    last_status = 0
    last_body = ""
    for _ in range(max(1, max_attempts)):
        resp = session.post(
            _TOKEN_POLL_URL,
            headers={"Content-Type": "application/json"},
            data=json.dumps({"device_auth_id": device_auth_id, "user_code": user_code}),
            timeout=30,
        )
        last_status = resp.status_code
        last_body = (getattr(resp, "text", "") or "")[:200]
        if resp.status_code == 200:
            try:
                body = resp.json() if resp.content else {}
            except Exception:
                # 200 但不是 JSON（罕见，cloudflare 边缘情况）→ 当作 pending 重试
                time.sleep(max(1, interval))
                continue
            if body.get("authorization_code") and body.get("code_verifier"):
                return body
            # 200 但还没拿到 code（pending）→ 等下一次轮询
            time.sleep(max(1, interval))
            continue
        if resp.status_code in (403, 404):
            time.sleep(max(1, interval))
            continue
        # 其他错误状态（401/500/etc）直接抛
        if resp.status_code not in (200, 403, 404):
            raise CodexAuthError(
                f"deviceauth/token failed http={resp.status_code} body={last_body}"
            )
    raise CodexAuthError(f"deviceauth/token timeout, last={last_status} body={last_body}")


def exchange_code_for_codex_tokens(session: Any, authorization_code: str, code_verifier: str) -> dict:
    """第 6 步：用 authorization_code + code_verifier 换出 codex 自己的 access/refresh/id_token。"""
    resp = session.post(
        _TOKEN_EXCHANGE_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "grant_type": "authorization_code",
            "code": authorization_code,
            "redirect_uri": _DEVICE_REDIRECT_URI,
            "client_id": CODEX_CLIENT_ID,
            "code_verifier": code_verifier,
        },
        timeout=30,
    )
    if resp.status_code != 200:
        raise CodexAuthError(
            f"oauth/token failed http={resp.status_code} body={(getattr(resp,'text','') or '')[:200]}"
        )
    body = resp.json() if resp.content else {}
    if not body.get("access_token") or not body.get("refresh_token") or not body.get("id_token"):
        raise CodexAuthError(f"oauth/token bad body: {body}")
    return body


def obtain_codex_tokens(session: Any, access_token: str = "", account_id: str = "") -> dict:
    """端到端：在已登录 session 里跑完整 codex device flow 拿到 token。

    入参：
        session       —— 已登录态（建议刚跑过 PlatformRegistrar 流程的同一个 session）
        access_token  —— ChatGPT 主域 access_token，可选；用于自动开"设备代码授权"开关
        account_id    —— ChatGPT account UUID，可选；不传会自动拉

    返回：标准 CPA auth-file 格式的 dict
        {
          access_token, refresh_token, id_token,
          email, account_id,
          last_refresh, expired,
          type='codex', disabled=False,
        }
    """
    # 1) 开开关（可能已经开了，失败也继续 - 上一步可能已经 silent 流程能跑通）
    if access_token:
        enable_device_code_auth(session, access_token, account_id)

    # 优先使用传入的 session（注册流程的 session 已经过了 OAuth consent，
    # 带完整登录 cookies，OpenAI 给这个 session 放过 Cloudflare）。
    # 用这个 session 试一遍；如果 device-page loader 被 Cloudflare 拦了，
    # 自动 fallback 到 curl_cffi 浏览器指纹 session（继承 cookies + warmup）。
    last_error: CodexAuthError | None = None
    for attempt, flow_session in enumerate(_session_candidates(session, access_token)):
        try:
            device = request_device_code(flow_session)
            consent_silent(flow_session, device["user_code"])
            code_resp = poll_for_authorization_code(
                flow_session, device["device_auth_id"], device["user_code"], device["interval"]
            )
            tokens = exchange_code_for_codex_tokens(
                flow_session, code_resp["authorization_code"], code_resp["code_verifier"]
            )
            break  # 成功
        except CodexAuthError as exc:
            last_error = exc
            # 只要不是 silent 不通过的"会话失效"错误，下一种 session 重试
            if "session not authenticated" in str(exc):
                # 会话身份问题，换 session 也救不回来
                raise
            continue
    else:
        # 所有候选 session 都失败了
        raise last_error or CodexAuthError("all session candidates failed")

    # 5) 拼成 CPA auth-file 格式
    id_token = str(tokens.get("id_token") or "")
    payload = _decode_jwt_payload(id_token) or _decode_jwt_payload(str(tokens.get("access_token") or ""))
    oai_auth = payload.get("https://api.openai.com/auth") if isinstance(payload, dict) else {}
    if not isinstance(oai_auth, dict):
        oai_auth = {}
    email = str(payload.get("email") or "")
    chatgpt_account_id = str(oai_auth.get("chatgpt_account_id") or account_id or "")
    exp_ts = payload.get("exp")
    try:
        expired_iso = (
            datetime.fromtimestamp(int(exp_ts), tz=timezone.utc).isoformat() if exp_ts else ""
        )
    except Exception:
        expired_iso = ""

    return {
        "access_token": str(tokens.get("access_token") or ""),
        "refresh_token": str(tokens.get("refresh_token") or ""),
        "id_token": id_token,
        "email": email,
        "account_id": chatgpt_account_id,
        "expired": expired_iso,
        "last_refresh": datetime.now(timezone.utc).isoformat(),
        "disabled": False,
        "type": "codex",
    }


def _session_candidates(original_session: Any, access_token: str = "") -> "list[Any]":
    """按顺序生成 device flow 可用的候选 session。

    1) 原 session（如果带登录 cookie 优先用，OpenAI 的服务端可能给它放过 CF）
    2) 一个新建的 curl_cffi chrome 指纹 session（继承 cookies + warmup）

    每次循环上层都会试一遍直到有 session 跑通整个流程。
    """
    candidates: list[Any] = []
    # 原 session，但只在它已有登录态时尝试，避免浪费一次 device_code
    if _has_auth_session_cookies(original_session):
        candidates.append(original_session)

    # 浏览器指纹 session（兜底）
    cffi_session = _ensure_browserlike_session(original_session)
    if cffi_session is not original_session or not candidates:
        _warmup_for_cloudflare(cffi_session, access_token)
        candidates.append(cffi_session)
    return candidates


def _has_auth_session_cookies(session: Any) -> bool:
    """检查 session 在 auth.openai.com 上是否已经有登录态 cookie。

    `oai-client-auth-session` 和 `auth-session-minimized` 是登录态 cookie。
    """
    try:
        for cookie in session.cookies:
            if cookie.name in ("oai-client-auth-session", "auth-session-minimized"):
                return True
    except Exception:
        pass
    return False


def _ensure_browserlike_session(session: Any) -> Any:
    """如果已经是 curl_cffi 的 chrome 指纹 session 直接用；否则克隆 cookies 进新 session。

    特征：curl_cffi.requests.Session 有 .impersonate 属性。
    """
    if getattr(session, "impersonate", None):
        return session

    try:
        from curl_cffi import requests as cf_requests
    except ImportError:
        # 没有 curl_cffi 就回退（可能在某些部署环境下不存在）
        return session

    new_session = cf_requests.Session(impersonate="chrome", verify=False)
    # 把所有需要的域 cookie 复制过来。注册 session 用 requests.Session 时
    # session.cookies 是 RequestsCookieJar，迭代直接给 (name, value, domain, path)。
    try:
        for cookie in session.cookies:
            try:
                new_session.cookies.set(
                    cookie.name,
                    cookie.value,
                    domain=cookie.domain,
                    path=getattr(cookie, "path", "/") or "/",
                )
            except Exception:
                continue
    except Exception:
        pass
    # 复用 user-agent 等关键 header
    try:
        ua = session.headers.get("User-Agent") or session.headers.get("user-agent")
        if ua:
            new_session.headers["User-Agent"] = ua
        new_session.headers.setdefault("Accept-Language", "en-US,en;q=0.9")
    except Exception:
        pass
    return new_session


def _warmup_for_cloudflare(session: Any, access_token: str = "") -> None:
    """新 session 第一次请求 Cloudflare 保护的端点会被发 challenge。

    先发几个"无害"的 GET 让 CF 下发 __cf_bm cookie，后续请求就直通。
    所有错误都吞掉——这步只是预热，失败了让真正的请求自己处理。
    """
    warmup_targets = [
        # auth.openai.com 主域 + /codex/device 都需要 cf_bm cookie
        f"{_AUTH_BASE}/codex/device",
    ]
    if access_token:
        # 用 access_token 打 chatgpt.com /me 也能顺手种一份 cookie
        warmup_targets.append(f"{_CHATGPT_BASE}/backend-api/me")

    for url in warmup_targets:
        try:
            headers = {"Accept": "text/html,application/xhtml+xml,*/*"}
            if access_token and "chatgpt.com" in url:
                headers["Authorization"] = f"Bearer {access_token}"
            session.get(url, headers=headers, timeout=15, allow_redirects=True)
        except Exception:
            continue


def auth_file_path(auths_dir: Any, email: str, plan: str = "free") -> Any:
    """生成 cliproxy 期望的文件名: codex-{email}-{plan}.json。

    auths_dir 是 pathlib.Path。返回最终的文件 Path。
    """
    safe_email = (email or "unknown").replace("/", "_").replace("..", "_")
    return auths_dir / f"codex-{safe_email}-{plan}.json"
