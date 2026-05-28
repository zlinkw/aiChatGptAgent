from __future__ import annotations

import threading
import time
from typing import Any

from fastapi import APIRouter, Header
from pydantic import BaseModel

from api.support import require_admin
from services.register.mail_provider import (
    _config,
    _entries,
    _extract_code,
    _extract_content,
    _message_matches_email,
    _parse_received_at,
    BaseMailProvider,
    CloudflareTempMailProvider,
    TempMailLolProvider,
    DuckMailProvider,
    GptMailProvider,
    MoEmailProvider,
    InbucketMailProvider,
    YydsMailProvider,
)
from services.register.openai_register import config as register_config


class MailCodeRequest(BaseModel):
    address: str
    provider_index: int | None = None


# 存储活跃的邮箱监听会话
_sessions_lock = threading.Lock()
_sessions: dict[str, dict[str, Any]] = {}


def _get_mail_conf() -> dict:
    return _config(register_config["mail"])


def _build_provider_from_entry(entry: dict, conf: dict) -> BaseMailProvider:
    """根据 entry 配置构建 provider 实例。"""
    ptype = entry.get("type", "")
    if ptype == "cloudflare_temp_email":
        return CloudflareTempMailProvider(entry, conf)
    if ptype == "tempmail_lol":
        return TempMailLolProvider(entry, conf)
    if ptype == "duckmail":
        return DuckMailProvider(entry, conf)
    if ptype == "gptmail":
        return GptMailProvider(entry, conf)
    if ptype == "moemail":
        return MoEmailProvider(entry, conf)
    if ptype == "inbucket":
        return InbucketMailProvider(entry, conf)
    if ptype == "yyds_mail":
        return YydsMailProvider(entry, conf)
    raise RuntimeError(f"不支持的 mail.provider: {ptype}")


def _find_provider_for_address(address: str, provider_index: int | None = None):
    """根据邮箱地址或指定索引找到对应的 mail provider 实例。"""
    providers_config = register_config["mail"].get("providers") or []
    if not providers_config:
        return None, "未配置任何邮件 provider"

    conf = _get_mail_conf()

    if provider_index is not None:
        if provider_index < 0 or provider_index >= len(providers_config):
            return None, f"provider_index {provider_index} 超出范围 (共 {len(providers_config)} 个)"
        entry = providers_config[provider_index]
        provider = _build_provider_from_entry(entry, conf)
        return provider, ""

    # 尝试根据邮箱域名匹配 provider
    domain = address.split("@")[-1].lower() if "@" in address else ""

    for entry in providers_config:
        provider_domains = entry.get("domain") or []
        if isinstance(provider_domains, str):
            provider_domains = [provider_domains]
        provider_domains = [str(d).strip().lower() for d in provider_domains if str(d).strip()]

        for pd in provider_domains:
            if pd.startswith("*."):
                base = pd[2:]
                if domain == base or domain.endswith("." + base):
                    return _build_provider_from_entry(entry, conf), ""
            elif domain == pd:
                return _build_provider_from_entry(entry, conf), ""

    # 没有精确匹配，使用第一个 provider
    entry = providers_config[0]
    return _build_provider_from_entry(entry, conf), ""


def _build_mailbox_for_address(provider: BaseMailProvider, address: str) -> dict[str, Any]:
    """根据 provider 类型构造一个可用于查询的 mailbox 对象。
    
    对于 cloudflare_temp_email，直接用 admin 接口查询邮件。
    """
    provider_name = getattr(provider, "name", "")

    if provider_name == "cloudflare_temp_email":
        # 使用特殊标记，让我们在 fetch 时走 admin 接口
        return {"provider": provider_name, "address": address, "_use_admin": True}
    elif provider_name == "inbucket":
        local_part = address.split("@")[0] if "@" in address else address
        return {"provider": provider_name, "address": address, "mailbox_name": local_part}
    elif provider_name == "gptmail":
        return {"provider": provider_name, "address": address}
    elif provider_name == "yyds_mail":
        return {"provider": provider_name, "address": address, "token": ""}
    else:
        return {"provider": provider_name, "address": address, "token": ""}


