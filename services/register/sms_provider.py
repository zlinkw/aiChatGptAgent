"""SMS 接码平台对接模块。

兼容 SMSPro 风格的极简 API：每个接口都是 `GET {BASE_URL}/{action}/{code}`，
响应是纯文本（手机号 / SMS 列表 / `ok` / 错误码）。

平台地址通过环境变量 `SMS_PROVIDER_BASE_URL` 或注册机 `sms.base_url` 配置项指定，
默认为空（未配置时调用会报错）。
"""

from __future__ import annotations

import os
import time
import threading
from typing import Any

import requests


# 全局默认值。可被 sms_config["base_url"] 覆盖。
BASE_URL = os.environ.get("SMS_PROVIDER_BASE_URL", "").rstrip("/")

_code_index = 0
_code_lock = threading.Lock()


class SMSProError(Exception):
    """SMS 接码平台 API 调用失败。"""

    def __init__(self, action: str, status: int, body: str):
        self.action = action
        self.status = status
        self.body = body
        super().__init__(f"SMS provider {action} 失败 (HTTP {status}): {body}")


def _resolve_base_url(sms_config: dict | None = None) -> str:
    """优先使用 sms_config 中的 base_url，其次回退到全局 BASE_URL。"""
    if isinstance(sms_config, dict):
        cfg_url = str(sms_config.get("base_url") or "").strip().rstrip("/")
        if cfg_url:
            return cfg_url
    if not BASE_URL:
        raise RuntimeError(
            "SMS provider base_url 未配置。请在注册机配置中设置 sms.base_url，"
            "或通过环境变量 SMS_PROVIDER_BASE_URL 指定。"
        )
    return BASE_URL


def _call(action: str, code: str, timeout: float = 20, sms_config: dict | None = None) -> str:
    """统一调用 SMS 接码 API。成功返回 body 文本，失败抛 SMSProError。"""
    base = _resolve_base_url(sms_config)
    url = f"{base}/{action}/{code}"
    resp = requests.get(url, timeout=timeout, verify=False)
    if resp.status_code == 429:
        raise SMSProError(action, 429, resp.text)
    if resp.status_code != 200:
        raise SMSProError(action, resp.status_code, resp.text)
    return resp.text.strip()


def _next_code(sms_config: dict) -> str:
    """从兑换码列表中轮询取下一个可用的兑换码。"""
    global _code_index
    codes = [str(c).strip() for c in (sms_config.get("codes") or []) if str(c).strip()]
    if not codes:
        raise RuntimeError("sms.codes 没有配置兑换码")
    with _code_lock:
        code = codes[_code_index % len(codes)]
        _code_index = (_code_index + 1) % len(codes)
        return code


def activate(sms_config: dict) -> dict[str, str]:
    """激活一个兑换码，获取手机号。

    返回 {"code": 兑换码, "phone": 手机号}
    """
    code = _next_code(sms_config)
    phone = _call("activate", code, sms_config=sms_config)
    return {"code": code, "phone": phone}


def wait_for_sms(code: str, target_count: int = 1, timeout: float = 300, interval: float = 3, sms_config: dict | None = None) -> str:
    """轮询等待第 target_count 条短信验证码。

    返回验证码字符串。
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        text = _call("status", code, sms_config=sms_config)
        codes = [c for c in text.split("\n") if c.strip()]
        if len(codes) >= target_count:
            return codes[target_count - 1].strip()
        time.sleep(interval)
    raise TimeoutError(f"SMS 等待第 {target_count} 条短信超时 ({timeout}s)")


def request_next_sms(code: str, sms_config: dict | None = None) -> None:
    """请求同号的下一条短信。"""
    _call("next", code, sms_config=sms_config)


def change_number(code: str, sms_config: dict | None = None) -> str:
    """换号，返回新手机号。"""
    return _call("change", code, sms_config=sms_config)


def get_phone_and_code(sms_config: dict, timeout: float = 300) -> dict[str, str]:
    """一站式：激活拿号 → 等验证码 → 返回 {phone, sms_code, redeem_code}。

    如果 5 分钟内没收到短信且满足换号条件，会自动尝试换号一次。
    """
    result = activate(sms_config)
    redeem_code = result["code"]
    phone = result["phone"]

    try:
        sms_code = wait_for_sms(redeem_code, target_count=1, timeout=timeout, sms_config=sms_config)
        return {"phone": phone, "sms_code": sms_code, "redeem_code": redeem_code}
    except TimeoutError:
        # 尝试换号
        try:
            phone = change_number(redeem_code, sms_config=sms_config)
            sms_code = wait_for_sms(redeem_code, target_count=1, timeout=timeout, sms_config=sms_config)
            return {"phone": phone, "sms_code": sms_code, "redeem_code": redeem_code}
        except (SMSProError, TimeoutError) as e:
            raise RuntimeError(f"SMS 接码失败（换号后仍超时）: {e}") from e
