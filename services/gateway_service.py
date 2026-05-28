"""API Gateway 状态管理服务。

跟踪请求统计、运行状态，提供给前端管理面板使用。
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from services.config import DATA_DIR


GATEWAY_CONFIG_FILE = DATA_DIR / "gateway_config.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class GatewayService:
    def __init__(self):
        self._lock = threading.Lock()
        self._started_at: str = _now_iso()
        self._total_requests: int = 0
        self._success_requests: int = 0
        self._error_requests: int = 0
        self._last_error: str = ""
        self._last_error_at: str = ""
        self._config = self._load_config()

    def _load_config(self) -> dict:
        defaults = {
            "enabled": True,
            "port": 3001,
            "route_strategy": "round_robin",
            "account_source": "pool",
            "allow_remote": True,
            "localhost_only": False,
            "ip_whitelist": [],
            "switch_threshold": 90,
            "log_level": "info",
            "auto_start": True,
            "client_keys": [],
            "last_sync": _now_iso(),
        }
        try:
            if GATEWAY_CONFIG_FILE.exists():
                saved = json.loads(GATEWAY_CONFIG_FILE.read_text(encoding="utf-8"))
                if isinstance(saved, dict):
                    defaults.update(saved)
        except Exception:
            pass
        return defaults

    def _save_config(self) -> None:
        GATEWAY_CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        GATEWAY_CONFIG_FILE.write_text(
            json.dumps(self._config, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def get_status(self) -> dict:
        with self._lock:
            total = self._total_requests
            success = self._success_requests
            error = self._error_requests
            success_rate = round(success * 100 / max(1, total), 1)
            error_rate = round(error * 100 / max(1, total), 1)
            return {
                "running": self._config.get("enabled", True),
                "started_at": self._started_at,
                "total_requests": total,
                "success_requests": success,
                "error_requests": error,
                "success_rate": success_rate,
                "error_rate": error_rate,
                "last_error": self._last_error,
                "last_error_at": self._last_error_at,
                "last_sync": self._config.get("last_sync", ""),
            }

    def get_config(self) -> dict:
        with self._lock:
            return dict(self._config)

    def update_config(self, updates: dict) -> dict:
        with self._lock:
            self._config.update(updates)
            self._config["last_sync"] = _now_iso()
            self._save_config()
            return dict(self._config)

    def record_request(self, success: bool, error: str = "") -> None:
        with self._lock:
            self._total_requests += 1
            if success:
                self._success_requests += 1
            else:
                self._error_requests += 1
                self._last_error = error
                self._last_error_at = _now_iso()

    def reset_stats(self) -> None:
        with self._lock:
            self._total_requests = 0
            self._success_requests = 0
            self._error_requests = 0
            self._last_error = ""
            self._last_error_at = ""
            self._started_at = _now_iso()

    def add_client_key(self, key: str) -> dict:
        with self._lock:
            keys = self._config.get("client_keys") or []
            if not any(k.get("key") == key for k in keys):
                keys.append({"key": key, "enabled": True, "created_at": _now_iso()})
            self._config["client_keys"] = keys
            self._save_config()
            return dict(self._config)

    def remove_client_key(self, key: str) -> dict:
        with self._lock:
            keys = self._config.get("client_keys") or []
            self._config["client_keys"] = [k for k in keys if k.get("key") != key]
            self._save_config()
            return dict(self._config)

    def toggle_client_key(self, key: str, enabled: bool) -> dict:
        with self._lock:
            keys = self._config.get("client_keys") or []
            for k in keys:
                if k.get("key") == key:
                    k["enabled"] = enabled
            self._config["client_keys"] = keys
            self._save_config()
            return dict(self._config)


gateway_service = GatewayService()
