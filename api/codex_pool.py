"""Codex 号池管理 API。

设计目标：让管理员（或客户）通过 web UI 把 ChatGPT 账号一键注入到 CLIProxyAPI，
让 Codex CLI / claude-code 等客户端能立刻用上这些账号。

接口列表（全部需要 admin 鉴权）：

    GET  /api/codex/pool                列出当前号池
    POST /api/codex/pool/login/start    启动一次 device login，返回 user_code 给前端
    POST /api/codex/pool/login/poll     前端轮询授权完成状态
    POST /api/codex/pool/login/cancel   取消未完成的 device login
    POST /api/codex/pool/{file}/disable 禁用号池里的某个号
    POST /api/codex/pool/{file}/enable  启用号池里的某个号
    DELETE /api/codex/pool/{file}       从号池里移除某个号

device login 流程是：
    前端点"添加新号" → 后端 start → 返回 user_code → 前端展示
    用户在浏览器打开 verification_url 输 code 同意
    前端定时 poll，后端轮询 OpenAI server 看是否完成 → 完成后落盘
"""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from api.support import require_admin
from services.codex_pool_service import codex_pool_service


class PollRequest(BaseModel):
    device_auth_id: str
    user_code: str = ""
    email: str = ""


class CancelRequest(BaseModel):
    device_auth_id: str


class BatchStartRequest(BaseModel):
    count: int = 5


class ClaimCredentialRequest(BaseModel):
    user_code: str


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/codex/pool")
    async def list_pool(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"items": codex_pool_service.list_authorized()}

    @router.get("/api/codex/pool/candidates")
    async def list_candidates(authorization: str | None = Header(default=None)):
        """列出还没入池、且数据库里有密码的候选账号。

        前端在批量授权页面用来给每个授权码自动配一个"建议账号"，
        显示邮箱+密码方便复制粘贴。
        """
        require_admin(authorization)
        return {"items": codex_pool_service.candidate_accounts()}

    @router.post("/api/codex/pool/login/start")
    async def start_login(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return codex_pool_service.start_login()
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc

    @router.post("/api/codex/pool/login/start-batch")
    async def start_batch(body: BatchStartRequest, authorization: str | None = Header(default=None)):
        """一次性启动 N 个 device code，方便批量扫码。"""
        require_admin(authorization)
        return {"items": codex_pool_service.start_batch(body.count)}

    @router.post("/api/codex/pool/login/poll")
    async def poll_login(body: PollRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        if not body.device_auth_id.strip():
            raise HTTPException(status_code=400, detail={"error": "device_auth_id is required"})
        return codex_pool_service.poll_login(
            body.device_auth_id.strip(), body.user_code.strip(), body.email.strip()
        )

    @router.post("/api/codex/pool/login/cancel")
    async def cancel_login(body: CancelRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"cancelled": codex_pool_service.cancel_login(body.device_auth_id.strip())}

    @router.post("/api/codex/pool/login/claim-credential")
    async def claim_credential(
        body: ClaimCredentialRequest, authorization: str | None = Header(default=None)
    ):
        """给浏览器扩展用：根据 user_code 领取（或重领）这次登录要用的账号凭据。

        扩展拿到后在隐私窗的 chatgpt 登录页自动填表，不需要用户手动复制粘贴。
        鉴权用 admin key —— 扩展里硬编码或读 cookie，等同于 web UI。
        """
        require_admin(authorization)
        cred = codex_pool_service.claim_credential(body.user_code.strip())
        if not cred:
            raise HTTPException(
                status_code=404,
                detail={"error": "user_code 未找到，或已没有可用候选账号"},
            )
        return cred

    @router.post("/api/codex/pool/{file_name}/disable")
    async def disable(file_name: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        ok = codex_pool_service.disable_authorized(file_name, True)
        if not ok:
            raise HTTPException(status_code=404, detail={"error": "auth file not found"})
        return {"ok": True}

    @router.post("/api/codex/pool/{file_name}/enable")
    async def enable(file_name: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        ok = codex_pool_service.disable_authorized(file_name, False)
        if not ok:
            raise HTTPException(status_code=404, detail={"error": "auth file not found"})
        return {"ok": True}

    @router.delete("/api/codex/pool/{file_name}")
    async def delete(file_name: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        ok = codex_pool_service.delete_authorized(file_name)
        if not ok:
            raise HTTPException(status_code=404, detail={"error": "auth file not found"})
        return {"ok": True}

    @router.post("/api/codex/pool/health-check")
    async def health_check(authorization: str | None = Header(default=None)):
        """批量检查数据库里所有有密码的号是否还活着。

        会调 OpenAI auth.openai.com 的 check_email_v2 端点，返回每个号的状态：
        - alive: 还能用
        - deactivated: 已被 OpenAI 停用（账号死号）
        - error: CF 拦截 / 网络异常等

        deactivated 的号会写回 health_status 字段，候选列表里自动跳过。
        """
        require_admin(authorization)
        return codex_pool_service.health_check_all(mark=True)

    return router
