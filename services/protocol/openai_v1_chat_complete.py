from __future__ import annotations

import json
import re
import time
import uuid
from typing import Any, Iterable, Iterator

from fastapi import HTTPException

from services.protocol.conversation import (
    ConversationRequest,
    ImageOutput,
    collect_image_outputs,
    collect_text,
    count_message_tokens,
    count_text_tokens,
    encode_images,
    normalize_messages,
    stream_image_outputs_with_pool,
    stream_text_deltas,
    text_backend,
)
from utils.helper import build_chat_image_markdown_content, extract_chat_image, extract_chat_prompt, is_image_chat_request, parse_image_count


# --- 模型输出里的 XML 工具调用解析 ---
# 不直接复用 anthropic_v1_messages 里的同名函数，避免与它形成循环 import
# (anthropic_v1_messages 反过来要从这里导 stream_text_chat_completion / collect_chat_content)。

_TOOL_CALL_BLOCK_RE = re.compile(
    r"(?is)<tool_call\b[^>]*>(.*?)</tool_call>|<function_call\b[^>]*>(.*?)</function_call>|<invoke\b[^>]*>(.*?)</invoke>"
)
_TOOL_MARKUP_RE = re.compile(
    r"(?is)<tool_calls\b[^>]*>.*?</tool_calls>|<tool_call\b[^>]*>.*?</tool_call>|<function_call\b[^>]*>.*?</function_call>|<invoke\b[^>]*>.*?</invoke>"
)
_TOOL_OPEN_RE = re.compile(r"(?is)<tool_calls\b|<tool_call\b|<function_call\b|<invoke\b")


def _xml_value(text: str, tag: str) -> str:
    match = re.search(rf"(?is)<{tag}\b[^>]*>(.*?)</{tag}>", text)
    if not match:
        return ""
    value = match.group(1).strip()
    cdata = re.fullmatch(r"(?is)<!\[CDATA\[(.*?)]]>", value)
    return (cdata.group(1) if cdata else value).strip()


