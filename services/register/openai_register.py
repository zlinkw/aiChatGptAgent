from __future__ import annotations

import base64
import hashlib
import json
import random
import secrets
import string
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import requests
import urllib3
from curl_cffi import requests as curl_requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from services.account_service import account_service
from services.register import mail_provider
from services.register import sms_provider

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
base_dir = Path(__file__).resolve().parent
config = {
    "mail": {
        "request_timeout": 30,
        "wait_timeout": 30,
        "wait_interval": 2,
        "providers": [],
    },
    "proxy": "",
    "proxy_pool": {},
    "total": 10,
    "threads": 3,
}
register_config_file = base_dir.parents[1] / "data" / "register.json"
try:
    saved_config = json.loads(register_config_file.read_text(encoding="utf-8"))
    config.update({key: saved_config[key] for key in ("mail", "proxy", "proxy_pool", "total", "threads") if key in saved_config})
except Exception:
    pass


# ─── IP 池管理 ───────────────────────────────────────────────────────────────
_proxy_pool_counter = 0
_proxy_pool_lock = threading.Lock()
_api_proxy_list: list[str] = []
_api_proxy_index = 0
_api_proxy_last_fetch = 0.0


def _fetch_api_proxies(api_url: str, protocol: str = "http") -> list[str]:
    """调用 711Proxy API URL 提取代理 IP 列表。"""
    try:
        resp = requests.get(api_url, timeout=15, verify=False)
        if resp.status_code != 200:
            log(f"[代理池API] 请求失败 HTTP {resp.status_code}", "yellow")
            return []
        lines = [line.strip() for line in resp.text.strip().splitlines() if line.strip()]
        proxies = []
        for line in lines:
            # 格式可能是 ip:port 或 ip:port:user:pass
            parts = line.split(":")
            if len(parts) == 2:
                # ip:port（白名单模式，无需认证）
                proxies.append(f"{protocol}://{parts[0]}:{parts[1]}")
            elif len(parts) == 4:
                # ip:port:user:pass
                proxies.append(f"{protocol}://{parts[2]}:{parts[3]}@{parts[0]}:{parts[1]}")
            elif len(parts) >= 2:
                # 尝试当作 host:port
                proxies.append(f"{protocol}://{parts[0]}:{parts[1]}")
        if proxies:
            log(f"[代理池API] 成功提取 {len(proxies)} 个代理", "green")
        return proxies
    except Exception as e:
        log(f"[代理池API] 请求异常: {e}", "yellow")
        return []


def _build_proxy_from_pool() -> str:
    """从 proxy_pool 配置生成一个代理 URL。

    支持两种模式：
    1. 用户名/密码模式（mode="userpass"）：通过 session ID 实现每任务不同 IP
    2. API URL 模式（mode="api"）：调接口提取 IP 列表，轮询使用

    proxy_pool 配置格式:
    {
        "enabled": true,
        "mode": "userpass",           // "userpass" 或 "api"
        // --- userpass 模式字段 ---
        "host": "proxy.711proxy.com",
        "port": 1000,
        "username": "your_username",
        "password": "your_password",
        "protocol": "http",           // 可选，默认 http，支持 http/socks5
        "session_prefix": "session-", // 可选，默认 session-
        "extra_params": "",           // 可选，附加到 username 的额外参数
        // --- api 模式字段 ---
        "api_url": "https://...",     // 711Proxy 生成的提取 URL
        "api_protocol": "http",       // 提取到的 IP 用什么协议连接
        "api_refresh_seconds": 300    // 多久重新提取一次（秒），默认 300
    }
    """
    global _api_proxy_list, _api_proxy_index, _api_proxy_last_fetch

    pool_cfg = config.get("proxy_pool") or {}
    if not pool_cfg or not pool_cfg.get("enabled"):
        return str(config.get("proxy") or "").strip()

    mode = str(pool_cfg.get("mode") or "userpass").strip()

    # ─── API URL 模式 ───
    if mode == "api":
        api_url = str(pool_cfg.get("api_url") or "").strip()
        if not api_url:
            log("[代理池] API URL 为空，回退到单代理模式", "yellow")
            return str(config.get("proxy") or "").strip()

        api_protocol = str(pool_cfg.get("api_protocol") or "http").strip()
        refresh_seconds = max(60, int(pool_cfg.get("api_refresh_seconds") or 300))

        with _proxy_pool_lock:
            now = time.time()
            # 如果列表为空或超过刷新间隔，重新提取
            if not _api_proxy_list or (now - _api_proxy_last_fetch) > refresh_seconds:
                new_list = _fetch_api_proxies(api_url, api_protocol)
                if new_list:
                    _api_proxy_list = new_list
                    _api_proxy_index = 0
                    _api_proxy_last_fetch = now
                elif not _api_proxy_list:
                    log("[代理池API] 无可用代理，回退到单代理模式", "yellow")
                    return str(config.get("proxy") or "").strip()

            # 轮询取一个
            proxy = _api_proxy_list[_api_proxy_index % len(_api_proxy_list)]
            _api_proxy_index += 1
            return proxy

    # ─── 用户名/密码模式 ───
    host = str(pool_cfg.get("host") or "").strip()
    port = str(pool_cfg.get("port") or "").strip()
    username = str(pool_cfg.get("username") or "").strip()
    password = str(pool_cfg.get("password") or "").strip()
    protocol = str(pool_cfg.get("protocol") or "http").strip()
    session_prefix = str(pool_cfg.get("session_prefix") or "session-").strip()
    extra_params = str(pool_cfg.get("extra_params") or "").strip()

    if not host or not port or not username or not password:
        log("[代理池] 配置不完整，回退到单代理模式", "yellow")
        return str(config.get("proxy") or "").strip()

    # 生成 8 位随机 session ID，确保每个注册任务用不同 IP
    session_id = "".join(random.choices(string.digits, k=8))
    full_username = f"{username}{extra_params}-{session_prefix}{session_id}"

    proxy_url = f"{protocol}://{full_username}:{password}@{host}:{port}"
    return proxy_url

