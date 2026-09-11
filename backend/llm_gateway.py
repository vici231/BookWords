"""Unified LLM gateway for model switching, retries, caching, and metrics.

Business skills call :func:`complete`; provider-specific HTTP details stay here.
The JSONL log intentionally excludes prompts and credentials.
"""

from __future__ import annotations

import json
import logging
import requests
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
logger = logging.getLogger(__name__)

LOG_DIR = Path(__file__).resolve().parent / "runtime"
LOG_PATH = LOG_DIR / "llm_calls.jsonl"
_recent: deque[dict] = deque(maxlen=300)
_lock = threading.RLock()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _estimate_tokens(value: object) -> int:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    # Providers occasionally omit usage. This conservative estimate keeps every call measurable.
    latin = sum(1 for char in text if ord(char) < 128)
    non_latin = len(text) - latin
    return max(1, round(latin / 4 + non_latin / 1.6))


def _usage(payload: dict, messages: list[dict], content: str) -> dict:
    raw = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    input_tokens = raw.get("prompt_tokens", raw.get("input_tokens"))
    output_tokens = raw.get("completion_tokens", raw.get("output_tokens"))
    estimated = input_tokens is None or output_tokens is None
    input_tokens = int(input_tokens) if input_tokens is not None else _estimate_tokens(messages)
    output_tokens = int(output_tokens) if output_tokens is not None else _estimate_tokens(content)
    total_tokens = raw.get("total_tokens")
    total_tokens = int(total_tokens) if total_tokens is not None else input_tokens + output_tokens
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "estimated": estimated,
    }


def _write_log(record: dict) -> None:
    with _lock:
        _recent.appendleft(dict(record))
        try:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            with LOG_PATH.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        except OSError:
            logger.exception("LLM metrics log could not be written")


def recent_calls(limit: int = 100) -> list[dict]:
    limit = max(1, min(int(limit or 100), 300))
    with _lock:
        if _recent:
            return [dict(item) for item in list(_recent)[:limit]]
        if not LOG_PATH.is_file():
            return []
        try:
            lines = LOG_PATH.read_text(encoding="utf-8").splitlines()[-limit:]
            return [json.loads(line) for line in reversed(lines) if line.strip()]
        except (OSError, json.JSONDecodeError):
            logger.exception("LLM metrics log could not be read")
            return []


def clear_logs() -> None:
    with _lock:
        _recent.clear()
        try:
            LOG_PATH.unlink(missing_ok=True)
        except OSError:
            logger.exception("LLM metrics log could not be cleared")


def record_fallback(skill_name: str, prompt_version: str, reason: str, config: dict | None = None,
                    metadata: dict | None = None) -> dict:
    cfg = config or {"model": "zhida-thinking-1p5"}
    now = _utc_now()
    record = {
        "skill": skill_name,
        "prompt_version": prompt_version,
        "model": "zhida-thinking-1p5",
        "started_at": now,
        "ended_at": now,
        "elapsed_ms": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "estimated_tokens": False,
        "fallback": True,
        "cache_hit": False,
        "status": "fallback",
        "reason": str(reason)[:400],
        "metadata": metadata or {},
    }
    _write_log(record)
    return record


def complete(*, skill_name: str, prompt_version: str, messages: list[dict], config: dict | None = None,
             json_mode: bool = False, temperature: float = 0.7, timeout: tuple = (10, 120),
             retries: int = 1, cache: bool = True, metadata: dict | None = None) -> dict:
    """Call the configured OpenAI-compatible chat-completions endpoint."""
    started_at = _utc_now()
    started = time.monotonic()
    cfg = config or {}
    requested_model = str(cfg.get("model") or "")
    provider_name = str(cfg.get("provider_name") or "OpenAI 兼容 API")
    try:
        response = _openai_complete(messages, cfg, timeout=timeout, temperature=temperature)
        content = response["content"]
        usage = _usage({"usage": response.get("usage") or {}}, messages, content)
        cache_hit = bool(response.get("cache_hit"))
        record = {
            "skill": skill_name,
            "prompt_version": prompt_version,
            "provider": response.get("provider") or provider_name,
            "model": response.get("model") or requested_model,
            "started_at": response.get("started_at") or started_at,
            "ended_at": response.get("ended_at") or _utc_now(),
            "elapsed_ms": int(response.get("elapsed_ms") or 0),
            **{key: value for key, value in usage.items() if key != "estimated"},
            "estimated_tokens": usage["estimated"],
            "fallback": False,
            "cache_hit": cache_hit,
            "stale_cache": bool(response.get("stale")),
            "status": "success",
            "attempt": 0 if cache_hit else 1,
            "quota": response.get("quota") or {},
            "metadata": metadata or {},
        }
        _write_log(record)
        return {"content": content, "usage": usage, "metrics": record}
    except Exception as exc:
        estimated = _estimate_tokens(messages)
        record = {
            "skill": skill_name, "prompt_version": prompt_version,
            "provider": provider_name, "model": requested_model,
            "started_at": started_at, "ended_at": _utc_now(),
            "elapsed_ms": int((time.monotonic() - started) * 1000),
            "input_tokens": estimated, "output_tokens": 0, "total_tokens": estimated,
            "estimated_tokens": True, "fallback": False, "cache_hit": False,
            "status": "error", "attempt": 1, "reason": str(exc)[:400],
            "metadata": metadata or {},
        }
        _write_log(record)
        raise RuntimeError(str(exc)) from exc


def _openai_complete(messages: list[dict], cfg: dict, *, timeout: tuple,
                     temperature: float) -> dict:
    if not cfg["api_key"] or not cfg["base_url"] or not cfg["model"]:
        raise RuntimeError("文章生成 API 配置不完整，需要 Base URL、API Key 和模型")
    started = time.monotonic()
    response = requests.post(
        f"{cfg['base_url']}/chat/completions",
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
        json={"model": cfg["model"], "messages": messages, "stream": False, "temperature": temperature},
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    try:
        content = str(data["choices"][0]["message"]["content"])
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("文章生成 API 返回结构不完整") from exc
    return {
        "content": content,
        "usage": data.get("usage") if isinstance(data.get("usage"), dict) else {},
        "model": str(data.get("model") or cfg["model"]),
        "provider": str(cfg.get("provider_name") or "OpenAI 兼容 API"),
        "cache_hit": False,
        "stale": False,
        "started_at": _utc_now(),
        "ended_at": _utc_now(),
        "elapsed_ms": int((time.monotonic() - started) * 1000),
        "quota": {},
    }
