from __future__ import annotations

import base64
import json
import time
import uuid
from typing import Any, Iterable, Iterator

from fastapi import HTTPException

from services.protocol.conversation import (
    ConversationRequest,
    ImageOutput,
    encode_images,
    stream_image_outputs_with_pool,
    stream_text_deltas,
    text_backend,
)
from services.protocol.openai_v1_chat_complete import (
    _apply_choice_filter,
    _args_semantically_equal,
    _parse_tool_calls_xml,
    _required_retry_messages,
    _required_violation,
    _safe_text_emit,
    _scan_partial_tool_calls,
    _streamable_text,
    _strip_tool_markup,
    _tool_calls_from_text,
    OPENAI_TOOL_RULE,
    build_tool_system_prompt as _build_chat_tool_system,
)
from utils.helper import extract_image_from_message_content, extract_response_prompt, has_response_image_generation_tool


def is_text_response_request(body: dict[str, Any]) -> bool:
    return not has_response_image_generation_tool(body)


def _function_tools(body: dict[str, Any]) -> list[dict[str, Any]]:
    """Responses API 的 tools 是扁平结构 {type, name, description, parameters}。

    只挑 type=function 的 tool，image_generation 等内置工具不归这里管。
    """
    tools = body.get("tools")
    if not isinstance(tools, list):
        return []
    result: list[dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        if str(tool.get("type") or "").strip() != "function":
            continue
        if not str(tool.get("name") or "").strip():
            continue
        result.append(tool)
    return result


def _resolve_response_tool_choice(body: dict[str, Any]) -> dict[str, Any]:
    """Responses 协议的 tool_choice 形态：
       'auto' / 'required' / 'none' / {'type':'function','name':'...'} / {'type':'image_generation'} ...
       这里只处理 function 相关的，image_generation 不归这里管。
    """
    raw = body.get("tool_choice")
    parallel = body.get("parallel_tool_calls")
    parallel_bool = True if parallel is None else bool(parallel)
    if raw == "required":
        return {"mode": "required", "forced_name": "", "parallel": parallel_bool}
    if raw == "none":
        return {"mode": "none", "forced_name": "", "parallel": parallel_bool}
    if isinstance(raw, dict):
        if str(raw.get("type") or "").strip() == "function":
            name = str(raw.get("name") or "").strip()
            if name:
                return {"mode": "forced", "forced_name": name, "parallel": parallel_bool}
    return {"mode": "auto", "forced_name": "", "parallel": parallel_bool}


def _build_response_tool_system(tools: list[dict[str, Any]], choice: dict[str, Any] | None = None) -> str:
    """复用 chat 路径的 system 构造，把 Responses 风格 tools (扁平 type/name) 适配过去。"""
    if not tools:
        return ""
    # 把 Responses 风格转成 chat completions 风格再交给 _build_chat_tool_system
    chat_tools = [
        {
            "type": "function",
            "function": {
                "name": str(tool.get("name") or "").strip(),
                "description": str(tool.get("description") or "").strip(),
                "parameters": tool.get("parameters") or {},
            },
        }
        for tool in tools
    ]
    return _build_chat_tool_system(chat_tools, choice)


def extract_response_image(input_value: object) -> tuple[bytes, str] | None:
    if isinstance(input_value, dict):
        images = extract_image_from_message_content(input_value.get("content"))
        return images[0] if images else None
    if not isinstance(input_value, list):
        return None
    for item in reversed(input_value):
        if isinstance(item, dict) and str(item.get("type") or "").strip() == "input_image":
            image_url = str(item.get("image_url") or "")
            if image_url.startswith("data:"):
                header, _, data = image_url.partition(",")
                mime = header.split(";")[0].removeprefix("data:")
                return base64.b64decode(data), mime or "image/png"
        if isinstance(item, dict):
            images = extract_image_from_message_content(item.get("content"))
            if images:
                return images[0]
    return None


def messages_from_input(
    input_value: object,
    instructions: object = None,
    tool_system: str = "",
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    system_text = str(instructions or "").strip()
    if system_text and tool_system:
        system_text = f"{system_text}\n\n{tool_system}"
    elif tool_system:
        system_text = tool_system
    if system_text:
        messages.append({"role": "system", "content": system_text})
    if isinstance(input_value, str):
        if input_value.strip():
            messages.append({"role": "user", "content": input_value.strip()})
        return messages
    if isinstance(input_value, dict):
        messages.append({
            "role": str(input_value.get("role") or "user"),
            "content": extract_response_prompt([input_value]) or input_value.get("content") or "",
        })
        return messages
    if isinstance(input_value, list):
        # 客户端可能回灌 function_call / function_call_output 这种特殊 item，
        # 模型本身不懂 Responses 协议，所以按号池路径同样的方式翻成纯文本。
        non_meta_items = [item for item in input_value if not _is_response_tool_item(item)]
        meta_messages = _response_tool_messages(input_value)
        if all(isinstance(item, dict) and item.get("type") for item in non_meta_items) and not meta_messages:
            text = extract_response_prompt(input_value)
            if text:
                messages.append({"role": "user", "content": text})
            return messages
        for item in input_value:
            if not isinstance(item, dict):
                continue
            if _is_response_tool_item(item):
                continue
            messages.append({
                "role": str(item.get("role") or "user"),
                "content": extract_response_prompt([item]) or item.get("content") or "",
            })
        messages.extend(meta_messages)
    return messages


def _is_response_tool_item(item: object) -> bool:
    if not isinstance(item, dict):
        return False
    return str(item.get("type") or "") in {"function_call", "function_call_output"}


def _response_tool_messages(items: list[Any]) -> list[dict[str, Any]]:
    """把 input 中的 function_call / function_call_output 转成模型可读的伪原生历史。"""
    messages: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        item_type = str(item.get("type") or "")
        if item_type == "function_call":
            name = str(item.get("name") or "").strip()
            args = item.get("arguments")
            if not isinstance(args, str):
                args = json.dumps(args or {}, ensure_ascii=False)
            messages.append({
                "role": "assistant",
                "content": f"<tool_calls><tool_call><tool_name>{name}</tool_name><parameters>{args}</parameters></tool_call></tool_calls>",
            })
        elif item_type == "function_call_output":
            call_id = str(item.get("call_id") or item.get("id") or "")
            output = item.get("output")
            if not isinstance(output, str):
                output = json.dumps(output, ensure_ascii=False) if output is not None else ""
            messages.append({
                "role": "user",
                "content": f"Tool result {call_id}: {output}".strip(),
            })
    return messages


def text_output_item(text: str, item_id: str | None = None, status: str = "completed") -> dict[str, Any]:
    return {
        "id": item_id or f"msg_{uuid.uuid4().hex}",
        "type": "message",
        "status": status,
        "role": "assistant",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


def image_output_items(prompt: str, data: list[dict[str, Any]], item_id: str | None = None) -> list[dict[str, Any]]:
    output = []
    for item in data:
        b64_json = str(item.get("b64_json") or "").strip()
        if b64_json:
            output.append({
                "id": item_id or f"ig_{len(output) + 1}",
                "type": "image_generation_call",
                "status": "completed",
                "result": b64_json,
                "revised_prompt": str(item.get("revised_prompt") or prompt).strip() or prompt,
            })
    return output


def response_created(response_id: str, model: str, created: int) -> dict[str, Any]:
    return {
        "type": "response.created",
        "response": {
            "id": response_id,
            "object": "response",
            "created_at": created,
            "status": "in_progress",
            "error": None,
            "incomplete_details": None,
            "model": model,
            "output": [],
            "parallel_tool_calls": False,
        },
    }


def response_completed(response_id: str, model: str, created: int, output: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "type": "response.completed",
        "response": {
            "id": response_id,
            "object": "response",
            "created_at": created,
            "status": "completed",
            "error": None,
            "incomplete_details": None,
            "model": model,
            "output": output,
            "parallel_tool_calls": False,
        },
    }


def function_call_item(name: str, arguments: str = "", item_id: str | None = None, call_id: str | None = None, status: str = "in_progress") -> dict[str, Any]:
    return {
        "id": item_id or f"fc_{uuid.uuid4().hex}",
        "type": "function_call",
        "status": status,
        "name": name,
        "arguments": arguments,
        "call_id": call_id or f"call_{uuid.uuid4().hex[:24]}",
    }


def stream_text_response(backend, body: dict[str, Any]) -> Iterator[dict[str, Any]]:
    model = str(body.get("model") or "auto").strip() or "auto"
    fn_tools = _function_tools(body)
    choice = _resolve_response_tool_choice(body) if fn_tools else {"mode": "auto", "forced_name": "", "parallel": True}
    if fn_tools and choice.get("mode") == "none":
        fn_tools = []
    tool_system = _build_response_tool_system(fn_tools, choice) if fn_tools else ""
    messages = messages_from_input(body.get("input"), body.get("instructions"), tool_system)
    response_id = f"resp_{uuid.uuid4().hex}"
    item_id = f"msg_{uuid.uuid4().hex}"
    created = int(time.time())
    full_text = ""
    streamed_visible = ""
    text_item_added = False
    text_item_done = False
    output_items: list[dict[str, Any]] = []
    tool_started = False

    yield response_created(response_id, model, created)

    request = ConversationRequest(model=model, messages=messages)

    # 工具流式状态：每个 call 的 item_id / call_id / 已 emit 的 arguments / 解析模式
    call_states: list[dict[str, Any]] = []

    def emit_text_delta(delta_text: str) -> Iterator[dict[str, Any]]:
        nonlocal text_item_added, streamed_visible
        if not delta_text:
            return
        if not text_item_added:
            text_item_added = True
            yield {
                "type": "response.output_item.added",
                "output_index": 0,
                "item": text_output_item("", item_id, "in_progress"),
            }
        streamed_visible += delta_text
        yield {
            "type": "response.output_text.delta",
            "item_id": item_id,
            "output_index": 0,
            "content_index": 0,
            "delta": delta_text,
        }

    def emit_tool_progress(partials: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
        # parallel=False 时只跟踪第一个 call
        if not choice.get("parallel", True):
            partials = partials[:1]
        # forced 模式：把名字不匹配的丢掉
        if choice.get("mode") == "forced" and choice.get("forced_name"):
            forced = choice["forced_name"]
            partials = [pc for pc in partials if (pc["name"] or "") in ("", forced)]
        for idx, pc in enumerate(partials):
            output_index = idx + (1 if text_item_added else 0)
            if idx >= len(call_states):
                call_states.append({
                    "item_id": f"fc_{uuid.uuid4().hex}",
                    "call_id": f"call_{uuid.uuid4().hex[:24]}",
                    "name": "",
                    "added": False,
                    "mode": "unknown",
                    "emitted_args": "",
                    "done": False,
                })
            state = call_states[idx]

            if not state["added"] and pc["name"]:
                state["name"] = pc["name"]
                state["added"] = True
                yield {
                    "type": "response.output_item.added",
                    "output_index": output_index,
                    "item": function_call_item(state["name"], "", state["item_id"], state["call_id"], "in_progress"),
                }

            if not state["added"]:
                continue

            args_text = pc["args_text"]
            if state["mode"] == "unknown" and args_text:
                head = args_text.lstrip()
                if head.startswith("{") or head.startswith("["):
                    state["mode"] = "json"
                elif head.startswith("<"):
                    state["mode"] = "xml"

            if state["mode"] == "json":
                pending = args_text
                if pending.endswith("\\"):
                    pending = pending[:-1]
                if pending.startswith(state["emitted_args"]):
                    diff = pending[len(state["emitted_args"]):]
                    if diff:
                        state["emitted_args"] = pending
                        yield {
                            "type": "response.function_call_arguments.delta",
                            "item_id": state["item_id"],
                            "output_index": output_index,
                            "delta": diff,
                        }
            elif state["mode"] == "xml" and pc["args_complete"] and not state["emitted_args"]:
                from services.protocol.openai_v1_chat_complete import _parse_tool_params
                canonical = json.dumps(_parse_tool_params(args_text), ensure_ascii=False)
                state["emitted_args"] = canonical
                yield {
                    "type": "response.function_call_arguments.delta",
                    "item_id": state["item_id"],
                    "output_index": output_index,
                    "delta": canonical,
                }

    for delta in stream_text_deltas(backend, request):
        full_text += delta
        if not tool_started:
            visible = _streamable_text(full_text)
            if visible != full_text:
                tool_started = True
            visible = _safe_text_emit(visible)
            if visible.startswith(streamed_visible):
                emit_chunk = visible[len(streamed_visible):]
                if emit_chunk:
                    yield from emit_text_delta(emit_chunk)
        if tool_started and fn_tools:
            yield from emit_tool_progress(_scan_partial_tool_calls(full_text))

    if not tool_started:
        # 普通文本路径，跟旧实现保持一致
        if not text_item_added:
            text_item_added = True
            yield {
                "type": "response.output_item.added",
                "output_index": 0,
                "item": text_output_item("", item_id, "in_progress"),
            }
        # streamed_visible 实际就是 emit 出去的总文本，full_text 跟它应一致
        tail = full_text[len(streamed_visible):]
        if tail:
            yield {
                "type": "response.output_text.delta",
                "item_id": item_id,
                "output_index": 0,
                "content_index": 0,
                "delta": tail,
            }
        yield {
            "type": "response.output_text.done",
            "item_id": item_id,
            "output_index": 0,
            "content_index": 0,
            "text": full_text,
        }
        item = text_output_item(full_text, item_id, "completed")
        output_items.append(item)
        yield {"type": "response.output_item.done", "output_index": 0, "item": item}
        yield response_completed(response_id, model, created, output_items)
        return

    # 工具模式：先把已 emit 的可见文本闭合
    if text_item_added and not text_item_done:
        text_item_done = True
        visible_final = _strip_tool_markup(full_text)
        if visible_final.startswith(streamed_visible):
            tail = visible_final[len(streamed_visible):]
            if tail:
                yield {
                    "type": "response.output_text.delta",
                    "item_id": item_id,
                    "output_index": 0,
                    "content_index": 0,
                    "delta": tail,
                }
                streamed_visible = visible_final
        yield {
            "type": "response.output_text.done",
            "item_id": item_id,
            "output_index": 0,
            "content_index": 0,
            "text": streamed_visible,
        }
        text_item = text_output_item(streamed_visible, item_id, "completed")
        output_items.append(text_item)
        yield {"type": "response.output_item.done", "output_index": 0, "item": text_item}

    # 收尾解析全部工具，对漏 emit 的部分补差
    if fn_tools:
        yield from emit_tool_progress(_scan_partial_tool_calls(full_text))
        final_calls = _tool_calls_from_text(full_text)
        final_calls = _apply_choice_filter(final_calls, choice)
        for idx, call in enumerate(final_calls):
            output_index = idx + (1 if output_items and output_items[0]["type"] == "message" else 0)
            canonical_args = call["function"]["arguments"]
            canonical_name = call["function"]["name"]
            if idx >= len(call_states):
                call_states.append({
                    "item_id": f"fc_{uuid.uuid4().hex}",
                    "call_id": f"call_{uuid.uuid4().hex[:24]}",
                    "name": canonical_name,
                    "added": True,
                    "mode": "json",
                    "emitted_args": "",
                    "done": False,
                })
                yield {
                    "type": "response.output_item.added",
                    "output_index": output_index,
                    "item": function_call_item(canonical_name, "", call_states[idx]["item_id"], call_states[idx]["call_id"], "in_progress"),
                }
            state = call_states[idx]
            if not _args_semantically_equal(state["emitted_args"], canonical_args):
                if canonical_args.startswith(state["emitted_args"]):
                    diff = canonical_args[len(state["emitted_args"]):]
                    if diff:
                        yield {
                            "type": "response.function_call_arguments.delta",
                            "item_id": state["item_id"],
                            "output_index": output_index,
                            "delta": diff,
                        }
                else:
                    diff = canonical_args[len(state["emitted_args"]):]
                    if diff:
                        yield {
                            "type": "response.function_call_arguments.delta",
                            "item_id": state["item_id"],
                            "output_index": output_index,
                            "delta": diff,
                        }
                state["emitted_args"] = canonical_args
            if not state["done"]:
                state["done"] = True
                yield {
                    "type": "response.function_call_arguments.done",
                    "item_id": state["item_id"],
                    "output_index": output_index,
                    "arguments": state["emitted_args"],
                }
                completed_item = function_call_item(
                    state["name"] or canonical_name,
                    state["emitted_args"],
                    state["item_id"],
                    state["call_id"],
                    "completed",
                )
                output_items.append(completed_item)
                yield {
                    "type": "response.output_item.done",
                    "output_index": output_index,
                    "item": completed_item,
                }

    yield response_completed(response_id, model, created, output_items)


def stream_image_response(image_outputs: Iterable[ImageOutput], prompt: str, model: str) -> Iterator[dict[str, Any]]:
    response_id = f"resp_{uuid.uuid4().hex}"
    created = int(time.time())
    yield response_created(response_id, model, created)
    for output in image_outputs:
        if output.kind == "message":
            text = output.text
            item = text_output_item(text)
            yield {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": text}
            yield {"type": "response.output_text.done", "item_id": item["id"], "output_index": 0, "content_index": 0, "text": text}
            yield {"type": "response.output_item.done", "output_index": 0, "item": item}
            yield response_completed(response_id, model, created, [item])
            return
        if output.kind != "result":
            continue
        items = image_output_items(prompt, output.data)
        if items:
            item = items[0]
            yield {"type": "response.output_item.done", "output_index": 0, "item": item}
            yield response_completed(response_id, model, created, [item])
            return
    raise RuntimeError("image generation failed")


def collect_response(events: Iterable[dict[str, Any]]) -> dict[str, Any]:
    completed = {}
    for event in events:
        if event.get("type") == "response.completed":
            completed = event.get("response") if isinstance(event.get("response"), dict) else {}
    if not completed:
        raise RuntimeError("response generation failed")
    return completed


def response_events(body: dict[str, Any]) -> Iterator[dict[str, Any]]:
    if is_text_response_request(body):
        yield from stream_text_response(text_backend(), body)
        return

    prompt = extract_response_prompt(body.get("input"))
    if not prompt:
        raise HTTPException(status_code=400, detail={"error": "input text is required"})
    model = str(body.get("model") or "gpt-image-2").strip() or "gpt-image-2"
    image_info = extract_response_image(body.get("input"))
    if image_info:
        image_data, mime_type = image_info
        images = encode_images([(image_data, "image.png", mime_type)])
    else:
        images = None
    image_outputs = stream_image_outputs_with_pool(ConversationRequest(
        prompt=prompt,
        model=model,
        size=None if images else "1:1",
        response_format="b64_json",
        images=images,
    ))
    yield from stream_image_response(image_outputs, prompt, model)


def handle(body: dict[str, Any]) -> dict[str, Any] | Iterator[dict[str, Any]]:
    events = response_events(body)
    if body.get("stream"):
        return events
    response = collect_response(events)

    # required / forced 兜底：非流式时重试一次
    fn_tools = _function_tools(body)
    if not fn_tools:
        return response
    choice = _resolve_response_tool_choice(body)
    if choice.get("mode") not in ("required", "forced"):
        return response

    output = response.get("output") or []
    has_function_call = any(isinstance(o, dict) and o.get("type") == "function_call" for o in output)
    if has_function_call:
        # forced 名字校验
        if choice.get("mode") == "forced":
            forced = choice.get("forced_name", "")
            kept = [o for o in output if isinstance(o, dict) and o.get("type") != "function_call" or o.get("name") == forced]
            response["output"] = kept
            if any(isinstance(o, dict) and o.get("type") == "function_call" for o in kept):
                return response
            # forced 名字不对：走重试
        else:
            return response

    # 重试：把上一轮的纯文本作为 assistant 历史，加一条强制 nudge，再跑一次
    assistant_text = ""
    for o in output:
        if isinstance(o, dict) and o.get("type") == "message":
            for c in o.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "output_text":
                    assistant_text += str(c.get("text") or "")

    retry_body = dict(body)
    base_input = body.get("input")
    if isinstance(base_input, str):
        retry_input: list[Any] = [{"type": "message", "role": "user", "content": base_input}]
    elif isinstance(base_input, list):
        retry_input = list(base_input)
    elif isinstance(base_input, dict):
        retry_input = [base_input]
    else:
        retry_input = []
    if assistant_text.strip():
        retry_input.append({
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": assistant_text}],
        })
    forced = choice.get("forced_name", "")
    nudge = (
        f"You did not call any tool. You MUST call the tool '{forced}' now using the XML protocol. "
        "Output ONLY <tool_calls>...</tool_calls>. No prose, no markdown."
        if choice.get("mode") == "forced" and forced
        else (
            "You did not call any tool. You MUST call exactly one tool now using the XML protocol. "
            "Output ONLY <tool_calls>...</tool_calls>. No prose, no markdown."
        )
    )
    retry_input.append({"type": "message", "role": "user", "content": nudge})
    retry_body["input"] = retry_input
    retry_response = collect_response(response_events(retry_body))
    retry_output = retry_response.get("output") or []
    if any(isinstance(o, dict) and o.get("type") == "function_call" for o in retry_output):
        return retry_response
    return response