auth_base = "https://auth.openai.com"
platform_base = "https://platform.openai.com"
platform_oauth_client_id = "app_2SKx67EdpoN0G6j64rFvigXD"
platform_oauth_redirect_uri = f"{platform_base}/auth/callback"
platform_oauth_audience = "https://api.openai.com/v1"
platform_auth0_client = "eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjEuMjEuMCJ9"
user_agent = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/145.0.0.0 Safari/537.36"
)
sec_ch_ua = '"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"'
sec_ch_ua_full_version_list = '"Chromium";v="145.0.0.0", "Not:A-Brand";v="99.0.0.0", "Google Chrome";v="145.0.0.0"'
default_timeout = 60
print_lock = threading.Lock()
stats_lock = threading.Lock()
stats = {"done": 0, "success": 0, "fail": 0, "start_time": 0.0}
register_log_sink = None

common_headers = {
    "accept": "application/json",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    "origin": auth_base,
    "priority": "u=1, i",
    "user-agent": user_agent,
    "sec-ch-ua": sec_ch_ua,
    "sec-ch-ua-arch": '"x86_64"',
    "sec-ch-ua-bitness": '"64"',
    "sec-ch-ua-full-version-list": sec_ch_ua_full_version_list,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-model": '""',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-platform-version": '"10.0.0"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
}

navigate_headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": user_agent,
    "sec-ch-ua": sec_ch_ua,
    "sec-ch-ua-arch": '"x86_64"',
    "sec-ch-ua-bitness": '"64"',
    "sec-ch-ua-full-version-list": sec_ch_ua_full_version_list,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-model": '""',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-platform-version": '"10.0.0"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
}


def log(text: str, color: str = "") -> None:
    colors = {"red": "\033[31m", "green": "\033[32m", "yellow": "\033[33m"}
    if register_log_sink:
        try:
            register_log_sink(text, color)
        except Exception:
            pass
    with print_lock:
        prefix = colors.get(color, "")
        suffix = "\033[0m" if prefix else ""
        print(f"{prefix}{datetime.now().strftime('%H:%M:%S')} {text}{suffix}")


def step(index: int, text: str, color: str = "") -> None:
    log(f"[任务{index}] {text}", color)


def _make_trace_headers() -> dict[str, str]:
    trace_id = str(random.getrandbits(64))
    parent_id = str(random.getrandbits(64))
    return {
        "traceparent": f"00-{uuid.uuid4().hex}-{format(int(parent_id), '016x')}-01",
        "tracestate": "dd=s:1;o:rum",
        "x-datadog-origin": "rum",
        "x-datadog-parent-id": parent_id,
        "x-datadog-sampling-priority": "1",
        "x-datadog-trace-id": trace_id,
    }


def _generate_pkce() -> tuple[str, str]:
    code_verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).rstrip(b"=").decode("ascii")
    code_challenge = base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


