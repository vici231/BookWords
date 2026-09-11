"""Official Zhihu API gateway with persistent cache and a local daily budget.

Only two upstream capabilities are used by the article workflow:
- zhihu_search: selects verifiable answers/articles with at least 5,000 upvotes.
- zhida_openai: generates the bilingual learning article.

The state file contains cache entries and counters only. Credentials are never persisted here.
"""

from __future__ import annotations

import hashlib
import html
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import requests

try:
    from backend import settings_store
except ImportError:  # pragma: no cover - direct backend/app.py execution
    import settings_store  # type: ignore

logger = logging.getLogger(__name__)

DEVELOPER_BASE = "https://developer.zhihu.com"
SEARCH_URL = f"{DEVELOPER_BASE}/api/v1/content/zhihu_search"
ZHIDA_URL = f"{DEVELOPER_BASE}/v1/chat/completions"
QUOTA_URL = f"{DEVELOPER_BASE}/api/v1/quota"
DAILY_CALL_LIMIT = 10
GENERATION_DAILY_CALL_LIMIT = max(1, int(os.environ.get("ZHIHU_DAILY_GENERATION_BUDGET", "30")))
CONTENT_DAILY_CALL_LIMITS = {
    "zhihu_search": max(1, int(os.environ.get("ZHIHU_DAILY_SEARCH_BUDGET", "5000"))),
    "hot_list": max(1, int(os.environ.get("ZHIHU_DAILY_HOT_BUDGET", "100"))),
}
MIN_VOTE_UPS = 5000
SEARCH_CACHE_TTL = 24 * 60 * 60
ZHIDA_CACHE_TTL = 0
STALE_CACHE_TTL = 7 * 24 * 60 * 60
MAX_CACHE_ENTRIES = 160
STATE_PATH = Path(__file__).resolve().parent / "runtime" / "zhihu_api_state.json"
_ALLOWED_MODELS = {"zhida-fast-1p5", "zhida-thinking-1p5", "zhida-agent"}
_ARTICLE_TYPES = {"answer", "article"}
_TAG_RE = re.compile(r"<[^>]+>")
_BREAK_RE = re.compile(r"(?i)<(?:br\s*/?|/p|/div|/li|/h[1-6])>")
_SPACE_RE = re.compile(r"[ \t\f\v]+")
_lock = threading.RLock()


@dataclass
class _Flight:
    event: threading.Event = field(default_factory=threading.Event)
    value: Any = None
    error: Exception | None = None


_flights: dict[str, _Flight] = {}


