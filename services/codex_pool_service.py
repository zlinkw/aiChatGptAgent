"""Codex 号池服务 —— 给老号"补登"用的 device flow 管理。

完整流程对外是这样的：

    POST /api/codex/login/start
        → 后端调 OpenAI usercode endpoint，返回 device_auth_id + user_code
        前端展示给用户，用户在浏览器扫码（auth.openai.com/codex/device）

    POST /api/codex/login/poll
        body: {device_auth_id, user_code, email}
        → 后端轮询 OpenAI deviceauth/token endpoint
        拿到 authorization_code 后立即换 token，写入 cliproxy/auths/

模块对外暴露 CodexPoolService 单例，提供：
    - start_login()       生成 device_auth_id + user_code + 验证 URL
    - poll_login(...)     轮询并落盘 token 文件
    - list_authorized()   列出 cliproxy/auths/ 下已经在的所有号
    - delete_authorized() 从池里移除一个号（删 auth 文件）
    - candidate_accounts() 返回还没入池的、有密码的账号列表
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from curl_cffi import requests as cf_requests

from services.account_service import account_service
from services.config import config
from services.register.codex_device_auth import (
    CODEX_CLIENT_ID,
    CodexAuthError,
    auth_file_path,
    exchange_code_for_codex_tokens,
    poll_for_authorization_code,
    request_device_code,
)


# CLIProxyAPI 的 auths 目录。默认就是项目下 cliproxy/auths/，可以 ENV 覆盖
# CODEX_AUTHS_DIR = /path/to/auths 适配你部署 cliproxy 的位置
_DEFAULT_AUTHS_DIR = Path(__file__).resolve().parent.parent / "cliproxy" / "auths"
AUTHS_DIR = Path(os.environ.get("CODEX_AUTHS_DIR", str(_DEFAULT_AUTHS_DIR)))


def _curl_cffi_session(sticky_session_id: str | None = None) -> Any:
    """统一构造一个能过 Cloudflare 的 session（chrome 指纹）。

    OpenAI 在 auth.openai.com 上有 Cloudflare 防护，普通 requests 拿 403。
    短时高频还会触发 IP-level CF challenge——这种情况下走代理池可以
    避免被同一个出口 IP 拉黑。

    sticky_session_id：传入则复用注册时的同一出口 IP（避免 OpenAI 因
    "注册和首次登录 IP 不一致"直接 account_deactivated）。
    """
    proxy = _build_codex_proxy(sticky_session_id=sticky_session_id)
    kwargs: dict[str, Any] = {"impersonate": "chrome", "verify": False}
    if proxy:
        kwargs["proxy"] = proxy
    session = cf_requests.Session(**kwargs)
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    })
    return session


def _build_codex_proxy(sticky_session_id: str | None = None) -> str:
    """复用注册机的代理池给 codex device flow 用。

    sticky_session_id：传入时强制走该 session ID（注册→扫码同 IP）。
    """
    try:
        from services.register.openai_register import _build_proxy_from_pool
        return _build_proxy_from_pool(sticky_session_id=sticky_session_id) or ""
    except Exception:
        return ""


class CodexPoolService:
    """管理 codex 号池的服务（线程安全的内存状态 + 持久化文件）。

    这里的"会话"指一次 device login 的进度。每次 start_login() 创建一个新的
    内存条目，poll_login() 完成后清掉。会话状态在 CLIProxyAPI 重启之间不持久——
    因为 device code 自身有效期只有 15 分钟。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # device_auth_id -> {session, user_code, started_at}
        self._sessions: dict[str, dict[str, Any]] = {}

    # ---------- device login 流程 ----------

    def start_login(self) -> dict:
        """启动一次新的 device login，返回 user_code + 验证页 URL 给前端展示。"""
        session = _curl_cffi_session()
        try:
            device = request_device_code(session)
        except CodexAuthError as exc:
            raise RuntimeError(f"启动 device login 失败：{exc}") from exc
        with self._lock:
            self._sessions[device["device_auth_id"]] = {
                "session": session,
                "user_code": device["user_code"],
                "started_at": time.time(),
                "credential": None,
            }
            # 顺手清理超过 20 分钟的旧会话
            self._gc_locked()
        # 把 user_code 拼进 URL，省得用户手动输入
        verification_url_with_code = (
            f"{device['verification_url']}?user_code={device['user_code']}"
        )
        return {
            "device_auth_id": device["device_auth_id"],
            "user_code": device["user_code"],
            "verification_url": device["verification_url"],
            "verification_url_with_code": verification_url_with_code,
            "interval": device["interval"],
            "expires_at": device.get("expires_at", ""),
        }

    def start_batch(self, count: int) -> list[dict]:
        """一次性启动 N 个 device code，前端列出来批量扫。

        失败时返回部分成功的列表 + 一条错误占位（前端按 status 字段区分）。
        """
        count = max(1, min(int(count or 1), 30))
        results: list[dict] = []
        for _ in range(count):
            try:
                results.append({"status": "ready", **self.start_login()})
            except RuntimeError as exc:
                results.append({"status": "error", "error": str(exc)})
        return results

    def poll_login(self, device_auth_id: str, user_code: str = "", email: str = "") -> dict:
        """前端轮询。后端非阻塞地查一次 OpenAI 服务端，看用户有没有授权完成。

        返回:
          {"status": "pending"} 还在等用户在浏览器点同意
          {"status": "ok",   "auth_file": <path>, "email": <email>} 已落盘
          {"status": "error","error": <message>}                    异常
        """
        with self._lock:
            entry = self._sessions.get(device_auth_id)
            if entry is None:
                return {"status": "error", "error": "session not found or expired"}
            session = entry["session"]
            if not user_code:
                user_code = entry["user_code"]

        # 一次轮询：max_attempts=1 表示立刻返回
        try:
            code_resp = poll_for_authorization_code(
                session, device_auth_id, user_code, interval=1, max_attempts=1
            )
        except CodexAuthError as exc:
            # timeout 是正常 pending，其他抛出去
            if "timeout" in str(exc).lower():
                return {"status": "pending"}
            return {"status": "error", "error": str(exc)}

        # 拿到 code → 换 token
        try:
            tokens = exchange_code_for_codex_tokens(
                session, code_resp["authorization_code"], code_resp["code_verifier"]
            )
        except CodexAuthError as exc:
            return {"status": "error", "error": str(exc)}

        # 落盘
        record = self._build_auth_record(tokens, fallback_email=email)
        path = self._write_auth_file(record)

        # 清掉内存会话
        with self._lock:
            self._sessions.pop(device_auth_id, None)

        return {
            "status": "ok",
            "email": record.get("email") or email,
            "plan": _plan_from_record(record),
            "auth_file": str(path),
        }

    def cancel_login(self, device_auth_id: str) -> bool:
        with self._lock:
            return self._sessions.pop(device_auth_id, None) is not None

    # ---------- 号池查询 ----------

    def list_authorized(self) -> list[dict]:
        """读 cliproxy/auths/ 下所有 codex-*.json，返回当前号池。"""
        if not AUTHS_DIR.exists():
            return []
        items = []
        for path in sorted(AUTHS_DIR.glob("codex-*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            items.append({
                "file": path.name,
                "email": data.get("email", ""),
                "account_id": data.get("account_id", ""),
                "expired": data.get("expired", ""),
                "last_refresh": data.get("last_refresh", ""),
                "disabled": bool(data.get("disabled", False)),
                "type": data.get("type", "codex"),
                "plan": _plan_from_filename(path.name),
            })
        return items

    def candidate_accounts(self, limit: int = 50) -> list[dict]:
        """挑可以用于扫码的候选账号：
        - 有 email
        - 有 password（账号体系里存了的才能给前端展示登录用）
        - 还没在 codex 池里（避免重复扫已入池的号）

        每个返回项：{email, password, has_password=True, proxy_session_id?}。
        """
        in_pool_emails = {item["email"] for item in self.list_authorized() if item.get("email")}
        # 已经被某个 device session 锁定的邮箱也跳过，避免扩展重复用同一个号
        with self._lock:
            claimed_emails = {
                (entry.get("credential") or {}).get("email")
                for entry in self._sessions.values()
                if entry.get("credential")
            }
        excluded = in_pool_emails | {e for e in claimed_emails if e}
        candidates: list[dict] = []
        for acc in account_service.list_accounts():
            email = str(acc.get("email") or "").strip()
            if not email or email in excluded:
                continue
            password = str(acc.get("password") or "").strip()
            if not password:
                continue
            # 跳过已知死号（health_check 标记的）
            if str(acc.get("health_status") or "").strip() == "deactivated":
                continue
            candidates.append({
                "email": email,
                "password": password,
                "has_password": True,
                "proxy_session_id": str(acc.get("proxy_session_id") or "").strip(),
                "health_status": str(acc.get("health_status") or "").strip(),
            })
            if len(candidates) >= max(1, limit):
                break
        return candidates

    def claim_credential(self, user_code: str) -> dict | None:
        """给浏览器扩展使用：根据 user_code 锁定一个候选账号。

        返回 {email, password}。如果同一个 user_code 已经领过了，返回上次锁定的那个，
        保证扩展刷新页面后仍然拿到同一个账号。
        """
        user_code = (user_code or "").strip()
        if not user_code:
            return None

        with self._lock:
            target_entry = None
            for entry in self._sessions.values():
                if entry.get("user_code") == user_code:
                    target_entry = entry
                    break
            if target_entry is None:
                return None
            # 已经领过了
            if target_entry.get("credential"):
                return dict(target_entry["credential"])

            # 第一次领：选一个没被任何 session 占用、也不在号池里的账号
            in_pool_emails = {
                item["email"] for item in self.list_authorized() if item.get("email")
            }
            claimed_emails = {
                (entry.get("credential") or {}).get("email")
                for entry in self._sessions.values()
                if entry.get("credential")
            }
            excluded = in_pool_emails | {e for e in claimed_emails if e}

            for acc in account_service.list_accounts():
                email = str(acc.get("email") or "").strip()
                if not email or email in excluded:
                    continue
                password = str(acc.get("password") or "").strip()
                if not password:
                    continue
                # 跳过已知死号（不让扩展拿来登录，否则只是再确认一次它死了）
                if str(acc.get("health_status") or "").strip() == "deactivated":
                    continue
                cred = {"email": email, "password": password}
                target_entry["credential"] = cred
                return dict(cred)

        return None

    # ---------- 健康检查 ----------

    def check_account_health_by_token(self, access_token: str) -> dict:
        """单号存活检查 —— 用现成的 access_token 调 chatgpt 后端 /me。

        - 200 / 正常 user_info → alive
        - 401 / InvalidAccessTokenError → deactivated（token 失效=号已死/已禁用）
        - 其他网络错误 → error，不动 health_status

        ⚠️ 这个调用走容器自己的网络（不带 711Proxy）。容器里 DNS 被污染时
        会走不通，但这里我们只是想知道号本身死没死，CF 拦截的话当 error 处理。
        """
        if not access_token:
            return {"status": "error", "detail": "no_access_token"}
        try:
            from services.openai_backend_api import (
                InvalidAccessTokenError,
                OpenAIBackendAPI,
            )
            api = OpenAIBackendAPI(access_token)
            info = api.get_user_info() or {}
            # user_info 里通常有 email；拿到了就当活
            if isinstance(info, dict) and (info.get("email") or info.get("id")):
                return {"status": "alive", "detail": "ok"}
            return {"status": "alive", "detail": "empty_info"}
        except InvalidAccessTokenError as exc:
            return {"status": "deactivated", "detail": f"invalid_token: {str(exc)[:120]}"}
        except Exception as exc:
            msg = str(exc)
            low = msg.lower()
            # 账号被停用的明确文本（如果上游返回到这里）
            if "account_deactivated" in low or "deactivated" in low or "已被删除或停用" in msg:
                return {"status": "deactivated", "detail": "account_deactivated"}
            return {"status": "error", "detail": f"{type(exc).__name__}: {msg[:120]}"}

    def health_check_all(self, mark: bool = True) -> dict:
        """批量检查数据库里所有号是否还活着。

        mark=True 时把 health_status 写回 account_service（前端候选列表会跳过死号）。
        返回 {alive: [...], deactivated: [...], error: [...]}
        """
        in_pool_emails = {item["email"] for item in self.list_authorized() if item.get("email")}
        result: dict[str, list] = {"alive": [], "deactivated": [], "error": []}
        for acc in account_service.list_accounts():
            email = str(acc.get("email") or "").strip()
            access_token = str(acc.get("access_token") or "")
            if not access_token:
                continue
            check = self.check_account_health_by_token(access_token)
            status = check.get("status", "error")
            entry = {"email": email, "in_pool": email in in_pool_emails, **check}
            result.setdefault(status, []).append(entry)
            if mark and status in ("alive", "deactivated"):
                try:
                    account_service.update_account(access_token, {"health_status": status})
                except Exception:
                    pass
        return result

    def delete_authorized(self, file_name: str) -> bool:
        """从号池里删除一个号 —— 直接删 auth 文件。CLIProxyAPI 会自动 hot-reload。"""
        # 防穿越
        target = (AUTHS_DIR / file_name).resolve()
        if not str(target).startswith(str(AUTHS_DIR.resolve())):
            return False
        if not target.exists():
            return False
        try:
            target.unlink()
            return True
        except Exception:
            return False

    def disable_authorized(self, file_name: str, disabled: bool) -> bool:
        target = (AUTHS_DIR / file_name).resolve()
        if not str(target).startswith(str(AUTHS_DIR.resolve())):
            return False
        if not target.exists():
            return False
        try:
            data = json.loads(target.read_text(encoding="utf-8"))
        except Exception:
            return False
        data["disabled"] = bool(disabled)
        target.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return True

    # ---------- internal ----------

    def _gc_locked(self) -> None:
        # 清掉跑了超过 20 分钟还没完成的会话
        now = time.time()
        stale = [k for k, v in self._sessions.items() if now - v["started_at"] > 20 * 60]
        for k in stale:
            self._sessions.pop(k, None)

    def _build_auth_record(self, tokens: dict, fallback_email: str = "") -> dict:
        from services.register.codex_device_auth import _decode_jwt_payload  # type: ignore

        id_token = str(tokens.get("id_token") or "")
        access_token = str(tokens.get("access_token") or "")
        payload = _decode_jwt_payload(id_token) or _decode_jwt_payload(access_token)
        oai_auth = payload.get("https://api.openai.com/auth") if isinstance(payload, dict) else {}
        if not isinstance(oai_auth, dict):
            oai_auth = {}
        email = str(payload.get("email") or fallback_email or "")
        account_id = str(oai_auth.get("chatgpt_account_id") or "")
        plan = str(oai_auth.get("chatgpt_plan_type") or "free")

        exp_ts = payload.get("exp") if isinstance(payload, dict) else None
        try:
            expired_iso = (
                datetime.fromtimestamp(int(exp_ts), tz=timezone.utc).isoformat() if exp_ts else ""
            )
        except Exception:
            expired_iso = ""
        return {
            "access_token": access_token,
            "refresh_token": str(tokens.get("refresh_token") or ""),
            "id_token": id_token,
            "email": email,
            "account_id": account_id,
            "expired": expired_iso,
            "last_refresh": datetime.now(timezone.utc).isoformat(),
            "disabled": False,
            "type": "codex",
            "_plan": plan,
        }

    def _write_auth_file(self, record: dict) -> Path:
        plan = record.pop("_plan", "free")
        AUTHS_DIR.mkdir(parents=True, exist_ok=True)
        path = auth_file_path(AUTHS_DIR, record.get("email", "unknown"), plan)
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return path


def _plan_from_filename(name: str) -> str:
    # codex-{email}-{plan}.json
    if not name.startswith("codex-") or not name.endswith(".json"):
        return ""
    stem = name[len("codex-") : -len(".json")]
    parts = stem.rsplit("-", 1)
    return parts[1] if len(parts) == 2 else ""


def _plan_from_record(record: dict) -> str:
    return str(record.get("_plan", "free"))


# 单例
codex_pool_service = CodexPoolService()