def _random_password(length: int = 16) -> str:
    chars = string.ascii_letters + string.digits + "!@#$%"
    value = list(
        secrets.choice(string.ascii_uppercase)
        + secrets.choice(string.ascii_lowercase)
        + secrets.choice(string.digits)
        + secrets.choice("!@#$%")
        + "".join(secrets.choice(chars) for _ in range(max(0, length - 4)))
    )
    random.shuffle(value)
    return "".join(value)


def _random_name() -> tuple[str, str]:
    return random.choice(["James", "Robert", "John", "Michael", "David", "Mary", "Emma", "Olivia"]), random.choice(
        ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller"]
    )


def _random_birthdate() -> str:
    return f"{random.randint(1996, 2006):04d}-{random.randint(1, 12):02d}-{random.randint(1, 28):02d}"


def _response_json(resp) -> dict:
    try:
        data = resp.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _decode_jwt_payload(token: str) -> dict:
    try:
        payload = token.split(".")[1]
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += "=" * padding
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}


def create_mailbox(username: str | None = None) -> dict:
    return mail_provider.create_mailbox(config["mail"], username)


def wait_for_code(mailbox: dict) -> str | None:
    return mail_provider.wait_for_code(config["mail"], mailbox)


class SentinelTokenGenerator:
    MAX_ATTEMPTS = 500000
    ERROR_PREFIX = "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D"

    def __init__(self, device_id: str, ua: str):
        self.device_id = device_id
        self.user_agent = ua
        self.sid = str(uuid.uuid4())

    @staticmethod
    def _fnv1a_32(text: str) -> str:
        h = 2166136261
        for ch in text:
            h ^= ord(ch)
            h = (h * 16777619) & 0xFFFFFFFF
        h ^= h >> 16
        h = (h * 2246822507) & 0xFFFFFFFF
        h ^= h >> 13
        h = (h * 3266489909) & 0xFFFFFFFF
        h ^= h >> 16
        return format(h & 0xFFFFFFFF, "08x")

    def _get_config(self) -> list:
        perf_now = random.uniform(1000, 50000)
        return [
            "1920x1080",
            time.strftime("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)", time.gmtime()),
            4294705152,
            random.random(),
            self.user_agent,
            "https://sentinel.openai.com/sentinel/20260124ceb8/sdk.js",
            None,
            None,
            "en-US",
            random.random(),
            random.choice(["vendorSub-undefined", "plugins-undefined", "mimeTypes-undefined", "hardwareConcurrency-undefined"]),
            random.choice(["location", "implementation", "URL", "documentURI", "compatMode"]),
            random.choice(["Object", "Function", "Array", "Number", "parseFloat", "undefined"]),
            perf_now,
            self.sid,
            "",
            random.choice([4, 8, 12, 16]),
            time.time() * 1000 - perf_now,
        ]

    @staticmethod
    def _b64(data) -> str:
        return base64.b64encode(json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).decode("ascii")

    def generate_requirements_token(self) -> str:
        data = self._get_config()
        data[3] = 1
        data[9] = round(random.uniform(5, 50))
        return "gAAAAAC" + self._b64(data)

    def generate_token(self, seed: str, difficulty: str) -> str:
        start = time.time()
        data = self._get_config()
        difficulty = str(difficulty or "0")
        for i in range(self.MAX_ATTEMPTS):
            data[3] = i
            data[9] = round((time.time() - start) * 1000)
            payload = self._b64(data)
            if self._fnv1a_32(seed + payload)[: len(difficulty)] <= difficulty:
                return "gAAAAAB" + payload + "~S"
        return "gAAAAAB" + self.ERROR_PREFIX + self._b64(str(None))


def build_sentinel_token(session: requests.Session, device_id: str, flow: str) -> str:
    generator = SentinelTokenGenerator(device_id, user_agent)
    resp = session.post(
        "https://sentinel.openai.com/backend-api/sentinel/req",
        data=json.dumps({"p": generator.generate_requirements_token(), "id": device_id, "flow": flow}),
        headers={
            "Content-Type": "text/plain;charset=UTF-8",
            "Referer": "https://sentinel.openai.com/backend-api/sentinel/frame.html",
            "Origin": "https://sentinel.openai.com",
            "User-Agent": user_agent,
            "sec-ch-ua": sec_ch_ua,
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
        },
        timeout=60,
        verify=False,
    )
    data = _response_json(resp)
    token = str(data.get("token") or "").strip()
    if resp.status_code != 200 or not token:
        raise RuntimeError(f"sentinel_req_failed_{resp.status_code}")
    pow_data = data.get("proofofwork") or {}
    p_value = (
        generator.generate_token(str(pow_data.get("seed") or ""), str(pow_data.get("difficulty") or "0"))
        if pow_data.get("required") and pow_data.get("seed")
        else generator.generate_requirements_token()
    )
    return json.dumps({"p": p_value, "t": "", "c": token, "id": device_id, "flow": flow}, separators=(",", ":"))