def _parse_tool_params(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {
            m.group(1): _xml_value(f"<x>{m.group(2)}</x>", "x") or m.group(2).strip()
            for m in re.finditer(r"(?is)<([\w.-]+)\b[^>]*>(.*?)</\1>", raw)
        }


def _parse_tool_calls_xml(text: str) -> list[tuple[str, dict[str, Any]]]:
    cleaned = re.sub(r"(?is)```.*?```", "", text or "").strip()
    result: list[tuple[str, dict[str, Any]]] = []
    for match in _TOOL_CALL_BLOCK_RE.findall(cleaned):
        block = next((part for part in match if part), "")
        name = _xml_value(block, "tool_name") or _xml_value(block, "name") or _xml_value(block, "function")
        params = _xml_value(block, "parameters") or _xml_value(block, "input") or _xml_value(block, "arguments") or "{}"
        if name:
            result.append((name, _parse_tool_params(params)))
    return result


def _strip_tool_markup(text: str) -> str:
    return _TOOL_MARKUP_RE.sub("", text or "").strip()


def _streamable_text(text: str) -> str:
    """工具模式下，若文本里出现工具开标签，截到开标签之前，避免把 XML 漏给客户端。"""
    text = text or ""
    match = _TOOL_OPEN_RE.search(text)
    return text[: match.start()].rstrip() if match else text


# 号池路径不是原生 function call，靠 system prompt 让模型按约定 XML 输出，再
# 在结果里反解出 OpenAI 协议的 tool_calls。这段提示词是关键，描述 + 协议 + 行为规则。
OPENAI_TOOL_RULE = """When you decide to call a tool, output ONLY this XML and nothing else (no prose, no markdown fences, no thinking text):
<tool_calls><tool_call><tool_name>NAME</tool_name><parameters>{"arg":"value"}</parameters></tool_call></tool_calls>
- <parameters> MUST be a single JSON object string whose keys exactly match the declared parameter schema.
- You may emit multiple <tool_call> blocks inside one <tool_calls> when parallel calls make sense.
- Do not narrate that you are calling a tool. Do not wrap the XML in code fences.
- Only call a tool when the user's request actually needs it; otherwise reply with normal text.
- After receiving a "Tool result ..." message in the conversation, continue the answer using that result."""


def build_tool_system_prompt(tools: object, choice: dict[str, Any] | None = None) -> str:
    """把 OpenAI 风格的 tools 列表转成给模型看的 system 描述。

    choice 用于强化提示：
    - mode=required: 必须调工具
    - mode=forced:   必须只调指定的那一个
    - mode=auto/None: 普通描述
    - mode=none:     返回空（调用方应该把 tools 整个剥掉，不进入 tool 模式）
    """
    if not isinstance(tools, list) or not tools:
        return ""
    mode = (choice or {}).get("mode") or "auto"
    if mode == "none":
        return ""
    blocks: list[str] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        fn = tool.get("function") if isinstance(tool.get("function"), dict) else {}
        name = str(tool.get("name") or fn.get("name") or "").strip()
        if not name:
            continue
        desc = str(tool.get("description") or fn.get("description") or "").strip()
        schema = tool.get("parameters") or fn.get("parameters") or {}
        blocks.append(
            f"Tool: {name}\nDescription: {desc}\nParameters JSON Schema: {json.dumps(schema, ensure_ascii=False)}"
        )
    if not blocks:
        return ""
    extras: list[str] = []
    if mode == "required":
        extras.append(
            "TOOL CHOICE: REQUIRED — you MUST call exactly one tool from the list above. "
            "Replying with plain text is NOT allowed under any circumstance."
        )
    elif mode == "forced":
        forced = (choice or {}).get("forced_name", "")
        if forced:
            extras.append(
                f"TOOL CHOICE: FORCED — you MUST call the tool '{forced}' and ONLY this tool. "
                "Replying with plain text or calling any other tool is NOT allowed."
            )
    parallel = (choice or {}).get("parallel", True)
    if parallel is False:
        extras.append("Do NOT emit more than one <tool_call>; pick the single best one.")
    extras_text = ("\n" + "\n".join(extras)) if extras else ""
    return (
        "Available tools:\n"
        + "\n\n".join(blocks)
        + "\n\n"
        + OPENAI_TOOL_RULE
        + extras_text
    )


def _resolve_tool_choice(body: dict[str, Any]) -> dict[str, Any]:
    """归一化 OpenAI 协议里的 tool_choice + parallel_tool_calls。

    返回 {'mode': 'auto'|'required'|'forced'|'none', 'forced_name': str, 'parallel': bool}
    """
    raw = body.get("tool_choice")
    parallel = body.get("parallel_tool_calls")
    parallel_bool = True if parallel is None else bool(parallel)
    if raw == "required":
        return {"mode": "required", "forced_name": "", "parallel": parallel_bool}
    if raw == "none":
        return {"mode": "none", "forced_name": "", "parallel": parallel_bool}
    if isinstance(raw, dict):
        fn = raw.get("function") if isinstance(raw.get("function"), dict) else {}
        name = str(fn.get("name") or raw.get("name") or "").strip()
        if name:
            return {"mode": "forced", "forced_name": name, "parallel": parallel_bool}
    return {"mode": "auto", "forced_name": "", "parallel": parallel_bool}


def _apply_choice_filter(calls: list[dict[str, Any]], choice: dict[str, Any]) -> list[dict[str, Any]]:
    """按 choice / parallel 约束修剪解析出的 tool_calls。

    - mode=forced:  只保留与 forced_name 匹配的 call（多个匹配也按 parallel 收敛）
    - mode=none:    全部丢弃
    - parallel=False: 只保留第一个
    """
    mode = choice.get("mode") or "auto"
    if mode == "none":
        return []
    if mode == "forced":
        forced = choice.get("forced_name", "")
        if forced:
            calls = [c for c in calls if c["function"]["name"] == forced]
    if not choice.get("parallel", True) and len(calls) > 1:
        calls = calls[:1]
    return calls


def _required_violation(choice: dict[str, Any], calls: list[dict[str, Any]]) -> bool:
    """判断 tool_choice=required/forced 时模型是否未照办。"""
    mode = choice.get("mode") or "auto"
    if mode in ("required", "forced") and not calls:
        return True
    return False


def _required_retry_messages(messages: list[dict[str, Any]], assistant_text: str, choice: dict[str, Any]) -> list[dict[str, Any]]:
    """构造 required/forced 不满足时的重试消息。

    把模型刚才输出的 assistant 回答视为"无效尝试"，再追一条强约束的 user 消息。
    """
    forced = choice.get("forced_name", "")
    if choice.get("mode") == "forced" and forced:
        nudge = (
            f"You did not call any tool. You MUST call the tool '{forced}' now using the XML protocol. "
            "Output ONLY <tool_calls>...</tool_calls>. No prose, no markdown."
        )
    else:
        nudge = (
            "You did not call any tool. You MUST call exactly one tool now using the XML protocol. "
            "Output ONLY <tool_calls>...</tool_calls>. No prose, no markdown."
        )
    retry: list[dict[str, Any]] = list(messages)
    if assistant_text.strip():
        retry.append({"role": "assistant", "content": assistant_text})
    retry.append({"role": "user", "content": nudge})
    return retry


def _convert_history_for_tools(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把客户端回灌的 assistant.tool_calls 和 role=tool 翻译成模型能读的纯文本。

    模型本身不懂 OpenAI 协议结构，只能看文本。约定：
    - assistant.tool_calls => 拼成同一 XML 协议
    - role=tool         => 拼成 "Tool result <id>: <content>"，role 改成 user
    """
    out: list[dict[str, Any]] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role == "tool":
            tool_call_id = str(msg.get("tool_call_id") or msg.get("id") or "")
            content = msg.get("content")
            if not isinstance(content, str):
                content = json.dumps(content, ensure_ascii=False) if content is not None else ""
            out.append({"role": "user", "content": f"Tool result {tool_call_id}: {content}".strip()})
            continue
        if role == "assistant" and msg.get("tool_calls"):
            text_parts: list[str] = []
            content = msg.get("content")
            if isinstance(content, str) and content.strip():
                text_parts.append(content)
            inner: list[str] = []
            for tc in msg.get("tool_calls") or []:
                if not isinstance(tc, dict):
                    continue
                fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
                name = str(fn.get("name") or "").strip()
                args = fn.get("arguments")
                if not isinstance(args, str):
                    args = json.dumps(args or {}, ensure_ascii=False)
                inner.append(f"<tool_call><tool_name>{name}</tool_name><parameters>{args}</parameters></tool_call>")
            if inner:
                text_parts.append(f"<tool_calls>{''.join(inner)}</tool_calls>")
            out.append({"role": "assistant", "content": "\n".join(text_parts)})
            continue
        out.append(msg)
    return out


def _tool_calls_from_text(text: str) -> list[dict[str, Any]]:
    """从模型输出里抽 XML 工具调用，转成 OpenAI 协议的 tool_calls 数组。"""
    parsed = _parse_tool_calls_xml(text)
    return [
        {
            "id": f"call_{uuid.uuid4().hex[:24]}",
            "type": "function",
            "function": {
                "name": name,
                "arguments": json.dumps(args or {}, ensure_ascii=False),
            },
        }
        for name, args in parsed
    ]


def _safe_text_emit(text: str) -> str:
    """在工具模式下，避免把刚冒头的 "<tool" 等开标签前缀提前 emit 给客户端。

    如果 text 末尾有 `<\\w*` 形式的悬挂 tag 起手，就把这段 hold 住等下一个 delta。
    """
    match = re.search(r"<\w*$", text)
    if match:
        return text[: match.start()]
    return text


def _args_semantically_equal(a: str, b: str) -> bool:
    """流式按字符 emit 的 args 跟最终 canonical args 可能空白格式不同，按 JSON 语义比对。"""
    if a == b:
        return True
    try:
        return json.loads(a or "{}") == json.loads(b or "{}")
    except Exception:
        return False


def completion_chunk(model: str, delta: dict[str, Any], finish_reason: str | None = None, completion_id: str = "", created: int | None = None) -> dict[str, Any]:
    return {
        "id": completion_id or f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion.chunk",
        "created": created or int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }


def completion_response(
    model: str,
    content: str,
    created: int | None = None,
    messages: list[dict[str, Any]] | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    prompt_tokens = count_message_tokens(messages, model) if messages else 0
    completion_tokens = count_text_tokens(content, model) if messages else 0
    message: dict[str, Any] = {"role": "assistant", "content": content or None}
    finish_reason = "stop"
    if tool_calls:
        message["tool_calls"] = tool_calls
        finish_reason = "tool_calls"
        if not content:
            message["content"] = None
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": created or int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason,
        }],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


def stream_text_chat_completion(backend, messages: list[dict[str, Any]], model: str) -> Iterator[dict[str, Any]]:
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())
    sent_role = False
    request = ConversationRequest(model=model, messages=messages)
    for delta_text in stream_text_deltas(backend, request):
        if not sent_role:
            sent_role = True
            yield completion_chunk(model, {"role": "assistant", "content": delta_text}, None, completion_id, created)
        else:
            yield completion_chunk(model, {"content": delta_text}, None, completion_id, created)
    if not sent_role:
        yield completion_chunk(model, {"role": "assistant", "content": ""}, None, completion_id, created)
    yield completion_chunk(model, {}, "stop", completion_id, created)


def stream_text_chat_completion_with_tools(
    backend,
    messages: list[dict[str, Any]],
    model: str,
    tools: list[dict[str, Any]],
    choice: dict[str, Any] | None = None,
) -> Iterator[dict[str, Any]]:
    """号池路径上的"伪"原生 function call 流式输出，按 OpenAI 协议增量 emit。

    流程：
    1. 把上游文本累计到 buffer，工具开标签出现前正常以 content delta 输出。
    2. 一旦看到 <tool_calls>/<tool_call> 起手，进入工具模式，停止 content delta。
    3. 在工具模式下，每个上游 delta 后扫描 buffer 里所有 <tool_call> 块的状态：
       - 看到完整 <tool_name>NAME</tool_name>：emit 第一个 tool_calls chunk（带 id/name，arguments 空串）
       - <parameters> 内文本：根据是 JSON 还是 XML 形式分别处理
         · JSON：原样按字符增量 emit arguments
         · XML：等 </parameters> 闭合后，整体转一次 JSON 一次性 emit arguments
    4. 全部结束时根据是否触发过工具模式，吐 finish_reason=tool_calls 或 stop。
    """
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())
    sent_role = False
    full_text = ""
    streamed_visible = ""
    tool_started = False
    request = ConversationRequest(model=model, messages=messages)

    # 每个 call index 的发送状态
    call_state: list[dict[str, Any]] = []

    def emit(delta_payload: dict[str, Any]) -> dict[str, Any]:
        nonlocal sent_role
        if not sent_role:
            sent_role = True
            payload = {"role": "assistant", **delta_payload}
        else:
            payload = delta_payload
        return completion_chunk(model, payload, None, completion_id, created)

    def progress_chunks(partials: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
        for idx, pc in enumerate(partials):
            if idx >= len(call_state):
                call_state.append({
                    "id": f"call_{uuid.uuid4().hex[:24]}",
                    "name_emitted": False,
                    "mode": "unknown",
                    "emitted_args": "",
                })
            state = call_state[idx]

            # 第一次见到完整 name 就发 head chunk
            if not state["name_emitted"] and pc["name"]:
                yield emit({
                    "content": None,
                    "tool_calls": [{
                        "index": idx,
                        "id": state["id"],
                        "type": "function",
                        "function": {"name": pc["name"], "arguments": ""},
                    }],
                })
                state["name_emitted"] = True

            if not state["name_emitted"]:
                continue

            args_text = pc["args_text"]
            if state["mode"] == "unknown" and args_text:
                head = args_text.lstrip()
                if head.startswith("{") or head.startswith("["):
                    state["mode"] = "json"
                elif head.startswith("<"):
                    state["mode"] = "xml"

            if state["mode"] == "json":
                # 直接按字符串增量 emit；末尾要避免半截 escape，简单起见去掉一个
                # 末尾未闭合的 \\ 转义片段，等下一个 delta 补齐
                pending = args_text
                if pending.endswith("\\"):
                    pending = pending[:-1]
                if pending.startswith(state["emitted_args"]):
                    diff = pending[len(state["emitted_args"]):]
                    if diff:
                        yield emit({
                            "tool_calls": [{
                                "index": idx,
                                "function": {"arguments": diff},
                            }],
                        })
                        state["emitted_args"] = pending
            elif state["mode"] == "xml":
                # XML 形式需要等 </parameters> 闭合再整段转 JSON
                if pc["args_complete"] and not state["emitted_args"]:
                    canonical = json.dumps(_parse_tool_params(args_text), ensure_ascii=False)
                    yield emit({
                        "tool_calls": [{
                            "index": idx,
                            "function": {"arguments": canonical},
                        }],
                    })
                    state["emitted_args"] = canonical

    for delta_text in stream_text_deltas(backend, request):
        full_text += delta_text
        if not tool_started:
            visible = _streamable_text(full_text)
            if visible != full_text:
                tool_started = True
            visible = _safe_text_emit(visible)
            if visible.startswith(streamed_visible):
                emit_text = visible[len(streamed_visible):]
                if emit_text:
                    yield emit({"content": emit_text})
                    streamed_visible = visible
        if tool_started:
            yield from progress_chunks(_scan_partial_tool_calls(full_text))

    if not tool_started:
        # 整段都是普通文本：把没 emit 的尾巴补出去
        tail = full_text[len(streamed_visible):]
        if tail:
            yield emit({"content": tail})
        if not sent_role:
            yield emit({"content": ""})
        yield completion_chunk(model, {}, "stop", completion_id, created)
        return

    # 工具模式收尾：用全文重新解析一次确保正确，对漏发的 call / 漏发的 args 补齐
    final_partials = _scan_partial_tool_calls(full_text)
    final_calls = _tool_calls_from_text(full_text)
    yield from progress_chunks(final_partials)

    # 解析全文校准每个 call 的 arguments，如果跟我们一路 emit 的不一致就补一段差异
    for idx, call in enumerate(final_calls):
        canonical_args = call["function"]["arguments"]
        if idx >= len(call_state):
            call_state.append({
                "id": call["id"],
                "name_emitted": True,
                "mode": "json",
                "emitted_args": "",
            })
            yield emit({
                "content": None,
                "tool_calls": [{
                    "index": idx,
                    "id": call["id"],
                    "type": "function",
                    "function": {"name": call["function"]["name"], "arguments": canonical_args},
                }],
            })
            call_state[idx]["emitted_args"] = canonical_args
            continue
        state = call_state[idx]
        if _args_semantically_equal(state["emitted_args"], canonical_args):
            continue
        if canonical_args.startswith(state["emitted_args"]):
            diff = canonical_args[len(state["emitted_args"]):]
            if diff:
                yield emit({
                    "tool_calls": [{
                        "index": idx,
                        "function": {"arguments": diff},
                    }],
                })
        else:
            # 已 emit 的内容跟最终不一致：罕见兜底，发完整一次（OpenAI SDK 会拼起来）
            yield emit({
                "tool_calls": [{
                    "index": idx,
                    "function": {"arguments": canonical_args[len(state["emitted_args"]):]},
                }],
            })
        state["emitted_args"] = canonical_args

    # 应用 tool_choice 过滤（forced 名字不匹配的丢弃；parallel=False 只留第一个）
    if choice:
        kept_names = {c["function"]["name"] for c in _apply_choice_filter(final_calls, choice)}
        # 已经 emit 出去的 head/diff 没法收回，只能确保最终 finish_reason 反映过滤后的状态。
        # 但完全 drop 已发的 call 会让客户端拿到无效调用，所以这里不再二次过滤；
        # 流式无 retry 兜底，required/forced 不满足就走文本 stop。
        valid_call_state = [
            s for s, c in zip(call_state, final_calls) if c["function"]["name"] in kept_names
        ] if choice.get("mode") == "forced" else call_state
        if not valid_call_state:
            call_state = []

    if not sent_role:
        # 进了工具模式但一个 call 都没解析出来（只看到悬空 <tool_calls>），
        # 退回成普通文本：把可见文本补完，stop 收尾
        final_visible = _strip_tool_markup(full_text)
        tail = final_visible[len(streamed_visible):]
        if tail:
            yield emit({"content": tail})
        if not sent_role:
            yield emit({"content": ""})
        yield completion_chunk(model, {}, "stop", completion_id, created)
        return

    if not call_state:
        yield completion_chunk(model, {}, "stop", completion_id, created)
        return

    yield completion_chunk(model, {}, "tool_calls", completion_id, created)


_TOOL_CALL_OPEN_RE = re.compile(r"(?is)<tool_call\b[^>]*>")
_TOOL_CALL_CLOSE_RE = re.compile(r"(?is)</tool_call>")
_TOOL_NAME_RE = re.compile(r"(?is)<tool_name\b[^>]*>(.*?)</tool_name>")
_TOOL_PARAMS_OPEN_RE = re.compile(r"(?is)<parameters\b[^>]*>")
_TOOL_PARAMS_CLOSE_RE = re.compile(r"(?is)</parameters>")


def _scan_partial_tool_calls(text: str) -> list[dict[str, Any]]:
    """扫描当前累计文本，按出现顺序返回每个 <tool_call> 块的部分状态。

    返回的每一项：
      name: 已闭合的 tool 名（未闭合则 None）
      args_text: <parameters> 内的累积文本（不含 <parameters>/</parameters> 标签）
      args_complete: </parameters> 已出现
      call_complete: </tool_call> 已出现
    """
    cleaned = re.sub(r"(?is)```.*?```", "", text or "")
    results: list[dict[str, Any]] = []
    pos = 0
    while True:
        m = _TOOL_CALL_OPEN_RE.search(cleaned, pos)
        if not m:
            break
        body_start = m.end()
        close = _TOOL_CALL_CLOSE_RE.search(cleaned, body_start)
        body_end = close.start() if close else len(cleaned)
        body = cleaned[body_start:body_end]

        name_match = _TOOL_NAME_RE.search(body)
        name = name_match.group(1).strip() if name_match else None

        params_open = _TOOL_PARAMS_OPEN_RE.search(body)
        if params_open:
            args_start = params_open.end()
            params_close = _TOOL_PARAMS_CLOSE_RE.search(body, args_start)
            if params_close:
                args_text = body[args_start:params_close.start()]
                args_complete = True
            else:
                args_text = body[args_start:]
                args_complete = False
        else:
            args_text = ""
            args_complete = False

        results.append({
            "name": name,
            "args_text": args_text,
            "args_complete": args_complete,
            "call_complete": close is not None,
        })
        if close is None:
            break
        pos = close.end()
    return results


def collect_chat_content(chunks: Iterable[dict[str, Any]]) -> str:
    parts: list[str] = []
    for chunk in chunks:
        choices = chunk.get("choices")
        first = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
        delta = first.get("delta") if isinstance(first.get("delta"), dict) else {}
        content = str(delta.get("content") or "")
        if content:
            parts.append(content)
    return "".join(parts)


def chat_messages_from_body(body: dict[str, Any]) -> list[dict[str, Any]]:
    messages = body.get("messages")
    if isinstance(messages, list) and messages:
        return [message for message in messages if isinstance(message, dict)]
    prompt = str(body.get("prompt") or "").strip()
    if prompt:
        return [{"role": "user", "content": prompt}]
    raise HTTPException(status_code=400, detail={"error": "messages or prompt is required"})


def chat_image_args(body: dict[str, Any]) -> tuple[str, str, int, list[tuple[bytes, str, str]]]:
    model = str(body.get("model") or "gpt-image-2").strip() or "gpt-image-2"
    prompt = extract_chat_prompt(body)
    if not prompt:
        raise HTTPException(status_code=400, detail={"error": "prompt is required"})
    images = [
        (data, f"image_{idx}.png", mime)
        for idx, (data, mime) in enumerate(extract_chat_image(body), start=1)
    ]
    return model, prompt, parse_image_count(body.get("n")), images


def text_chat_parts(body: dict[str, Any]) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]] | None, dict[str, Any]]:
    model = str(body.get("model") or "auto").strip() or "auto"
    raw_messages = chat_messages_from_body(body)
    raw_messages = _convert_history_for_tools(raw_messages)

    tools = body.get("tools") if isinstance(body.get("tools"), list) else None
    choice = _resolve_tool_choice(body)

    # tool_choice=none 时直接把 tools 抹掉，不触发工具模式
    if tools and choice.get("mode") == "none":
        tools = None

    tool_system = build_tool_system_prompt(tools, choice) if tools else ""

    if tool_system:
        # 优先合并到现有 system,避免多条 system 被部分客户端忽略
        merged: list[dict[str, Any]] = []
        injected = False
        for msg in raw_messages:
            if not injected and isinstance(msg, dict) and msg.get("role") == "system":
                content = msg.get("content")
                if isinstance(content, str):
                    merged.append({"role": "system", "content": f"{content.strip()}\n\n{tool_system}"})
                else:
                    merged.append(msg)
                    merged.append({"role": "system", "content": tool_system})
                injected = True
            else:
                merged.append(msg)
        if not injected:
            merged.insert(0, {"role": "system", "content": tool_system})
        raw_messages = merged

    messages = normalize_messages(raw_messages)
    return model, messages, tools, choice


def image_result_content(result: dict[str, Any]) -> str:
    data = result.get("data")
    if isinstance(data, list) and data:
        return build_chat_image_markdown_content(result)
    return str(result.get("message") or "Image generation completed.")


def image_chat_response(body: dict[str, Any]) -> dict[str, Any]:
    model, prompt, n, images = chat_image_args(body)
    result = collect_image_outputs(stream_image_outputs_with_pool(ConversationRequest(
        prompt=prompt,
        model=model,
        n=n,
        response_format="b64_json",
        images=encode_images(images) or None,
    )))
    return completion_response(model, image_result_content(result), int(result.get("created") or 0) or None)


def image_chat_events(body: dict[str, Any]) -> Iterator[dict[str, Any]]:
    model, prompt, n, images = chat_image_args(body)
    image_outputs = stream_image_outputs_with_pool(ConversationRequest(
        prompt=prompt,
        model=model,
        n=n,
        response_format="b64_json",
        images=encode_images(images) or None,
    ))
    yield from stream_image_chat_completion(image_outputs, model)


def stream_image_chat_completion(image_outputs: Iterable[ImageOutput], model: str) -> Iterator[dict[str, Any]]:
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())
    sent_role = False
    sent_text = ""
    for output in image_outputs:
        content = ""
        if output.kind == "progress":
            content = output.text
            sent_text += content
        elif output.kind == "result":
            content = build_chat_image_markdown_content({"data": output.data})
        elif output.kind == "message":
            content = output.text[len(sent_text):] if output.text.startswith(sent_text) else output.text
        if not content:
            continue
        if not sent_role:
            sent_role = True
            yield completion_chunk(model, {"role": "assistant", "content": content}, None, completion_id, created)
        else:
            yield completion_chunk(model, {"content": content}, None, completion_id, created)
    if not sent_role:
        yield completion_chunk(model, {"role": "assistant", "content": ""}, None, completion_id, created)
    yield completion_chunk(model, {}, "stop", completion_id, created)


def handle(body: dict[str, Any]) -> dict[str, Any] | Iterator[dict[str, Any]]:
    if body.get("stream"):
        if is_image_chat_request(body):
            return image_chat_events(body)
        model, messages, tools, choice = text_chat_parts(body)
        if tools:
            return stream_text_chat_completion_with_tools(text_backend(), messages, model, tools, choice)
        return stream_text_chat_completion(text_backend(), messages, model)
    if is_image_chat_request(body):
        return image_chat_response(body)
    model, messages, tools, choice = text_chat_parts(body)
    if not tools:
        request = ConversationRequest(model=model, messages=messages)
        return completion_response(model, collect_text(text_backend(), request), messages=messages)

    request = ConversationRequest(model=model, messages=messages)
    text = collect_text(text_backend(), request)
    tool_calls = _tool_calls_from_text(text)
    tool_calls = _apply_choice_filter(tool_calls, choice)

    # required / forced 没调出工具：用一条强约束 nudge 重试一次
    if _required_violation(choice, tool_calls):
        retry_messages = normalize_messages(_required_retry_messages(messages, text, choice))
        retry_text = collect_text(text_backend(), ConversationRequest(model=model, messages=retry_messages))
        retry_calls = _apply_choice_filter(_tool_calls_from_text(retry_text), choice)
        if retry_calls:
            tool_calls = retry_calls
            text = retry_text
        # 重试还是没出，就把原始文本回去（让客户端能看到模型说了啥）

    if tool_calls:
        return completion_response(model, _strip_tool_markup(text), messages=messages, tool_calls=tool_calls)
    return completion_response(model, text, messages=messages)