class ZhihuError(Exception):
    """A user-facing error raised by the official Zhihu gateway."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _empty_state() -> dict:
    return {"date": date.today().isoformat(), "used": 0, "generation_used": 0, "calls_by_api": {}, "cache": {}}


def _load_state_locked() -> dict:
    try:
        raw = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        state = raw if isinstance(raw, dict) else _empty_state()
    except (OSError, json.JSONDecodeError):
        state = _empty_state()
    state.setdefault("cache", {})
    state.setdefault("generation_used", 0)
    if not isinstance(state["cache"], dict):
        state["cache"] = {}
    if state.get("date") != date.today().isoformat():
        state["date"] = date.today().isoformat()
        state["used"] = 0
        state["generation_used"] = 0
        state["calls_by_api"] = {}
    state["used"] = max(0, int(state.get("used") or 0))
    state["generation_used"] = max(0, int(state.get("generation_used") or 0))
    state["calls_by_api"] = state.get("calls_by_api") if isinstance(state.get("calls_by_api"), dict) else {}
    return state


def _save_state_locked(state: dict) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp.replace(STATE_PATH)
    except OSError as exc:
        raise ZhihuError(f"知乎调用状态无法持久化，已停止上游请求：{exc}") from exc


def _state_summary() -> dict:
    with _lock:
        state = _load_state_locked()
        return {
            "date": state["date"],
            "used": state["used"],
            "limit": DAILY_CALL_LIMIT,
            "remaining": max(0, DAILY_CALL_LIMIT - state["used"]),
            "generation_used": state["generation_used"],
            "generation_limit": GENERATION_DAILY_CALL_LIMIT,
            "generation_remaining": max(0, GENERATION_DAILY_CALL_LIMIT - state["generation_used"]),
            "calls_by_api": dict(state["calls_by_api"]),
            "content_limits": dict(CONTENT_DAILY_CALL_LIMITS),
        }


def status() -> dict:
    secret = settings_store.zhihu_secret()
    quota = _state_summary()
    return {
        "ok": True,
        "available": bool(secret) and quota["generation_remaining"] > 0,
        "has_secret": bool(secret),
        "model": "zhida-thinking-1p5",
        "min_vote_ups": MIN_VOTE_UPS,
        "quota": quota,
        "message": (
            f"知乎官方接口已配置，今日生成预算剩余 {quota['generation_remaining']}/{quota['generation_limit']} 次"
            if secret else "未配置知乎 Access Secret，请在设置中填写后再使用知乎搜索与直答"
        ),
    }


def official_quota(api_id: str = "zhida_openai") -> dict:
    """Read the official quota endpoint. Quota queries do not spend business quota."""
    secret = settings_store.zhihu_secret()
    if not secret:
        raise ZhihuError("未配置知乎 Access Secret")
    try:
        response = requests.get(
            QUOTA_URL,
            headers=_headers(secret),
            params={"APIIDs": api_id},
            timeout=(5, 15),
        )
        response.raise_for_status()
        items = _as_items(response.json())
    except ZhihuError:
        raise
    except Exception as exc:
        raise ZhihuError(f"知乎额度查询失败：{exc}") from exc
    for item in items:
        if isinstance(item, dict) and str(item.get("APIID") or item.get("api_id")) == api_id:
            return {
                "api_id": api_id,
                "total": int(item.get("TotalQuota") or item.get("total") or 0),
                "used": int(item.get("TotalUsed") or item.get("used") or 0),
                "remaining": int(item.get("RemainingQuota") or item.get("remaining") or 0),
            }
    raise ZhihuError("知乎额度接口未返回直答额度")


def _headers(secret: str, oauth_token: str | None = None) -> dict:
    headers = {
        "Authorization": f"Bearer {secret}",
        "X-Request-Timestamp": str(int(time.time())),
        "Content-Type": "application/json",
    }
    if oauth_token:
        headers["X-OAuth-Token"] = oauth_token
    return headers


def _cache_key(api_id: str, method: str, url: str, payload: dict | None) -> str:
    stable = {"api": api_id, "method": method, "url": url, "payload": payload or {}}
    encoded = json.dumps(stable, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _envelope(data: Any) -> Any:
    if not isinstance(data, dict):
        return data
    code = data.get("Code", data.get("code", 0))
    if code not in (None, 0, "0"):
        message = str(data.get("Message") or data.get("message") or f"知乎接口错误（Code={code}）")
        if str(code) == "20001":
            raise ZhihuError("知乎 Access Secret 无效或已过期")
        if str(code) == "30001":
            raise ZhihuError("知乎官方接口额度已耗尽或请求过于频繁")
        raise ZhihuError(message)
    return data.get("Data", data.get("data", data))


def _request_json(method: str, url: str, secret: str, payload: dict | None, timeout: tuple[int, int]) -> Any:
    if method == "GET":
        response = requests.get(url, headers=_headers(secret), params=payload, timeout=timeout)
    else:
        response = requests.post(url, headers=_headers(secret), json=payload, timeout=timeout)
    response.raise_for_status()
    return response.json()


def _cached_upstream(*, api_id: str, method: str, url: str, payload: dict | None,
                     ttl: int, timeout: tuple[int, int] = (8, 45),
                     budget: str = "shared", cache: bool = True) -> tuple[Any, dict]:
    """Return one cached/coalesced response and count only the real upstream request."""
    secret = settings_store.zhihu_secret()
    if not secret:
        raise ZhihuError("未配置知乎 Access Secret")
    key = _cache_key(api_id, method, url, payload)
    now = time.time()
    with _lock:
        state = _load_state_locked()
        cached = state["cache"].get(key)
        if cache and ttl > 0 and isinstance(cached, dict) and float(cached.get("expires_at") or 0) > now:
            return cached.get("value"), {"cache_hit": True, "stale": False, "api_id": api_id}
        flight = _flights.get(key)
        if flight is None:
            flight = _Flight()
            _flights[key] = flight
            leader = True
        else:
            leader = False

    if not leader:
        if not flight.event.wait(timeout=sum(timeout) + 5):
            raise ZhihuError("等待相同知乎请求超时")
        if flight.error:
            raise flight.error
        return flight.value, {"cache_hit": True, "coalesced": True, "stale": False, "api_id": api_id}

    try:
        with _lock:
            state = _load_state_locked()
            cached = state["cache"].get(key)
            if budget == "generation":
                used = state["generation_used"]
                limit = GENERATION_DAILY_CALL_LIMIT
            else:
                used = int(state["calls_by_api"].get(api_id) or 0)
                limit = CONTENT_DAILY_CALL_LIMITS.get(api_id, DAILY_CALL_LIMIT)
            if used >= limit:
                if cache and isinstance(cached, dict) and float(cached.get("created_at") or 0) + STALE_CACHE_TTL > now:
                    flight.value = cached.get("value")
                    return flight.value, {"cache_hit": True, "stale": True, "api_id": api_id}
                raise ZhihuError(f"知乎接口今日已达到本地上限 {limit} 次，请明日再试")
            if budget == "generation":
                state["generation_used"] += 1
            else:
                state["used"] += 1
            state["calls_by_api"][api_id] = int(state["calls_by_api"].get(api_id) or 0) + 1
            _save_state_locked(state)

        started = time.monotonic()
        value = _request_json(method, url, secret, payload, timeout)
        elapsed_ms = int((time.monotonic() - started) * 1000)
        with _lock:
            state = _load_state_locked()
            if cache and ttl > 0:
                state["cache"][key] = {
                    "api_id": api_id,
                    "created_at": now,
                    "expires_at": now + ttl,
                    "value": value,
                }
                if len(state["cache"]) > MAX_CACHE_ENTRIES:
                    oldest = sorted(state["cache"], key=lambda item: float(state["cache"][item].get("created_at") or 0))
                    for old_key in oldest[:len(state["cache"]) - MAX_CACHE_ENTRIES]:
                        state["cache"].pop(old_key, None)
                _save_state_locked(state)
        flight.value = value
        return value, {"cache_hit": False, "stale": False, "api_id": api_id, "elapsed_ms": elapsed_ms}
    except Exception as exc:
        error = exc if isinstance(exc, ZhihuError) else ZhihuError(f"知乎接口请求失败：{exc}")
        flight.error = error
        raise error
    finally:
        flight.event.set()
        with _lock:
            _flights.pop(key, None)


def _as_items(data: Any) -> list:
    value = _envelope(data)
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("Items", "items", "Data", "data"):
            if isinstance(value.get(key), list):
                return value[key]
    return []


def _plain_text(value: object, limit: int = 1500) -> str:
    text = html.unescape(str(value or ""))
    text = _BREAK_RE.sub("\n", text)
    text = _TAG_RE.sub("", text)
    lines = [_SPACE_RE.sub(" ", line).strip() for line in text.splitlines()]
    paragraphs = [line for line in lines if len(line) >= 12]
    clean = "\n\n".join(paragraphs) if paragraphs else _SPACE_RE.sub(" ", text).strip()
    if len(clean) <= limit:
        return clean
    clipped = clean[:limit]
    boundary = max(clipped.rfind("。"), clipped.rfind("！"), clipped.rfind("？"), clipped.rfind("."))
    return clipped[:boundary + 1].strip() if boundary >= limit // 2 else clipped.rstrip() + "…"


def _normalize_search_item(raw: dict) -> dict | None:
    content_type = str(raw.get("ContentType") or raw.get("content_type") or "").strip()
    try:
        votes = int(raw.get("VoteUpCount") or raw.get("vote_up_count") or 0)
    except (TypeError, ValueError):
        votes = 0
    if content_type.casefold() not in _ARTICLE_TYPES or votes < MIN_VOTE_UPS:
        return None
    excerpt = _plain_text(raw.get("ContentText") or raw.get("content_text") or raw.get("Summary"), 1500)
    if not excerpt:
        return None
    return {
        "source": "zhihu_search",
        "content_id": str(raw.get("ContentID") or raw.get("content_id") or "").strip(),
        "content_type": content_type,
        "title": _plain_text(raw.get("Title") or raw.get("title"), 220),
        "excerpt": excerpt,
        "summary": excerpt[:360],
        "url": str(raw.get("Url") or raw.get("url") or "").strip(),
        "author": _plain_text(raw.get("AuthorName") or raw.get("author_name"), 80),
        "vote_up_count": votes,
        "authority_level": raw.get("AuthorityLevel", raw.get("authority_level")),
        "ranking_score": raw.get("RankingScore", raw.get("ranking_score")),
    }


def search(query: str, count: int = 10, preference_context: dict | None = None) -> dict:
    """Search qualified Zhihu material. preference_context is reserved for future OAuth signals."""
    query = _SPACE_RE.sub(" ", str(query or "")).strip()[:120]
    if not query:
        return {"ok": False, "error": "知乎搜索关键词不能为空", "items": [], "quota": _state_summary()}
    count = max(1, min(int(count or 10), 10))
    try:
        data, meta = _cached_upstream(
            api_id="zhihu_search", method="GET", url=SEARCH_URL,
            payload={"Query": query, "Count": count}, ttl=SEARCH_CACHE_TTL,
        )
        items = [item for raw in _as_items(data) if isinstance(raw, dict) if (item := _normalize_search_item(raw))]
        return {
            "ok": True,
            "query": query,
            "items": items,
            "min_vote_ups": MIN_VOTE_UPS,
            "cache": meta,
            "quota": _state_summary(),
            "preference_mode": "oauth_ready" if preference_context else "anonymous",
        }
    except ZhihuError as exc:
        return {"ok": False, "error": str(exc), "items": [], "min_vote_ups": MIN_VOTE_UPS, "quota": _state_summary()}


def _trusted_search_item(content_id: str) -> dict | None:
    with _lock:
        state = _load_state_locked()
        for entry in state["cache"].values():
            if not isinstance(entry, dict) or entry.get("api_id") != "zhihu_search":
                continue
            for raw in _as_items(entry.get("value")):
                if not isinstance(raw, dict):
                    continue
                item = _normalize_search_item(raw)
                if item and item["content_id"] == content_id:
                    return item
    return None


def resolve_source_payload(source: str, source_payload: dict | None) -> tuple[dict | None, str | None]:
    if source == "original":
        return None, None
    if source in ("hot", "story", "knowledge"):
        if not isinstance(source_payload, dict):
            return None, "请先选择一条内容"
        return {
            "source": source,
            "title": str(source_payload.get("title") or "").strip(),
            "content_id": str(source_payload.get("content_id") or source_payload.get("work_id") or "").strip(),
            "excerpt": str(source_payload.get("excerpt") or source_payload.get("description") or "").strip(),
            "summary": str(source_payload.get("summary") or source_payload.get("description") or source_payload.get("excerpt") or "").strip(),
            "author": str(source_payload.get("author") or "").strip(),
            "url": str(source_payload.get("url") or "").strip(),
            "labels": [str(value)[:50] for value in (source_payload.get("labels") or [])[:10]],
        }, None
    if source != "zhihu_search" or not isinstance(source_payload, dict):
        return None, "该选题来源已停用，请重新选择 5000+ 赞的知乎内容"
    content_id = str(source_payload.get("content_id") or "").strip()
    item = _trusted_search_item(content_id)
    if not item:
        return None, "选材未通过服务器校验，请重新搜索并选择 5000+ 赞的知乎回答或文章"
    return {
        "content_id": item["content_id"],
        "content_type": item["content_type"],
        "title": item["title"],
        "author": item["author"],
        "url": item["url"],
        "vote_up_count": item["vote_up_count"],
        "content": item["excerpt"],
        "summary": item["summary"],
        "labels": [],
    }, None


def zhida_complete(messages: list[dict], model: str = "zhida-thinking-1p5") -> dict:
    """Call Zhihu Direct Answer once. Unsupported OpenAI options are intentionally omitted."""
    model = model if model in _ALLOWED_MODELS else "zhida-thinking-1p5"
    safe_messages = [
        {"role": str(item.get("role") or "user"), "content": str(item.get("content") or "")}
        for item in messages if isinstance(item, dict)
    ]
    if not safe_messages:
        raise ZhihuError("知乎直答消息不能为空")
    started_at = _now_iso()
    started = time.monotonic()
    data, meta = _cached_upstream(
        api_id="zhida_openai", method="POST", url=ZHIDA_URL,
        payload={"model": model, "messages": safe_messages, "stream": False},
        ttl=ZHIDA_CACHE_TTL, timeout=(10, 120), budget="generation", cache=False,
    )
    try:
        content = str(data["choices"][0]["message"]["content"])
    except (KeyError, IndexError, TypeError) as exc:
        _w = data if isinstance(data, dict) else {}
        if "error" in _w:
            import json as _j
            logger.warning("zhida error: %s", _j.dumps(_w["error"], ensure_ascii=False))
        raise ZhihuError("知乎直答返回结构不完整") from exc
    raw_usage = data.get("usage") if isinstance(data, dict) and isinstance(data.get("usage"), dict) else {}
    return {
        "content": content,
        "usage": raw_usage,
        "model": str(data.get("model") or model) if isinstance(data, dict) else model,
        "cache_hit": bool(meta.get("cache_hit")),
        "stale": bool(meta.get("stale")),
        "started_at": started_at,
        "ended_at": _now_iso(),
        "elapsed_ms": 0 if meta.get("cache_hit") else int((time.monotonic() - started) * 1000),
        "quota": _state_summary(),
    }


# Compatibility endpoints are kept locally but no longer call unverifiable content feeds.
def _normalize_hot_item(raw: dict) -> dict | None:
    """Normalize a hot list item to lowercase fields."""
    if not isinstance(raw, dict):
        return None
    title = str(raw.get("Title") or raw.get("title") or "").strip()
    if not title:
        return None
    return {
        "title": title,
        "content_id": str(raw.get("ContentId") or raw.get("ContentID") or raw.get("content_id") or ""),
        "summary": str(raw.get("Summary") or raw.get("summary") or "").strip()[:300],
        "excerpt": str(raw.get("Summary") or raw.get("summary") or "").strip()[:300],
        "url": str(raw.get("Url") or raw.get("url") or "").strip(),
        "thumbnail": str(raw.get("ThumbnailUrl") or raw.get("thumbnail") or "").strip(),
    }


def hot_list(limit: int = 30) -> dict:
    """Fetch Zhihu hot list. Results do not carry verified vote counts."""
    count = max(1, min(int(limit or 30), 30))
    try:
        data, meta = _cached_upstream(
            api_id="hot_list", method="GET", url=f"{DEVELOPER_BASE}/api/v1/content/hot_list",
            payload={"Limit": count}, ttl=SEARCH_CACHE_TTL,
        )
        items = [item for raw in _as_items(data) if isinstance(raw, dict) if (item := _normalize_hot_item(raw))]
        return {
            "ok": True,
            "items": items,
            "cache": meta,
            "quota": _state_summary(),
        }
    except ZhihuError as exc:
        return {"ok": False, "error": str(exc), "items": [], "quota": _state_summary()}


def story_list() -> dict:
    """Fetch hackathon story list (no auth required, not counted in daily quota)."""
    import requests as req
    try:
        resp = req.get("https://api.zhihu.com/km-indep-home/hackathon/v2/story/list",
                       headers={"Accept": "application/json"}, timeout=(8, 30))
        resp.raise_for_status()
        raw = resp.json()
        items = raw if isinstance(raw, list) else []
        normalized = []
        for item in items:
            if isinstance(item, dict) and item.get("work_id"):
                normalized.append({
                    "work_id": str(item["work_id"]),
                    "title": str(item.get("title") or "").strip(),
                    "description": str(item.get("description") or "").strip(),
                    "labels": item.get("labels") if isinstance(item.get("labels"), list) else [],
                })
        return {"ok": True, "items": normalized}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "items": []}


def knowledge_list() -> dict:
    """Fetch hackathon knowledge list (no auth required, not counted in daily quota)."""
    import requests as req
    try:
        resp = req.get("https://api.zhihu.com/km-indep-home/hackathon/v2/knowledge/list",
                       headers={"Accept": "application/json"}, timeout=(8, 30))
        resp.raise_for_status()
        raw = resp.json()
        items = raw if isinstance(raw, list) else []
        normalized = []
        for item in items:
            if isinstance(item, dict) and item.get("work_id"):
                normalized.append({
                    "work_id": str(item["work_id"]),
                    "title": str(item.get("title") or "").strip(),
                    "description": str(item.get("description") or "").strip(),
                    "labels": item.get("labels") if isinstance(item.get("labels"), list) else [],
                })
        return {"ok": True, "items": normalized}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "items": []}


def story_detail(work_id: str) -> dict:
    """Fetch hackathon story detail (no auth required)."""
    import requests as req
    safe_id = str(work_id or "").strip()
    if not safe_id or any(ch in safe_id for ch in ("/", "?", "#", "\r", "\n")):
        return {"ok": False, "error": "无效的 work_id", "detail": None}
    try:
        resp = req.get(f"https://api.zhihu.com/km-indep-home/hackathon/v2/story/{safe_id}",
                       headers={"Accept": "application/json"}, timeout=(8, 30))
        resp.raise_for_status()
        raw = resp.json()
        if not isinstance(raw, dict):
            return {"ok": False, "error": "返回格式异常", "detail": None}
        return {"ok": True, "detail": {
            "work_id": str(raw.get("work_id") or safe_id),
            "title": str(raw.get("chapter_name") or raw.get("title") or "").strip(),
            "author": str(raw.get("author_name") or "").strip(),
            "labels": raw.get("labels") if isinstance(raw.get("labels"), list) else [],
            "introduction": str(raw.get("introduction") or "").strip(),
            "content": str(raw.get("content") or "").strip(),
        }}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "detail": None}


def knowledge_detail(work_id: str) -> dict:
    """Fetch hackathon knowledge detail (no auth required)."""
    import requests as req
    safe_id = str(work_id or "").strip()
    if not safe_id or any(ch in safe_id for ch in ("/", "?", "#", "\r", "\n")):
        return {"ok": False, "error": "无效的 work_id", "detail": None}
    try:
        resp = req.get(f"https://api.zhihu.com/km-indep-home/hackathon/v2/knowledge/{safe_id}",
                       headers={"Accept": "application/json"}, timeout=(8, 30))
        resp.raise_for_status()
        raw = resp.json()
        if not isinstance(raw, dict):
            return {"ok": False, "error": "返回格式异常", "detail": None}
        return {"ok": True, "detail": {
            "work_id": str(raw.get("work_id") or safe_id),
            "title": str(raw.get("chapter_name") or raw.get("title") or "").strip(),
            "author": str(raw.get("author_name") or "").strip(),
            "labels": raw.get("labels") if isinstance(raw.get("labels"), list) else [],
            "introduction": str(raw.get("introduction") or "").strip(),
            "content": str(raw.get("content") or "").strip(),
        }}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "detail": None}