def _is_socks_proxy(proxy: str) -> bool:
    candidate = str(proxy or "").strip().lower()
    return candidate.startswith("socks5://") or candidate.startswith("socks5h://")


def create_session(proxy: str = "") -> Any:
    if _is_socks_proxy(proxy):
        return curl_requests.Session(impersonate="chrome", verify=False, proxy=proxy)
    session = requests.Session()
    retry = Retry(total=2, connect=2, read=2, backoff_factor=0.5, status_forcelist=(429, 500, 502, 503, 504))
    adapter = HTTPAdapter(max_retries=retry, pool_connections=50, pool_maxsize=50)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.verify = False
    if proxy:
        session.proxies.update({"http": proxy, "https": proxy})
    return session


def request_with_local_retry(session: requests.Session, method: str, url: str, retry_attempts: int = 3, **kwargs):
    last_error = ""
    for _ in range(max(1, retry_attempts)):
        try:
            return session.request(method.upper(), url, timeout=default_timeout, **kwargs), ""
        except Exception as error:
            last_error = str(error)
            time.sleep(1)
    return None, last_error


def validate_otp(session: requests.Session, device_id: str, code: str):
    headers = dict(common_headers)
    headers["referer"] = f"{auth_base}/email-verification"
    headers["oai-device-id"] = device_id
    headers.update(_make_trace_headers())
    resp, error = request_with_local_retry(session, "post", f"{auth_base}/api/accounts/email-otp/validate", json={"code": code}, headers=headers, verify=False)
    if resp is not None and resp.status_code == 200:
        return resp, ""
    headers["openai-sentinel-token"] = build_sentinel_token(session, device_id, "authorize_continue")
    resp, error = request_with_local_retry(session, "post", f"{auth_base}/api/accounts/email-otp/validate", json={"code": code}, headers=headers, verify=False)
    return resp, error


def extract_oauth_callback_params_from_url(url: str) -> dict[str, str] | None:
    if not url:
        return None
    try:
        params = parse_qs(urlparse(url).query)
    except Exception:
        return None
    code = str((params.get("code") or [""])[0]).strip()
    if not code:
        return None
    return {"code": code, "state": str((params.get("state") or [""])[0]).strip(), "scope": str((params.get("scope") or [""])[0]).strip()}


def extract_oauth_callback_params_from_consent_session(session: requests.Session, consent_url: str, device_id: str) -> dict[str, str] | None:
    if consent_url.startswith("/"):
        consent_url = f"{auth_base}{consent_url}"
    current_url = consent_url
    for _ in range(10):
        response = session.get(current_url, headers=navigate_headers, verify=False, timeout=30, allow_redirects=False)
        callback_params = extract_oauth_callback_params_from_url(str(response.url)) or extract_oauth_callback_params_from_url(str(response.headers.get("Location") or "").strip())
        if callback_params:
            return callback_params
        location = str(response.headers.get("Location") or "").strip()
        if response.status_code not in (301, 302, 303, 307, 308) or not location:
            break
        current_url = f"{auth_base}{location}" if location.startswith("/") else location
    raw = session.cookies.get("oai-client-auth-session", domain=".auth.openai.com") or session.cookies.get("oai-client-auth-session")
    if not raw:
        return None
    try:
        first_part = raw.split(".")[0]
        padding = 4 - len(first_part) % 4
        if padding != 4:
            first_part += "=" * padding
        payload = json.loads(base64.urlsafe_b64decode(first_part))
        workspace_id = payload["workspaces"][0]["id"]
    except Exception:
        return None
    headers = dict(common_headers)
    headers["referer"] = consent_url
    headers["oai-device-id"] = device_id
    headers.update(_make_trace_headers())
    ws_resp = session.post(f"{auth_base}/api/accounts/workspace/select", json={"workspace_id": workspace_id}, headers=headers, verify=False, timeout=30, allow_redirects=False)
    callback_params = extract_oauth_callback_params_from_url(str(ws_resp.headers.get("Location") or "").strip())
    if callback_params:
        return callback_params
    ws_data = _response_json(ws_resp)
    orgs = ((ws_data.get("data") or {}).get("orgs") or []) if isinstance(ws_data, dict) else []
    if not orgs:
        return None
    org_id = str((orgs[0] or {}).get("id") or "").strip()
    project_id = str(((orgs[0] or {}).get("projects") or [{}])[0].get("id") or "").strip()
    if not org_id:
        return None
    org_headers = dict(common_headers)
    org_headers["referer"] = str(ws_data.get("continue_url") or consent_url)
    org_headers["oai-device-id"] = device_id
    org_headers.update(_make_trace_headers())
    body = {"org_id": org_id}
    if project_id:
        body["project_id"] = project_id
    org_resp = session.post(f"{auth_base}/api/accounts/organization/select", json=body, headers=org_headers, verify=False, timeout=30, allow_redirects=False)
    return extract_oauth_callback_params_from_url(str(org_resp.headers.get("Location") or "").strip())


