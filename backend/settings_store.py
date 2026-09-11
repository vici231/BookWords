"""settings_store.py — 统一设置存取（api / zhihu / theme 三组）。

设计原则：
- settings.json 是唯一落盘位置，原子替换写入（tmp + replace）；
- 对外只通过 public() 输出脱敏视图，明文密钥不出后端；
- 环境变量仅作运行时兜底（不写回文件）：
    OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL / BACKUP_LLM_ENABLED / ZHIHU_ACCESS_SECRET

该模块不依赖任何其他业务模块，ai_service / zhihu_service / app 都从这里读设置，
避免「知乎服务反向依赖 AI 服务」的耦合。
"""

from __future__ import annotations

import copy
import json
import logging
import os
import re
from pathlib import Path

logger = logging.getLogger(__name__)

SETTINGS_PATH = Path(__file__).resolve().parent / "settings.json"

DEFAULT_SETTINGS: dict = {
    "api": {"base_url": "https://api.deepseek.com", "api_key": "", "model": ""},
    "zhihu": {"access_secret": ""},
    "theme": "paper",
}

_THEMES = ("paper", "ink")


def normalize_base_url(url: str) -> str:
    """容错归一：去掉首尾空白、多余的 /chat/completions 后缀与尾部斜杠。"""
    url = (url or "").strip()
    url = re.sub(r"/chat/completions/?$", "", url)
    return url.rstrip("/")


def load() -> dict:
    """读取 settings.json；文件缺失或损坏时回退默认值（不回写）。"""
    data = copy.deepcopy(DEFAULT_SETTINGS)
    if not SETTINGS_PATH.is_file():
        return data
    try:
        raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8-sig"))  # 兼容带 BOM 的文件
    except (json.JSONDecodeError, OSError):
        logger.warning("settings.json 读取失败，使用默认设置")
        return data
    if not isinstance(raw, dict):
        return data
    api = raw.get("api") if isinstance(raw.get("api"), dict) else {}
    for key in ("base_url", "api_key", "model"):
        if api.get(key) is not None:
            data["api"][key] = api[key]
    zh = raw.get("zhihu") if isinstance(raw.get("zhihu"), dict) else {}
    if zh.get("access_secret") is not None:
        data["zhihu"]["access_secret"] = str(zh["access_secret"])
    if raw.get("theme") in _THEMES:
        data["theme"] = raw["theme"]
    return data


def _write(data: dict) -> None:
    tmp = SETTINGS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(SETTINGS_PATH)  # 原子替换，避免半写文件


def save(payload: dict) -> dict:
    """合并保存前端提交的设置；返回脱敏视图（不回传明文密钥）。

    只更新 payload 中出现的字段：前端「留空 = 保持不变」时省略该字段；
    显式提交空串才表示清除。
    """
    cur = load()
    api_in = payload.get("api") if isinstance(payload.get("api"), dict) else {}
    if "base_url" in api_in:
        cur["api"]["base_url"] = normalize_base_url(str(api_in.get("base_url") or ""))
    if "api_key" in api_in:
        cur["api"]["api_key"] = str(api_in.get("api_key") or "").strip()
    if "model" in api_in:
        cur["api"]["model"] = str(api_in.get("model") or "").strip()
    zh_in = payload.get("zhihu") if isinstance(payload.get("zhihu"), dict) else {}
    if "access_secret" in zh_in:
        cur["zhihu"]["access_secret"] = str(zh_in.get("access_secret") or "").strip()
    if payload.get("theme") in _THEMES:
        cur["theme"] = payload["theme"]
    _write(cur)
    return public(cur)


def reset() -> dict:
    """清除所有已保存设置（含 API Key / 知乎 Secret），回到安全默认值。"""
    try:
        SETTINGS_PATH.unlink(missing_ok=True)
    except OSError:
        logger.exception("settings.json 删除失败")
    return public(DEFAULT_SETTINGS)


def _mask(secret: str) -> str:
    if len(secret) > 8:
        return f"{secret[:3]}…{secret[-4:]}"
    return "已设置" if secret else ""


def public(data: dict | None = None) -> dict:
    """对外脱敏视图：只回传掩码，不回传明文 API Key / Access Secret。"""
    data = data or load()
    return {
        "api": {
            "base_url": data["api"].get("base_url", ""),
            "model": data["api"].get("model", ""),
            "has_key": bool(data["api"].get("api_key")),
            "api_key_masked": _mask(data["api"].get("api_key", "")),
        },
        "zhihu": {
            "has_secret": bool(data["zhihu"].get("access_secret")),
            "access_secret_masked": _mask(data["zhihu"].get("access_secret", "")),
        },
        "theme": data.get("theme", "paper"),
    }


def effective_api() -> dict:
    """合并 settings.json 与环境变量，得到最终生效的 AI 配置。"""
    s = load()
    api = s["api"]
    api_key = (api.get("api_key") or "").strip() or os.environ.get("OPENAI_API_KEY", "").strip()
    base_url = normalize_base_url(
        (api.get("base_url") or "").strip()
        or os.environ.get("OPENAI_BASE_URL", "").strip()
        or "https://api.deepseek.com"
    )
    model = (api.get("model") or "").strip() or os.environ.get("OPENAI_MODEL", "").strip()
    return {"api_key": api_key, "base_url": base_url, "model": model}


def backup_api() -> dict:
    """Return the optional environment-only OpenAI-compatible backup configuration."""
    enabled = os.environ.get("BACKUP_LLM_ENABLED", "false").strip().casefold() in ("1", "true", "yes", "on")
    return {
        "enabled": enabled,
        "api_key": os.environ.get("OPENAI_API_KEY", "").strip(),
        "base_url": normalize_base_url(os.environ.get("OPENAI_BASE_URL", "").strip()),
        "model": os.environ.get("OPENAI_MODEL", "").strip(),
    }


def effective_api_from(payload: dict) -> dict:
    """用前端表单候选值（不落盘）构造配置，用于连通性测试。"""
    saved = load()["api"]
    api = payload.get("api") if isinstance(payload.get("api"), dict) else {}
    api_key = (
        str(api.get("api_key") or "").strip()
        or str(saved.get("api_key") or "").strip()
        or os.environ.get("OPENAI_API_KEY", "").strip()
    )
    base_url = normalize_base_url(
        str(api.get("base_url") or "").strip()
        or str(saved.get("base_url") or "").strip()
        or os.environ.get("OPENAI_BASE_URL", "").strip()
        or "https://api.deepseek.com"
    )
    model = (
        str(api.get("model") or "").strip()
        or str(saved.get("model") or "").strip()
        or os.environ.get("OPENAI_MODEL", "").strip()
    )
    return {"api_key": api_key, "base_url": base_url, "model": model}


def zhihu_secret() -> str:
    """知乎 Access Secret（优先环境变量，其次 settings.json）。"""
    return (
        os.environ.get("ZHIHU_ACCESS_SECRET", "").strip()
        or (load()["zhihu"].get("access_secret") or "").strip()
    )
