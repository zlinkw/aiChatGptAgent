"""舆情搜索 API — 支持流式搜索 + AI 模型分析"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.support import require_identity
from services.sentiment_service import (
    SearchDepth, SearchScope, clear_cache,
    search_sentiment, search_sentiment_stream,
)


class SentimentSearchRequest(BaseModel):
    company: str
    scope: SearchScope = "global"
    depth: SearchDepth = "quick"
    model: str = ""
    time_range: str = ""  # qdr:d / qdr:w / qdr:m / qdr:y / 空=不限


def create_router() -> APIRouter:
    router = APIRouter(prefix="/api/sentiment", tags=["sentiment"])

    @router.get("/search")
    async def search(
        company: str = Query(..., min_length=1),
        scope: SearchScope = Query("global"),
        depth: SearchDepth = Query("quick"),
        authorization: str | None = Header(default=None),
    ):
        """搜索公司舆情（普通模式）"""
        require_identity(authorization)
        if not company.strip():
            raise HTTPException(status_code=400, detail="公司名称不能为空")
        result = await run_in_threadpool(search_sentiment, company.strip(), scope, depth)
        return result

    @router.post("/search")
    async def search_post(
        body: SentimentSearchRequest,
        authorization: str | None = Header(default=None),
    ):
        """搜索公司舆情（POST）"""
        require_identity(authorization)
        if not body.company.strip():
            raise HTTPException(status_code=400, detail="公司名称不能为空")
        result = await run_in_threadpool(
            search_sentiment, body.company.strip(), body.scope, body.depth, body.time_range
        )
        return result

    @router.get("/search/stream")
    async def search_stream(
        company: str = Query(..., min_length=1),
        scope: SearchScope = Query("global"),
        depth: SearchDepth = Query("quick"),
        model: str = Query("", description="AI 模型"),
        time_range: str = Query("", description="时间范围"),
        authorization: str | None = Header(default=None),
    ):
        """流式搜索 — SSE 逐步推送结果"""
        require_identity(authorization)
        if not company.strip():
            raise HTTPException(status_code=400, detail="公司名称不能为空")

        async def event_generator():
            loop = asyncio.get_event_loop()
            events = await run_in_threadpool(
                search_sentiment_stream, company.strip(), scope, depth, model, time_range
            )
            for event in events:
                data = json.dumps(event, ensure_ascii=False)
                yield f"data: {data}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @router.delete("/cache")
    async def delete_cache(authorization: str | None = Header(default=None)):
        """清除舆情搜索缓存"""
        require_identity(authorization)
        count = clear_cache()
        return {"ok": True, "cleared": count}

    @router.post("/summarize")
    async def summarize(
        body: dict,
        authorization: str | None = Header(default=None),
    ):
        """对已有搜索结果做 AI 总结"""
        require_identity(authorization)
        company = str(body.get("company", "")).strip()
        model = str(body.get("model", "")).strip()
        results = body.get("results", [])
        if not company or not model or not results:
            raise HTTPException(status_code=400, detail="缺少 company/model/results")

        from services.sentiment_service import _ai_summarize
        summary = await run_in_threadpool(_ai_summarize, company, results, model)
        if not summary:
            raise HTTPException(status_code=502, detail="AI 分析失败，请检查模型是否可用")
        return {"summary": summary}

    return router