def exchange_platform_tokens(session: requests.Session, device_id: str, code_verifier: str, consent_url: str) -> dict | None:
    callback_params = extract_oauth_callback_params_from_consent_session(session, consent_url, device_id)
    if not callback_params:
        return None
    code = str(callback_params.get("code") or "").strip()
    if not code:
        return None
    last_error = ""
    resp = None
    for _ in range(3):
        try:
            resp = session.post(
                f"{auth_base}/oauth/token",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": platform_oauth_redirect_uri,
                    "client_id": platform_oauth_client_id,
                    "code_verifier": code_verifier,
                },
                verify=False,
                timeout=60,
            )
            break
        except Exception as error:
            last_error = str(error)
            time.sleep(1)
            resp = None
    if resp is None:
        log(f"oauth_token 请求失败: {last_error}", "red")
        return None
    data = _response_json(resp)
    if resp.status_code != 200 or not data.get("access_token") or not data.get("refresh_token") or not data.get("id_token"):
        return None
    payload = _decode_jwt_payload(str(data.get("id_token") or "")) or _decode_jwt_payload(str(data.get("access_token") or ""))
    return {
        "email": str(payload.get("email") or "").strip(),
        "access_token": str(data.get("access_token") or "").strip(),
        "refresh_token": str(data.get("refresh_token") or "").strip(),
        "id_token": str(data.get("id_token") or "").strip(),
    }


