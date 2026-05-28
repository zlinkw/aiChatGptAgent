from __future__ import annotations

from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field

from api.support import consume_user_quota, refund_user_quota, require_identity, resolve_image_base_url
from services.content_filter import check_request, request_text
from services.image_owners_service import record_owner_for_result
from services.image_prompts_service import record_prompt_for_result
from services.log_service import LoggedCall
from services.protocol import (
    anthropic_v1_messages,
    openai_v1_chat_complete,
    openai_v1_image_edit,
    openai_v1_image_generations,
    openai_v1_models,
    openai_v1_response,
)


class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-2"
    n: int = Field(default=1, ge=1, le=4)
    size: str | None = None
    response_format: str = "b64_json"
    history_disabled: bool = True
    stream: bool | None = None


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    prompt: str | None = None
    n: int | None = None
    stream: bool | None = None
    modalities: list[str] | None = None
    messages: list[dict[str, object]] | None = None


class ResponseCreateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    input: object | None = None
    tools: list[dict[str, object]] | None = None
    tool_choice: object | None = None
    stream: bool | None = None


class AnthropicMessageRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    messages: list[dict[str, object]] | None = None
    system: object | None = None
    stream: bool | None = None


async def filter_or_log(call: LoggedCall, text: str) -> None:
    try:
        await run_in_threadpool(check_request, text)
    except HTTPException as exc:
        call.log("调用失败", status="failed", error=str(exc.detail))
        raise


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/v1/models")
    async def list_models(authorization: str | None = Header(default=None)):
        require_identity(authorization)
        try:
            # 获取号池模型
            pool_result = await run_in_threadpool(openai_v1_models.list_models)
            pool_models = pool_result.get("data", []) if isinstance(pool_result, dict) else []

            # 合并中转 API 模型
            from services.openai_api_backend import is_api_backend_enabled, list_models as api_list_models
            if is_api_backend_enabled():
                try:
                    api_models = await run_in_threadpool(api_list_models)
                    # 去重合并
                    existing_ids = {m.get("id") for m in pool_models}
                    for m in api_models:
                        if m["id"] not in existing_ids:
                            pool_models.append({
                                "id": m["id"],
                                "object": "model",
                                "owned_by": "api-backend",
                            })
                except Exception:
                    pass

            return {"object": "list", "data": pool_models}
        except Exception as exc:
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc

    @router.post("/v1/images/generations")
    async def generate_images(
            body: ImageGenerationRequest,
            request: Request,
            authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        # /v1 入口按 n 整体扣，1 次提交 = n 张。失败直接 402，不进 call.run。
        n = max(1, int(body.n or 1))
        consume_user_quota(identity, n)
        payload = body.model_dump(mode="python")
        payload["base_url"] = resolve_image_base_url(request)
        # 上游真失败时把扣的 n 退回去——LoggedCall.run / stream 内部失败分支会自动回调。
        # 这里 capture identity，failure_refund_amount 跟入口扣的金额一致。
        call = LoggedCall(
            identity, "/v1/images/generations", body.model, "文生图",
            request_text=body.prompt,
            on_failure=lambda amount: refund_user_quota(identity, amount),
            failure_refund_amount=n,
        )
        await filter_or_log(call, body.prompt)
        result = await call.run(openai_v1_image_generations.handle, payload)
        # 对接 dict 返回时把图片归属也写一下；StreamingResponse 不动。
        if isinstance(result, dict):
            record_owner_for_result(identity, result.get("data"))
            record_prompt_for_result(body.prompt, result.get("data"))
        return result

    @router.post("/v1/images/edits")
    async def edit_images(
            request: Request,
            authorization: str | None = Header(default=None),
            image: list[UploadFile] | None = File(default=None),
            image_list: list[UploadFile] | None = File(default=None, alias="image[]"),
            prompt: str = Form(...),
            model: str = Form(default="gpt-image-2"),
            n: int = Form(default=1),
            size: str | None = Form(default=None),
            response_format: str = Form(default="b64_json"),
            stream: bool | None = Form(default=None),
    ):
        identity = require_identity(authorization)
        if n < 1 or n > 4:
            raise HTTPException(status_code=400, detail={"error": "n must be between 1 and 4"})
        # 同样按 n 整体扣，校验过 n 范围之后再扣，避免无效请求也被记账。
        effective_n = max(1, int(n))
        consume_user_quota(identity, effective_n)
        call = LoggedCall(
            identity, "/v1/images/edits", model, "图生图",
            request_text=prompt,
            on_failure=lambda amount: refund_user_quota(identity, amount),
            failure_refund_amount=effective_n,
        )
        await filter_or_log(call, prompt)
        uploads = [*(image or []), *(image_list or [])]
        if not uploads:
            # 已扣的退掉——参数错误本质是 fail-fast，不该让用户白扣
            refund_user_quota(identity, effective_n)
            raise HTTPException(status_code=400, detail={"error": "image file is required"})
        images: list[tuple[bytes, str, str]] = []
        for upload in uploads:
            image_data = await upload.read()
            if not image_data:
                refund_user_quota(identity, effective_n)
                raise HTTPException(status_code=400, detail={"error": "image file is empty"})
            images.append((image_data, upload.filename or "image.png", upload.content_type or "image/png"))
        payload = {
            "prompt": prompt,
            "images": images,
            "model": model,
            "n": n,
            "size": size,
            "response_format": response_format,
            "stream": stream,
            "base_url": resolve_image_base_url(request),
        }
        result = await call.run(openai_v1_image_edit.handle, payload)
        if isinstance(result, dict):
            record_owner_for_result(identity, result.get("data"))
            # 图生图：标 is_edit=True，画廊发布时会把 prompt 强制落空，
            # 因为离开参考图后这段修改指令对其它用户毫无复用价值。
            record_prompt_for_result(prompt, result.get("data"), is_edit=True)
        return result

    @router.post("/v1/chat/completions")
    async def create_chat_completion(body: ChatCompletionRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        request_preview = request_text(payload.get("prompt"), payload.get("messages"))
        call = LoggedCall(identity, "/v1/chat/completions", model, "文本生成", request_text=request_preview)
        await filter_or_log(call, request_preview)

        # 判断是否走中转 API（claude 模型或中转已启用且非号池模型）
        from services.openai_api_backend import is_api_backend_enabled, chat_completion as api_chat
        is_api_model = model.startswith("claude") or model.startswith("gemini") or model.startswith("deepseek")
        if is_api_backend_enabled() and is_api_model:
            async def _api_handle(p):
                messages = p.get("messages", [])
                stream = p.get("stream", False)
                if stream:
                    from fastapi.responses import StreamingResponse
                    import json as _json

                    def _gen():
                        for delta in api_chat(messages, model=model, stream=True):
                            chunk = {"choices": [{"delta": {"content": delta}, "index": 0}], "model": model}
                            yield f"data: {_json.dumps(chunk)}\n\n"
                        yield "data: [DONE]\n\n"

                    return StreamingResponse(_gen(), media_type="text/event-stream")
                else:
                    result = await run_in_threadpool(api_chat, messages, model=model, stream=False)
                    return result
            return await call.run(_api_handle, payload)

        return await call.run(openai_v1_chat_complete.handle, payload)

    @router.post("/v1/responses")
    async def create_response(body: ResponseCreateRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        request_preview = request_text(payload.get("input"), payload.get("instructions"))
        call = LoggedCall(identity, "/v1/responses", model, "Responses", request_text=request_preview)
        await filter_or_log(call, request_preview)
        return await call.run(openai_v1_response.handle, payload)

    @router.post("/v1/messages")
    async def create_message(
            body: AnthropicMessageRequest,
            authorization: str | None = Header(default=None),
            x_api_key: str | None = Header(default=None, alias="x-api-key"),
            anthropic_version: str | None = Header(default=None, alias="anthropic-version"),
    ):
        identity = require_identity(authorization or (f"Bearer {x_api_key}" if x_api_key else None))
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        request_preview = request_text(payload.get("system"), payload.get("messages"), payload.get("tools"))
        call = LoggedCall(identity, "/v1/messages", model, "Messages", request_text=request_preview)
        await filter_or_log(call, request_preview)
        return await call.run(anthropic_v1_messages.handle, payload, sse="anthropic")

    return router
