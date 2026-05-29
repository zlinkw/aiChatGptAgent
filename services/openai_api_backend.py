"""OpenAI 兼容 API 后端 — 支持中转 API（如 OpenRouter、one-api 等）

当 config.json 中配置了 api_backend 时，所有 AI 调用走这个模块。
支持标准 OpenAI 格式的 /v1/chat/completions 和 /v1/models 接口。
"""
from __future__ import annotations

import json
import time
from typing import Any, Iterator

import requests

from services.config import config, DATA_DIR

# 中转 API 配置文件
API_BACKEND_FILE = DATA_DIR / "api_backend.json"


def _load_api_config() -> dict[str, str]:
    """加载中转 API 配置"""
    if API_BACKEND_FILE.exists():
        try:
            return json.loads(API_BACKEND_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_api_config(data: dict[str, str]) -> None:
    """保存中转 API 配置"""
    API_BACKEND_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def get_api_config() -> dict[str, str]:
    """获取当前中转 API 配置"""
    return _load_api_config()


def update_api_config(base_url: str, api_key: str, default_model: str = "") -> dict[str, str]:
    """更新中转 API 配置"""
    data = {
        "base_url": base_url.strip().rstrip("/"),
        "api_key": api_key.strip(),
        "default_model": default_model.strip() or "gpt-4o",
        "enabled": "true",
    }
    _save_api_config(data)
    return data


def is_api_backend_enabled() -> bool:
    """检查中转 API 是否已启用"""
    cfg = _load_api_config()
    return cfg.get("enabled") == "true" and bool(cfg.get("base_url")) and bool(cfg.get("api_key"))


def list_models() -> list[dict[str, Any]]:
    """从中转 API 获取可用模型列表"""
    cfg = _load_api_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        return []

    try:
        resp = requests.get(
            f"{cfg['base_url']}/v1/models",
            headers={"Authorization": f"Bearer {cfg['api_key']}"},
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            models = data.get("data", [])
            return [{"id": m.get("id", ""), "name": m.get("id", "")} for m in models if m.get("id")]
        return []
    except Exception:
        return []


# 透传给上游 OpenAI 兼容 API 的字段白名单
# 注意：messages/model/stream 在 _build_payload 里单独处理，不要重复
_PASSTHROUGH_KEYS = (
    "temperature", "top_p", "n", "max_tokens", "max_completion_tokens",
    "presence_penalty", "frequency_penalty", "stop", "logit_bias",
    "user", "seed", "response_format",
    # function calling / tool use
    "tools", "tool_choice", "parallel_tool_calls",
    # 推理 / 日志 / 高级特性
    "logprobs", "top_logprobs", "reasoning_effort",
    "stream_options", "modalities", "audio", "prediction",
    "store", "metadata", "service_tier",
)


def _build_payload(
    messages: list[dict[str, Any]],
    model: str,
    stream: bool,
    kwargs: dict[str, Any],
    cfg: dict[str, str],
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model or cfg.get("default_model", "gpt-4o"),
        "messages": messages,
        "stream": stream,
    }
    for key in _PASSTHROUGH_KEYS:
        value = kwargs.get(key)
        if value is not None:
            payload[key] = value
    return payload


def _request_endpoint() -> tuple[str, dict[str, str]]:
    cfg = _load_api_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        raise RuntimeError("中转 API 未配置")
    url = f"{cfg['base_url']}/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    return url, headers


def chat_completion(
    messages: list[dict[str, Any]],
    model: str = "",
    stream: bool = False,
    **kwargs: Any,
) -> dict[str, Any] | Iterator[str]:
    """调用中转 API 的 chat/completions

    - stream=False：返回上游原始 JSON（含 tool_calls 等原生字段）
    - stream=True：为兼容老调用方（design.py / sentiment_service），yield 纯文本 delta
    """
    cfg = _load_api_config()
    url, headers = _request_endpoint()
    payload = _build_payload(messages, model, stream, kwargs, cfg)

    if stream:
        return _stream_chat_text(url, headers, payload)
    resp = requests.post(url, headers=headers, json=payload, timeout=120)
    if resp.status_code != 200:
        raise RuntimeError(f"中转 API 错误 ({resp.status_code}): {resp.text[:500]}")
    return resp.json()


def chat_completion_raw_stream(
    messages: list[dict[str, Any]],
    model: str = "",
    **kwargs: Any,
) -> Iterator[dict[str, Any]]:
    """按上游 SSE 原样 yield chunk dict，保留 delta.tool_calls / finish_reason 等所有字段。"""
    cfg = _load_api_config()
    url, headers = _request_endpoint()
    payload = _build_payload(messages, model, True, kwargs, cfg)
    return _stream_chat_chunks(url, headers, payload)


def _stream_chat_chunks(url: str, headers: dict, payload: dict) -> Iterator[dict[str, Any]]:
    """yield 上游 SSE 中每个 data: 行的 JSON dict（剔除 [DONE]）"""
    resp = requests.post(url, headers=headers, json=payload, stream=True, timeout=120)
    if resp.status_code != 200:
        raise RuntimeError(f"中转 API 错误 ({resp.status_code}): {resp.text[:500]}")

    # 强制 UTF-8 解码，避免中文乱码
    resp.encoding = "utf-8"
    buffer = ""
    for chunk in resp.iter_content(chunk_size=None, decode_unicode=False):
        if not chunk:
            continue
        buffer += chunk.decode("utf-8", errors="replace")
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            if data_str == "[DONE]":
                return
            try:
                yield json.loads(data_str)
            except json.JSONDecodeError:
                continue


def _stream_chat_text(url: str, headers: dict, payload: dict) -> Iterator[str]:
    """老调用方使用：只 yield 文本 delta"""
    for chunk in _stream_chat_chunks(url, headers, payload):
        choices = chunk.get("choices") or []
        if not choices:
            continue
        delta = choices[0].get("delta") or {}
        content = delta.get("content")
        if content:
            yield content


# ====== /v1/responses 中转透传 ======
# Responses API 的 SSE 跟 chat completions 不一样，不是 [DONE] 终止，
# 而是按 event 类型分行（response.created / response.output_text.delta / ...）。
# CLIProxyAPI 是标准 OpenAI Responses 兼容，原样透传就行。

def _build_response_payload(body: dict[str, Any], cfg: dict[str, str]) -> dict[str, Any]:
    """构造 /v1/responses 上游 payload。
    body 直接是客户端原始 dict（含 input/instructions/tools/tool_choice/stream/...），
    我们只补默认 model，剩下原样透传。
    """
    payload = dict(body)
    if not payload.get("model"):
        payload["model"] = cfg.get("default_model") or "gpt-5.5"
    return payload


def responses_create(body: dict[str, Any]) -> dict[str, Any]:
    """非流式 /v1/responses 透传。"""
    cfg = _load_api_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        raise RuntimeError("中转 API 未配置")
    url = f"{cfg['base_url']}/v1/responses"
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    payload = _build_response_payload(body, cfg)
    payload["stream"] = False
    resp = requests.post(url, headers=headers, json=payload, timeout=300)
    if resp.status_code != 200:
        raise RuntimeError(f"中转 API 错误 ({resp.status_code}): {resp.text[:500]}")
    return resp.json()


def responses_stream_events(body: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """流式 /v1/responses 透传：yield 上游每个 SSE event 的 JSON dict。

    上游 Responses SSE 格式：
        event: response.created
        data: {...}

        event: response.output_text.delta
        data: {...}

        ...

    我们只关心 data: 行，event: 行可以忽略（dict 里已有 type 字段）。
    """
    cfg = _load_api_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        raise RuntimeError("中转 API 未配置")
    url = f"{cfg['base_url']}/v1/responses"
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    payload = _build_response_payload(body, cfg)
    payload["stream"] = True
    resp = requests.post(url, headers=headers, json=payload, stream=True, timeout=300)
    if resp.status_code != 200:
        raise RuntimeError(f"中转 API 错误 ({resp.status_code}): {resp.text[:500]}")

    resp.encoding = "utf-8"
    buffer = ""
    for chunk in resp.iter_content(chunk_size=None, decode_unicode=False):
        if not chunk:
            continue
        buffer += chunk.decode("utf-8", errors="replace")
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            if not data_str or data_str == "[DONE]":
                continue
            try:
                yield json.loads(data_str)
            except json.JSONDecodeError:
                continue


# ====== /v1/messages 中转透传（Anthropic）======
# CLIProxyAPI 同样支持原生 /v1/messages（claude-code 走的就是这个），
# 透传不需要协议转换。

def messages_create(body: dict[str, Any]) -> dict[str, Any]:
    cfg = _load_api_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        raise RuntimeError("中转 API 未配置")
    url = f"{cfg['base_url']}/v1/messages"
    headers = {
        "x-api-key": cfg["api_key"],
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    payload = dict(body)
    if not payload.get("model"):
        payload["model"] = cfg.get("default_model") or "claude-opus-4-7"
    payload["stream"] = False
    resp = requests.post(url, headers=headers, json=payload, timeout=300)
    if resp.status_code != 200:
        raise RuntimeError(f"中转 API 错误 ({resp.status_code}): {resp.text[:500]}")
    return resp.json()


def messages_stream_events(body: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """流式 /v1/messages 透传：yield 上游每个 SSE event 的 JSON dict。"""
    cfg = _load_api_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        raise RuntimeError("中转 API 未配置")
    url = f"{cfg['base_url']}/v1/messages"
    headers = {
        "x-api-key": cfg["api_key"],
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    payload = dict(body)
    if not payload.get("model"):
        payload["model"] = cfg.get("default_model") or "claude-opus-4-7"
    payload["stream"] = True
    resp = requests.post(url, headers=headers, json=payload, stream=True, timeout=300)
    if resp.status_code != 200:
        raise RuntimeError(f"中转 API 错误 ({resp.status_code}): {resp.text[:500]}")

    resp.encoding = "utf-8"
    buffer = ""
    for chunk in resp.iter_content(chunk_size=None, decode_unicode=False):
        if not chunk:
            continue
        buffer += chunk.decode("utf-8", errors="replace")
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if not line or not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            if not data_str or data_str == "[DONE]":
                continue
            try:
                yield json.loads(data_str)
            except json.JSONDecodeError:
                continue


def simple_completion(prompt: str, model: str = "", system: str = "") -> str:
    """简单的文本生成（非流式）"""
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    result = chat_completion(messages, model=model, stream=False)
    choices = result.get("choices", [])
    if choices:
        return choices[0].get("message", {}).get("content", "")
    return ""


def stream_completion(prompt: str, model: str = "", system: str = "") -> Iterator[str]:
    """流式文本生成"""
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    return chat_completion(messages, model=model, stream=True)
