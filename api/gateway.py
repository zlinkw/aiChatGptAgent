"""API Gateway 管理接口。"""

from __future__ import annotations

import secrets

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from api.support import require_admin
from services.gateway_service import gateway_service


class GatewayConfigUpdate(BaseModel):
    enabled: bool | None = None
    route_strategy: str | None = None
    account_source: str | None = None
    allow_remote: bool | None = None
    localhost_only: bool | None = None
    ip_whitelist: list[str] | None = None
    switch_threshold: int | None = None
    log_level: str | None = None
    auto_start: bool | None = None


class ClientKeyRequest(BaseModel):
    key: str = ""


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/gateway/status")
    async def get_gateway_status(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"status": gateway_service.get_status()}

    @router.get("/api/gateway/config")
    async def get_gateway_config(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"config": gateway_service.get_config()}

    @router.post("/api/gateway/config")
    async def update_gateway_config(body: GatewayConfigUpdate, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        updates = {k: v for k, v in body.model_dump().items() if v is not None}
        if not updates:
            raise HTTPException(status_code=400, detail={"error": "没有检测到改动"})
        config = gateway_service.update_config(updates)
        return {"config": config}

    @router.post("/api/gateway/reset-stats")
    async def reset_gateway_stats(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        gateway_service.reset_stats()
        return {"status": gateway_service.get_status()}

    @router.post("/api/gateway/keys/add")
    async def add_client_key(body: ClientKeyRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        key = body.key.strip() or f"sk-{secrets.token_hex(32)}"
        config = gateway_service.add_client_key(key)
        return {"config": config, "key": key}

    @router.post("/api/gateway/keys/remove")
    async def remove_client_key(body: ClientKeyRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        if not body.key.strip():
            raise HTTPException(status_code=400, detail={"error": "key is required"})
        config = gateway_service.remove_client_key(body.key.strip())
        return {"config": config}

    @router.post("/api/gateway/keys/toggle")
    async def toggle_client_key(body: ClientKeyRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        if not body.key.strip():
            raise HTTPException(status_code=400, detail={"error": "key is required"})
        # Toggle: find current state and flip
        config = gateway_service.get_config()
        keys = config.get("client_keys") or []
        current = next((k for k in keys if k.get("key") == body.key.strip()), None)
        new_enabled = not (current.get("enabled", True) if current else True)
        config = gateway_service.toggle_client_key(body.key.strip(), new_enabled)
        return {"config": config}

    return router
