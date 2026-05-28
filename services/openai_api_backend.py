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


def chat_completion(
    messages: list[dict[str, Any]],
    model: str = "",
    stream: bool = False,
    **kwargs: Any,
) -> dict[str, Any] | Iterator[str]:
    """调用中转 API 的 chat/completions"""
    cfg = _load_api_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        raise RuntimeError("中转 API 未配置")

    url = f"{cfg['base_url']}/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    payload: dict[str, Any] = {
        "model": model or cfg.get("default_model", "gpt-4o"),
        "messages": messages,
        "stream": stream,
    }
    # 合并额外参数
    for key in ("temperature", "max_tokens", "top_p"):
        if key in kwargs and kwargs[key] is not None:
            payload[key] = kwargs[key]

    if stream:
        return _stream_chat(url, headers, payload)
    else:
        resp = requests.post(url, headers=headers, json=payload, timeout=120)
        if resp.status_code != 200:
            error_msg = resp.text[:500]
            raise RuntimeError(f"中转 API 错误 ({resp.status_code}): {error_msg}")
        return resp.json()


def _stream_chat(url: str, headers: dict, payload: dict) -> Iterator[str]:
    """流式调用，yield 每个 delta content"""
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
            if not line:
                continue
            if line.startswith("data: "):
                data_str = line[6:].strip()
                if data_str == "[DONE]":
                    return
                try:
                    data = json.loads(data_str)
                    choices = data.get("choices", [])
                    if choices:
                        delta = choices[0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            yield content
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