class PlatformRegistrar:
    def __init__(self, proxy: str = "") -> None:
        self.session = create_session(proxy)
        self.device_id = str(uuid.uuid4())
        self._code_verifier = ""

    def close(self) -> None:
        self.session.close()

    def _navigate_headers(self, referer: str = "") -> dict[str, str]:
        headers = dict(navigate_headers)
        if referer:
            headers["referer"] = referer
        return headers

    def _json_headers(self, referer: str) -> dict[str, str]:
        headers = dict(common_headers)
        headers["referer"] = referer
        headers["oai-device-id"] = self.device_id
        headers.update(_make_trace_headers())
        return headers

    def _platform_authorize(self, email: str, index: int) -> None:
        step(index, "开始 platform authorize")
        self.session.cookies.set("oai-did", self.device_id, domain=".auth.openai.com")
        self.session.cookies.set("oai-did", self.device_id, domain="auth.openai.com")
        code_verifier, code_challenge = _generate_pkce()
        self._code_verifier = code_verifier
        params = {
            "issuer": auth_base,
            "client_id": platform_oauth_client_id,
            "audience": platform_oauth_audience,
            "redirect_uri": platform_oauth_redirect_uri,
            "device_id": self.device_id,
            "screen_hint": "login_or_signup",
            "max_age": "0",
            "login_hint": email,
            "scope": "openid profile email offline_access",
            "response_type": "code",
            "response_mode": "query",
            "state": secrets.token_urlsafe(32),
            "nonce": secrets.token_urlsafe(32),
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "auth0Client": platform_auth0_client,
        }
        resp, error = request_with_local_retry(self.session, "get", f"{auth_base}/api/accounts/authorize?{urlencode(params)}", headers=self._navigate_headers(f"{platform_base}/"), allow_redirects=True, verify=False)
        if resp is None or resp.status_code != 200:
            err = _response_json(resp).get("error", {}) if resp is not None else {}
            detail = f": {err.get('code', '')} - {err.get('message', '')}".strip(" -") if err else ""
            raise RuntimeError(error or f"platform_authorize_http_{getattr(resp, 'status_code', 'unknown')}{detail}")
        step(index, "platform authorize 完成")

    def _register_user(self, email: str, password: str, index: int) -> None:
        step(index, "开始提交注册密码")
        headers = self._json_headers(f"{auth_base}/create-account/password")
        headers["openai-sentinel-token"] = build_sentinel_token(self.session, self.device_id, "username_password_create")
        resp, error = request_with_local_retry(self.session, "post", f"{auth_base}/api/accounts/user/register", json={"username": email, "password": password}, headers=headers, verify=False)
        if resp is None or resp.status_code != 200:
            data = _response_json(resp) if resp is not None else {}
            if data.get("message") == "Failed to create account. Please try again.":
                step(index, "注册失败提示: 邮箱域名很可能因滥用被封禁，请更换邮箱域名", "yellow")
            detail = f", detail={json.dumps(data, ensure_ascii=False)}" if data else ""
            raise RuntimeError(error or f"user_register_http_{getattr(resp, 'status_code', 'unknown')}{detail}")
        step(index, "提交注册密码完成")

    def _send_otp(self, index: int) -> None:
        step(index, "开始发送验证码")
        resp, error = request_with_local_retry(self.session, "get", f"{auth_base}/api/accounts/email-otp/send", headers=self._navigate_headers(f"{auth_base}/create-account/password"), allow_redirects=True, verify=False)
        if resp is None or resp.status_code not in (200, 302):
            raise RuntimeError(error or f"send_otp_http_{getattr(resp, 'status_code', 'unknown')}")
        step(index, "发送验证码完成")

    def _validate_otp(self, code: str, index: int) -> None:
        step(index, f"开始校验验证码 {code}")
        resp, error = validate_otp(self.session, self.device_id, code)
        if resp is None or resp.status_code != 200:
            raise RuntimeError(error or f"validate_otp_http_{getattr(resp, 'status_code', 'unknown')}")
        step(index, "验证码校验完成")

    def _create_account(self, name: str, birthdate: str, index: int) -> str:
        step(index, "开始创建账号资料")
        headers = self._json_headers(f"{auth_base}/about-you")
        headers["openai-sentinel-token"] = build_sentinel_token(self.session, self.device_id, "oauth_create_account")
        resp, error = request_with_local_retry(self.session, "post", f"{auth_base}/api/accounts/create_account", json={"name": name, "birthdate": birthdate}, headers=headers, verify=False)
        if resp is None or resp.status_code not in (200, 302):
            data = _response_json(resp) if resp is not None else {}
            if data.get("message") == "Failed to create account. Please try again.":
                step(index, "创建账号失败提示: 邮箱域名很可能因滥用被封禁，请更换邮箱域名", "yellow")
            detail = f", detail={json.dumps(data, ensure_ascii=False)}" if data else ""
            raise RuntimeError(error or f"create_account_http_{getattr(resp, 'status_code', 'unknown')}{detail}")
        step(index, "创建账号资料完成")
        payload = _response_json(resp)
        return str(payload.get("continue_url") or "").strip()

    def _verify_phone_if_needed(self, index: int) -> str | None:
        """检查是否需要手机验证，如果需要则通过 SMSPro 自动完成。
        
        返回验证用的手机号（如果验证了），否则返回 None。
        """
        sms_config = config.get("sms") or {}
        codes = [str(c).strip() for c in (sms_config.get("codes") or []) if str(c).strip()]
        if not codes:
            return None  # 没配置接码，跳过

        # 检查当前页面是否要求手机验证
        headers = self._json_headers(f"{auth_base}/about-you")
        resp, _ = request_with_local_retry(
            self.session, "get", f"{auth_base}/api/accounts/phone-verification/status",
            headers=headers, verify=False
        )
        if resp is None or resp.status_code != 200:
            return None  # 没有手机验证要求，正常继续

        data = _response_json(resp)
        if not data.get("required"):
            return None

        step(index, "检测到需要手机号验证，开始 SMS 接码", "yellow")

        # 从 SMS 接码平台获取号码
        sms_result = sms_provider.activate(sms_config)
        phone = sms_result["phone"]
        redeem_code = sms_result["code"]
        step(index, f"SMS 分配号码: {phone}")

        # 提交手机号给 OpenAI
        headers = self._json_headers(f"{auth_base}/phone-verification")
        headers["openai-sentinel-token"] = build_sentinel_token(self.session, self.device_id, "phone_verification")
        resp, error = request_with_local_retry(
            self.session, "post", f"{auth_base}/api/accounts/phone-verification/send",
            json={"phone_number": phone}, headers=headers, verify=False
        )
        if resp is None or resp.status_code != 200:
            raise RuntimeError(f"提交手机号失败: {error or getattr(resp, 'status_code', 'unknown')}")
        step(index, "已提交手机号，等待短信验证码")

        # 等待 SMS 收到验证码
        sms_code = sms_provider.wait_for_sms(redeem_code, target_count=1, timeout=120, sms_config=sms_config)
        step(index, f"SMS 收到验证码: {sms_code}")

        # 提交验证码给 OpenAI
        headers = self._json_headers(f"{auth_base}/phone-verification")
        headers["openai-sentinel-token"] = build_sentinel_token(self.session, self.device_id, "phone_verification")
        resp, error = request_with_local_retry(
            self.session, "post", f"{auth_base}/api/accounts/phone-verification/verify",
            json={"code": sms_code}, headers=headers, verify=False
        )
        if resp is None or resp.status_code != 200:
            raise RuntimeError(f"手机验证码校验失败: {error or getattr(resp, 'status_code', 'unknown')}")
        step(index, "手机号验证完成", "green")
        return phone

    def _login_and_exchange_tokens(self, email: str, password: str, mailbox: dict, continue_url: str, index: int) -> dict:
        step(index, "开始换 token（沿用注册流程的 continue_url）")
        if not self._code_verifier:
            raise RuntimeError("token换取失败：缺少 code_verifier")
        if not continue_url:
            continue_url = f"{auth_base}/sign-in-with-chatgpt/codex/consent"
        tokens = exchange_platform_tokens(self.session, self.device_id, self._code_verifier, continue_url)
        if not tokens:
            raise RuntimeError("token换取失败：无法从 continue_url 获取授权码")
        step(index, "token 换取完成")
        return tokens

    def register(self, index: int) -> dict:
        step(index, "开始创建邮箱")
        mailbox = create_mailbox()
        email = str(mailbox.get("address") or "").strip()
        if not email:
            raise RuntimeError("邮箱服务未返回 address")
        step(index, f"邮箱创建完成: {email}")
        password = _random_password()
        first_name, last_name = _random_name()
        step(index, f"账号凭据 邮箱={email} 密码={password}")
        self._platform_authorize(email, index)
        self._register_user(email, password, index)
        self._send_otp(index)
        step(index, "开始等待注册验证码")
        code = wait_for_code(mailbox)
        if not code:
            raise RuntimeError("等待注册验证码超时")
        step(index, f"收到注册验证码: {code}")
        self._validate_otp(code, index)
        continue_url = self._create_account(f"{first_name} {last_name}", _random_birthdate(), index)
        verified_phone = self._verify_phone_if_needed(index)
        tokens = self._login_and_exchange_tokens(email, password, mailbox, continue_url, index)
        return {
            "email": email,
            "password": password,
            "access_token": str(tokens.get("access_token") or "").strip(),
            "refresh_token": str(tokens.get("refresh_token") or "").strip(),
            "id_token": str(tokens.get("id_token") or "").strip(),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "phone_verified": verified_phone or "",
        }


