from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.support import require_admin
from services.register_service import register_service


class RegisterConfigRequest(BaseModel):
    mail: dict | None = None
    proxy: str | None = None
    proxy_pool: dict | None = None
    total: int | None = None
    threads: int | None = None
    mode: str | None = None
    target_quota: int | None = None
    target_available: int | None = None
    check_interval: int | None = None
    cpa_export: dict | None = None
    sms: dict | None = None


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/register")
    async def get_register_config(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"register": register_service.get()}

    @router.post("/api/register")
    async def update_register_config(body: RegisterConfigRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"register": register_service.update(body.model_dump(exclude_none=True))}

    @router.post("/api/register/start")
    async def start_register(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"register": register_service.start()}

    @router.post("/api/register/stop")
    async def stop_register(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"register": register_service.stop()}

    @router.post("/api/register/reset")
    async def reset_register(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"register": register_service.reset()}

    @router.post("/api/register/test-proxy")
    async def test_proxy(authorization: str | None = Header(default=None)):
        """测试代理池连通性：取一个代理，通过它访问 httpbin 获取出口 IP。"""
        require_admin(authorization)
        import requests as _requests
        from services.register.openai_register import _build_proxy_from_pool

        proxy_url = _build_proxy_from_pool()
        if not proxy_url:
            return {"ok": True, "proxy": "(直连)", "ip": "未使用代理", "message": "当前未配置代理，将直连注册"}

        try:
            session = _requests.Session()
            session.verify = False
            session.proxies = {"http": proxy_url, "https": proxy_url}
            resp = session.get("https://httpbin.org/ip", timeout=15)
            session.close()
            if resp.status_code == 200:
                data = resp.json()
                ip = data.get("origin", "未知")
                # 隐藏代理密码
                safe_proxy = proxy_url.split("@")[-1] if "@" in proxy_url else proxy_url
                return {"ok": True, "proxy": safe_proxy, "ip": ip, "message": f"代理连通，出口 IP: {ip}"}
            else:
                return {"ok": False, "proxy": proxy_url.split("@")[-1] if "@" in proxy_url else proxy_url, "ip": "", "message": f"代理返回 HTTP {resp.status_code}"}
        except Exception as e:
            safe_proxy = proxy_url.split("@")[-1] if "@" in proxy_url else proxy_url
            return {"ok": False, "proxy": safe_proxy, "ip": "", "message": f"代理连接失败: {e}"}

    @router.get("/api/register/events")
    async def register_events(token: str = ""):
        require_admin(f"Bearer {token}")

        async def stream():
            last = ""
            while True:
                payload = json.dumps(register_service.get(), ensure_ascii=False)
                if payload != last:
                    last = payload
                    yield f"data: {payload}\n\n"
                await asyncio.sleep(0.5)

        return StreamingResponse(stream(), media_type="text/event-stream")

    return router