def _fetch_message_via_admin(provider, address: str) -> dict[str, Any] | None:
    """通过 admin 接口查询 Cloudflare Temp Email 的邮件。"""
    admin_password = getattr(provider, "admin_password", "")
    data = provider._request(
        "GET", "/admin/mails",
        headers={"x-admin-auth": admin_password},
        params={"address": address, "limit": 10, "offset": 0},
    )
    # 响应可能是 {"results": [...], "count": N} 或直接是列表
    if isinstance(data, dict):
        raw = list(data.get("results") or [])
        if not raw:
            # 有些版本直接返回列表在其他 key 里
            for key in ("mails", "items", "data"):
                if data.get(key) and isinstance(data[key], list):
                    raw = data[key]
                    break
    elif isinstance(data, list):
        raw = data
    else:
        return None

    messages = [item for item in raw if isinstance(item, dict)]
    if not messages:
        return None

    # 取最新的一条
    item = messages[0]
    text_content, html_content = _extract_content(item)
    sender = item.get("from") or item.get("sender") or item.get("source") or ""
    if isinstance(sender, dict):
        sender = sender.get("address") or sender.get("email") or sender.get("name") or ""
    return {
        "provider": "cloudflare_temp_email",
        "mailbox": address,
        "message_id": str(item.get("id") or item.get("_id") or item.get("message_id") or ""),
        "subject": str(item.get("subject") or ""),
        "sender": str(sender),
        "text_content": text_content,
        "html_content": html_content,
        "received_at": _parse_received_at(
            item.get("created_at") or item.get("createdAt") or
            item.get("receivedAt") or item.get("date") or item.get("timestamp")
        ),
        "raw": item,
    }


def create_router() -> APIRouter:
    router = APIRouter()

    @router.post("/api/mailcode/fetch")
    async def fetch_mail_code(body: MailCodeRequest, authorization: str | None = Header(default=None)):
        """输入邮箱地址，从 mail provider 拉取最新的验证码。"""
        require_admin(authorization)

        address = body.address.strip()
        if not address or "@" not in address:
            return {"ok": False, "error": "请输入有效的邮箱地址"}

        # 优先使用已保存的 session
        with _sessions_lock:
            session_data = _sessions.get(address)

        if session_data:
            mailbox = session_data["mailbox"]
            entry = session_data["provider_entry"]
            conf = _get_mail_conf()
            provider = _build_provider_from_entry(entry, conf)
            use_admin = False
        else:
            provider, error = _find_provider_for_address(address, body.provider_index)
            if provider is None:
                return {"ok": False, "error": error}
            mailbox = _build_mailbox_for_address(provider, address)
            use_admin = mailbox.get("_use_admin", False)

        try:
            if use_admin:
                message = _fetch_message_via_admin(provider, address)
            else:
                message = provider.fetch_latest_message(mailbox)

            if not message:
                return {"ok": True, "code": None, "message": None, "info": "暂无邮件"}

            code = _extract_code(message)
            return {
                "ok": True,
                "code": code,
                "message": {
                    "subject": message.get("subject", ""),
                    "sender": message.get("sender", ""),
                    "text_content": message.get("text_content", "")[:500],
                    "received_at": str(message.get("received_at") or ""),
                },
                "info": f"验证码: {code}" if code else "收到邮件但未提取到验证码",
            }
        except Exception as e:
            return {"ok": False, "error": f"查询失败: {str(e)}"}
        finally:
            try:
                provider.close()
            except Exception:
                pass

    @router.post("/api/mailcode/create")
    async def create_mailbox_endpoint(authorization: str | None = Header(default=None)):
        """创建一个新的临时邮箱。"""
        require_admin(authorization)

        providers_config = register_config["mail"].get("providers") or []
        if not providers_config:
            return {"ok": False, "error": "未配置任何邮件 provider"}

        conf = _get_mail_conf()
        # 使用第一个启用的 provider
        enabled = [e for e in providers_config if e.get("enable")]
        entry = enabled[0] if enabled else providers_config[0]
        provider = _build_provider_from_entry(entry, conf)

        try:
            mailbox = provider.create_mailbox()
            address = mailbox.get("address", "")
            with _sessions_lock:
                _sessions[address] = {
                    "mailbox": mailbox,
                    "provider_entry": entry,
                    "created_at": time.time(),
                }
            return {"ok": True, "address": address, "mailbox": mailbox}
        except Exception as e:
            return {"ok": False, "error": f"创建邮箱失败: {str(e)}"}
        finally:
            try:
                provider.close()
            except Exception:
                pass

    @router.get("/api/mailcode/providers")
    async def list_mail_providers(authorization: str | None = Header(default=None)):
        """列出已配置的邮件 provider 信息。"""
        require_admin(authorization)

        providers_config = register_config["mail"].get("providers") or []
        result = []
        for i, entry in enumerate(providers_config):
            domains = entry.get("domain") or []
            if isinstance(domains, str):
                domains = [domains]
            result.append({
                "index": i,
                "type": entry.get("type", "unknown"),
                "domains": domains,
                "enabled": bool(entry.get("enable")),
            })
        return {"ok": True, "providers": result}

    @router.get("/api/mailcode/sessions")
    async def list_sessions(authorization: str | None = Header(default=None)):
        """列出当前活跃的邮箱会话。"""
        require_admin(authorization)

        with _sessions_lock:
            items = [
                {
                    "address": addr,
                    "created_at": data["created_at"],
                    "provider_type": data["provider_entry"].get("type", "unknown"),
                }
                for addr, data in _sessions.items()
            ]
        return {"ok": True, "sessions": items}

    return router