_REGISTERED_FILE_LOCK = threading.Lock()
_REGISTERED_FILE = base_dir.parents[1] / "data" / "registered_accounts.json"
_REGISTERED_DIR = base_dir.parents[1] / "data" / "registered"


def _save_registered_account(result: dict) -> None:
    """把注册成功的完整信息保存为单独的 JSON 文件。

    文件名格式: codex-{email}-free.json
    内容格式与 CPA auth-file 一致。
    同时也追加到 registered_accounts.json 汇总文件。
    """
    try:
        access_token = str(result.get("access_token") or "")
        id_token = str(result.get("id_token") or "")
        email = str(result.get("email") or "")
        created_at = str(result.get("created_at") or datetime.now(timezone.utc).isoformat())

        # 从 JWT payload 解析 account_id 和过期时间
        payload = _decode_jwt_payload(id_token) or _decode_jwt_payload(access_token)
        oai_auth = payload.get("https://api.openai.com/auth") if isinstance(payload, dict) else {}
        account_id = ""
        if isinstance(oai_auth, dict):
            account_id = str(oai_auth.get("chatgpt_account_id") or "")

        exp_ts = payload.get("exp") if isinstance(payload, dict) else None
        try:
            expired_iso = datetime.fromtimestamp(int(exp_ts), tz=timezone.utc).isoformat() if exp_ts else ""
        except Exception:
            expired_iso = ""

        record = {
            "access_token": access_token,
            "account_id": account_id,
            "disabled": False,
            "email": email,
            "expired": expired_iso,
            "id_token": id_token,
            "last_refresh": created_at,
            "refresh_token": str(result.get("refresh_token") or ""),
            "phone_verified": str(result.get("phone_verified") or ""),
            "type": "codex",
        }

        with _REGISTERED_FILE_LOCK:
            # 1. 保存单独文件: data/registered/codex-{email}-free.json
            _REGISTERED_DIR.mkdir(parents=True, exist_ok=True)
            safe_email = email.replace("@", "_at_").replace("+", "_plus_") if email else f"unknown_{uuid.uuid4().hex[:8]}"
            single_file = _REGISTERED_DIR / f"codex-{safe_email}-free.json"
            single_file.write_text(
                json.dumps(record, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

            # 2. 追加到汇总文件: data/registered_accounts.json
            _REGISTERED_FILE.parent.mkdir(parents=True, exist_ok=True)
            existing: list = []
            if _REGISTERED_FILE.exists():
                try:
                    existing = json.loads(_REGISTERED_FILE.read_text(encoding="utf-8"))
                    if not isinstance(existing, list):
                        existing = []
                except Exception:
                    existing = []
            existing.append(record)
            _REGISTERED_FILE.write_text(
                json.dumps(existing, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
    except Exception as e:
        log(f"[本地保存] 写入失败: {e}", "yellow")


def _push_to_cpa(result: dict) -> None:
    """注册成功后将 access_token 推送到 CPA 服务器的 auth-files。"""
    cpa_export = config.get("cpa_export") or {}
    base_url = str(cpa_export.get("base_url") or "").strip().rstrip("/")
    secret_key = str(cpa_export.get("secret_key") or "").strip()
    if not base_url or not secret_key:
        return
    email = str(result.get("email") or "").strip()
    access_token = str(result.get("access_token") or "").strip()
    refresh_token = str(result.get("refresh_token") or "").strip()
    if not access_token:
        return
    try:
        payload = {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "email": email,
        }
        file_name = email.replace("@", "_at_") if email else f"token_{uuid.uuid4().hex[:8]}"
        session = requests.Session()
        session.verify = False
        proxy = str(config.get("proxy") or "").strip()
        if proxy and not _is_socks_proxy(proxy):
            session.proxies.update({"http": proxy, "https": proxy})
        resp = session.post(
            f"{base_url}/v0/management/auth-files",
            headers={
                "Authorization": f"Bearer {secret_key}",
                "Content-Type": "application/json",
            },
            json={"name": file_name, "channel": "codex", "content": payload},
            timeout=30,
        )
        session.close()
        if resp.status_code in (200, 201):
            log(f"[CPA] {email} 已推送到 CPA 服务器", "green")
        else:
            log(f"[CPA] 推送失败 HTTP {resp.status_code}: {resp.text[:200]}", "yellow")
    except Exception as e:
        log(f"[CPA] 推送异常: {e}", "yellow")


def worker(index: int) -> dict:
    start = time.time()
    proxy = _build_proxy_from_pool()
    registrar = PlatformRegistrar(proxy)
    try:
        if proxy:
            # 只显示 host 部分，隐藏密码
            safe_display = proxy.split("@")[-1] if "@" in proxy else proxy
            step(index, f"任务启动 (代理: {safe_display})")
        else:
            step(index, "任务启动 (直连)")
        result = registrar.register(index)
        cost = time.time() - start
        access_token = str(result["access_token"])
        account_service.add_accounts([access_token])
        account_service.refresh_accounts([access_token])
        # 标记是否接过手机验证码
        phone = str(result.get("phone_verified") or "")
        updates: dict = {}
        if phone:
            updates["phone_verified"] = phone
        if result.get("refresh_token"):
            updates["refresh_token"] = str(result["refresh_token"])
        if result.get("id_token"):
            updates["id_token"] = str(result["id_token"])
        if updates:
            account_service.update_account(access_token, updates)
        _save_registered_account(result)
        _push_to_cpa(result)
        with stats_lock:
            stats["done"] += 1
            stats["success"] += 1
            avg = (time.time() - stats["start_time"]) / stats["success"]
        log(f'{result["email"]} 注册成功，本次耗时{cost:.1f}s，全局平均每个号注册耗时{avg:.1f}s', "green")
        return {"ok": True, "index": index, "result": result}
    except Exception as e:
        cost = time.time() - start
        with stats_lock:
            stats["done"] += 1
            stats["fail"] += 1
        log(f"任务{index} 注册失败，本次耗时{cost:.1f}s，原因: {e}", "red")
        return {"ok": False, "index": index, "error": str(e)}
    finally:
        registrar.close()
