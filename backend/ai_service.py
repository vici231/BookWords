"""ai_service.py — OpenAI 兼容接口调用 + 生成结果校验。

文章生成使用设置页保存的外部 API；知乎开放平台只负责内容选材。
正式链路不返回模板 fallback。网络调用由 llm_gateway 统一记录 token、耗时和 prompt 版本。

内容安全：只对「模型生成结果」做受限内容检查（第二道闸门）；
用户词卡本身不再拦截（避免 china/shanghai 等正常词汇误杀整单）。
"""

from __future__ import annotations

import json
import copy
import hashlib
import logging
import re
import threading
import time
import uuid

import requests

try:
    from backend import llm_gateway, prompt_templates, settings_store, word_grouping
except ImportError:  # `python backend/app.py` 直接运行时
    import llm_gateway  # type: ignore
    import prompt_templates  # type: ignore
    import settings_store  # type: ignore
    import word_grouping  # type: ignore

logger = logging.getLogger(__name__)

def provider_catalog() -> list[dict]:
    """前端「选择供应商」下拉的数据源。"""
    return [
        {"id": "deepseek", "name": "DeepSeek", "base_url": "https://api.deepseek.com"},
        {"id": "openai", "name": "OpenAI", "base_url": "https://api.openai.com/v1"},
        {"id": "custom", "name": "自定义 OpenAI 兼容接口", "base_url": ""},
    ]


def provider_determination_rules() -> dict:
    """供前端根据地址或模型名识别常见供应商。"""
    return {
        "tokens": [["api.deepseek.com", "deepseek"], ["api.openai.com", "openai"]],
        "model_prefixes": [["deepseek", "deepseek"], ["gpt-", "openai"], ["o1", "openai"], ["o3", "openai"]],
    }


def _provider_info(cfg: dict) -> tuple[str, str]:
    base_url = str(cfg.get("base_url") or "").casefold()
    model = str(cfg.get("model") or "").casefold()
    if "api.deepseek.com" in base_url or model.startswith("deepseek"):
        return "deepseek", "DeepSeek"
    if "api.openai.com" in base_url or model.startswith(("gpt-", "o1", "o3")):
        return "openai", "OpenAI"
    return "custom", "OpenAI 兼容 API"


def _require_api_config(cfg: dict) -> None:
    missing = [name for name in ("base_url", "api_key", "model") if not str(cfg.get(name) or "").strip()]
    if missing:
        raise ValueError("请在设置页完整填写 Base URL、API Key 和模型")


# ---------------------------------------------------------------------------
# 状态与连通性
# ---------------------------------------------------------------------------

def ai_status() -> dict:
    """返回当前外部文章生成 API 的配置状态，不发起上游请求。"""
    cfg = settings_store.effective_api()
    provider, provider_name = _provider_info(cfg)
    available = all(str(cfg.get(key) or "").strip() for key in ("base_url", "api_key", "model"))
    return {
        "available": available,
        "provider": provider,
        "provider_name": provider_name,
        "model": cfg.get("model", ""),
        "mode": "ai" if available else "nokey",
        "label": "文章生成 API 已配置" if available else "未配置文章生成 API",
        "display": f"{provider_name} · {cfg.get('model', '')}" if available else "未配置文章生成 API",
        "quota": {},
    }


def test_ai_config(payload: dict) -> dict:
    """用候选设置执行最小真实请求，但不保存配置。"""
    cfg = settings_store.effective_api_from(payload)
    try:
        _require_api_config(cfg)
        provider, provider_name = _provider_info(cfg)
        response = llm_gateway.complete(
            skill_name="connection_test", prompt_version="connection-test-v1",
            messages=[{"role": "user", "content": "Reply with OK only."}],
            config={**cfg, "provider_name": provider_name}, temperature=0, timeout=(10, 30),
            retries=0, cache=False, metadata={"connection_test": True},
        )
        return {"status": "ok", "available": True, "provider": provider,
                "provider_name": provider_name, "model": response["metrics"].get("model") or cfg["model"],
                "mode": "ai", "message": "连接测试成功"}
    except ValueError as exc:
        return {"status": "warning", "available": False, "mode": "nokey", "message": str(exc)}
    except Exception as exc:
        return {"status": "error", "available": False, "mode": "error", "message": f"连接失败：{exc}"}


def fetch_ai_models(payload: dict) -> dict:
    """从候选 OpenAI 兼容接口实时查询模型列表。"""
    cfg = settings_store.effective_api_from(payload)
    if not cfg.get("base_url") or not cfg.get("api_key"):
        return {"ok": False, "models": [], "message": "请先填写 Base URL 和 API Key"}
    provider, provider_name = _provider_info(cfg)
    try:
        response = requests.get(
            f"{cfg['base_url']}/models",
            headers={"Authorization": f"Bearer {cfg['api_key']}", "Accept": "application/json"},
            timeout=(10, 30),
        )
        response.raise_for_status()
        data = response.json()
        items = data.get("data") if isinstance(data, dict) else []
        models = sorted({str(item.get("id") or "").strip() for item in items if isinstance(item, dict) and item.get("id")})
        return {"ok": bool(models), "models": models, "provider": provider, "provider_name": provider_name,
                "base_url": cfg["base_url"], "message": f"已获取 {len(models)} 个模型" if models else "接口未返回模型"}
    except Exception as exc:
        return {"ok": False, "models": [], "provider": provider, "provider_name": provider_name,
                "base_url": cfg.get("base_url", ""), "message": f"模型查询失败：{exc}"}


# ---------------------------------------------------------------------------
# 生成（单次调用，失败降级）
# ---------------------------------------------------------------------------

# 故事生成时「目标词之外」词汇的难度档位
_LEVELS = {"junior": "初中（简单）", "senior": "高中（中等）", "cet": "四六级（进阶）"}

# 生成调参的键与默认值（词密度/丰富度/推理强度/抽象度，均 1-10）
_PARAM_KEYS = ("density", "richness", "reasoning", "abstraction")

# 生成内容的第二道安全闸门：提示词负责引导，服务端负责拒绝明显违规输出。
_RESTRICTED_CONTENT_RE = re.compile(
    r"(?:色情|淫秽|裸体|裸露|性行为|情色|强奸|血腥|斩首|"
    r"\b(?:porn|pornography|nude|nudity|naked|erotic|sexual|sex|intercourse|orgasm|hentai|xxx|"
    r"rape|gore|beheading)\b)",
    re.IGNORECASE,
)


def _contains_restricted_content(*values: object) -> bool:
    """检查生成文本，避免明显 NSFW/血腥内容进入刊物（只查模型输出，不查用户词卡）。"""
    return bool(_RESTRICTED_CONTENT_RE.search(" ".join(str(value or "") for value in values)))


def normalize_level(level: str) -> str:
    """校验难度档位；非法值回退 junior。"""
    return level if level in _LEVELS else "junior"


def normalize_params(params: dict | None) -> dict:
    """校验并归一化生成调参（越界/非法回退默认 5）。"""
    out: dict[str, int] = {}
    for key in _PARAM_KEYS:
        try:
            v = int((params or {}).get(key, 5))
        except (TypeError, ValueError):
            v = 5
        out[key] = max(1, min(10, v))
    try:
        length = int((params or {}).get("length", 220))
    except (TypeError, ValueError):
        length = 220
    out["length"] = max(180, min(260, length))
    return out


def _build_source_note(source: str, source_payload: dict | None) -> str:
    """Build mandatory Chinese attribution in backend code, never in the prompt."""
    if source == "original" or not isinstance(source_payload, dict):
        return "来源：AI 原创生成｜Bookwords 英语学习材料"
    title = str(source_payload.get("title") or "").strip()
    if not title:
        return "来源：AI 原创生成｜Bookwords 英语学习材料"
    labels = {"zhihu_search": "知乎精选", "hot": "知乎热榜", "story": "知乎故事", "knowledge": "知乎知识"}
    note = f"来源：{labels.get(source, '知乎')}《{title}》"
    author = str(source_payload.get("author") or "").strip()
    if author:
        note += f"｜作者：{author}"
    try:
        votes = int(source_payload.get("vote_up_count") or 0)
    except (TypeError, ValueError):
        votes = 0
    if votes:
        note += f"｜赞同 {votes}"
    return note


def _safe_source_payload(source_payload: dict | None) -> dict | None:
    if not isinstance(source_payload, dict):
        return None
    try:
        votes = int(source_payload.get("vote_up_count") or 0)
    except (TypeError, ValueError):
        votes = 0
    return {
        "title": str(source_payload.get("title") or "")[:240],
        "summary": str(source_payload.get("summary") or source_payload.get("excerpt") or source_payload.get("description") or "")[:1000],
        "author": str(source_payload.get("author") or "")[:80],
        "labels": [str(value)[:50] for value in (source_payload.get("labels") or [])[:10]],
        "url": str(source_payload.get("url") or "")[:500],
        "vote_up_count": votes,
    }


# 允许的选题来源；其余一律按 original（纯原创）处理
_SOURCES = ("original", "zhihu_search", "hot", "story", "knowledge")


class GenerationError(RuntimeError):
    def __init__(self, message: str, *, code: str = "AI_UPSTREAM_ERROR", status_code: int = 502,
                 retryable: bool = True, request_id: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.retryable = retryable
        self.request_id = request_id


def _upstream_generation_error(exc: Exception, request_id: str, prefix: str = "文章生成 API 连接失败") -> GenerationError:
    message = str(exc)
    lowered = message.casefold()
    if "429" in lowered or "额度" in message or "too many requests" in lowered:
        return GenerationError(
            f"文章生成 API 请求受限或额度已耗尽：{message}",
            code="AI_QUOTA_EXHAUSTED", status_code=429, retryable=False, request_id=request_id,
        )
    if "配置不完整" in message or "未配置" in message:
        return GenerationError(
            message, code="AI_NOT_CONFIGURED", status_code=503, retryable=False, request_id=request_id,
        )
    return GenerationError(f"{prefix}：{message}", code="AI_UPSTREAM_ERROR", request_id=request_id)


_ARTICLE_CACHE_TTL = 10 * 60
_article_cache: dict[str, tuple[float, dict]] = {}
_article_cache_lock = threading.RLock()


def _article_cache_key(cards: list[dict], level: str, params: dict, source: str,
                       source_payload: dict | None, cfg: dict, memory_scope: str) -> str:
    value = {"cards": cards, "level": level, "params": params, "source": source,
             "source_payload": source_payload, "model": cfg.get("model"),
             "base_url": cfg.get("base_url"),
             "memory_scope": memory_scope, "prompt": prompt_templates.version("story")}
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()


def _cached_article(key: str) -> dict | None:
    now = time.time()
    with _article_cache_lock:
        item = _article_cache.get(key)
        if not item:
            return None
        if item[0] <= now:
            _article_cache.pop(key, None)
            return None
        result = copy.deepcopy(item[1])
        result["cache_hit"] = True
        result.setdefault("debug", {})["cache_hit"] = True
        return result


def _store_article(key: str, result: dict) -> None:
    with _article_cache_lock:
        _article_cache[key] = (time.time() + _ARTICLE_CACHE_TTL, copy.deepcopy(result))
        if len(_article_cache) > 64:
            oldest = sorted(_article_cache, key=lambda item: _article_cache[item][0])
            for old_key in oldest[:len(_article_cache) - 64]:
                _article_cache.pop(old_key, None)


def _complete_external(cfg: dict, messages: list[dict], attempt: object, source: str, word_count: int) -> dict:
    return _chat_completion(
        cfg, messages, json_mode=False, skill_name="story_generation",
        prompt_version=prompt_templates.version("story"), retries=0,
        metadata={"source": source, "validation_attempt": attempt, "word_count": word_count},
    )


def recommend_topics(cards: list[dict], candidates: list[dict]) -> dict:
    """根据词汇池语义，从知乎候选素材中推荐最多 3 个适配题材。

    这是生成前的独立 AI 阶段，只做选题排序，不写文章。候选正文不进入本接口，
    仅传标题、摘要与标签，减少 token 并避免把外部内容当作指令。
    """
    cfg = {"model": "local-ranking"}
    safe_candidates = []
    for item in candidates[:80]:
        if not isinstance(item, dict):
            continue
        safe_candidates.append({
            "id": str(item.get("id") or "")[:80],
            "source": str(item.get("source") or "")[:32],
            "title": str(item.get("title") or "")[:180],
            "summary": str(item.get("summary") or "")[:360],
            "labels": [str(x)[:40] for x in (item.get("labels") or [])[:8]],
        })
    if not safe_candidates:
        return {"error": "当前没有可供推荐的知乎题材"}
    words = {str(card.get("word") or "").casefold() for card in cards}
    indexed = list(enumerate(safe_candidates))
    def score(pair: tuple[int, dict]) -> tuple[int, int, int]:
        index, item = pair
        text = f"{item['title']} {item['summary']}".casefold()
        matched = sum(bool(word) and word in text for word in words)
        return matched, min(len(item["summary"]), 360), -index
    ranked = [item for _, item in sorted(indexed, key=score, reverse=True)[:3]]
    return {
        "ok": True,
        "fallback": False,
        "provider": "local-ranking",
        "recommendations": [
            {**item, "reason": "标题或摘要与当前词汇存在共同语境", "angle": item["title"]}
            for item in ranked
        ],
    }


def generate(mode: str, cards: list[dict], level: str = "junior", params: dict | None = None,
             source: str = "original", source_payload: dict | None = None,
             language: str = "en", memory_scope: str = "pool") -> dict:
    """Generate a real article; never return placeholder content on failure."""
    if mode != "story":
        return {"error": "未知模式"}
    source = source if source in _SOURCES else "original"
    source_payload = _safe_source_payload(source_payload)
    language = "zh" if language == "zh" else "en"
    memory_scope = "recent_3d" if memory_scope == "recent_3d" else "pool"
    level = normalize_level(level)
    params = normalize_params(params)
    cfg = settings_store.effective_api()
    request_id = uuid.uuid4().hex[:12]
    try:
        _require_api_config(cfg)
    except ValueError as exc:
        raise GenerationError(
            str(exc), code="AI_NOT_CONFIGURED", status_code=503,
            retryable=False, request_id=request_id,
        ) from exc
    provider, provider_name = _provider_info(cfg)
    cfg = {**cfg, "provider": provider, "provider_name": provider_name}
    cache_key = _article_cache_key(cards, level, params, source, source_payload, cfg, memory_scope)
    cached = _cached_article(cache_key)
    if cached:
        cached["language"] = {
            "selected": language,
            "available": ["en", "zh"],
            "content": cached["story"]["zh" if language == "zh" else "en"],
        }
        cached["story"]["language"] = language
        return cached
    sorting = word_grouping.group_cards(cards, source_payload)
    selected_words = {str(word).casefold() for word in sorting["selected_group"]["words"]}
    selected_cards = [card for card in cards if str(card.get("word") or "").casefold() in selected_words]
    if len(selected_cards) < 3:
        raise GenerationError(
            "当前词汇无法形成至少 3 个词的连贯语境，请调整词汇范围",
            code="AI_OUTPUT_INVALID", status_code=422, retryable=False, request_id=request_id,
        )
    cards = selected_cards[:word_grouping.MAX_ARTICLE_WORDS]
    trace = {
        "provider": provider,
        "provider_name": provider_name,
        "model": cfg["model"],
        "base_url": cfg["base_url"],
        "level": level,
        "params": params,
        "source": source,
        "memory_scope": memory_scope,
        "language": language,
        "sorting": sorting,
        "words": [str(c.get("word") or "") for c in cards],
        "prompt_version": prompt_templates.version("story"),
        "attempts": [],
    }

    messages = prompt_templates.get_messages(mode, cards, level, params, source=source, source_payload=source_payload)
    for attempt in (1,):
        entry = {"n": attempt, "messages": messages}
        trace["attempts"].append(entry)
        started = time.monotonic()
        try:
            response = _complete_external(cfg, messages, attempt, source, len(cards))
            content = response["content"]
        except Exception as exc:
            entry["elapsed_ms"] = int((time.monotonic() - started) * 1000)
            entry["error"] = f"网络 / HTTP 错误：{exc}"
            logger.warning("AI 调用失败：%s", exc)
            raise _upstream_generation_error(exc, request_id) from exc
        entry["elapsed_ms"] = int((time.monotonic() - started) * 1000)
        entry["raw"] = content
        entry["usage"] = response["usage"]
        entry["metrics"] = response["metrics"]
        try:
            payload = _parse_article_text(content)
            result = _normalize(mode, payload, cards, params)
        except GenerationError:
            raise
        except ValueError as exc:
            reason = str(exc)
            entry["error"] = f"输出校验失败：{reason}"
            logger.warning("AI 输出校验失败（第 %s 次）：%s", attempt, reason)
            raise GenerationError(f"模型输出无法整理成文章：{reason}", code="AI_OUTPUT_INVALID", request_id=request_id) from exc
        # Attribution is generated by code so the model cannot omit or alter it.
        note = _build_source_note(source, source_payload)
        result["story"]["source_note"] = note
        trace["ok"] = True
        trace["fallback"] = False
        trace["request_id"] = request_id
        result["fallback"] = False
        result["provider"] = response["metrics"].get("provider", provider_name)
        result["model"] = response["metrics"].get("model", cfg["model"])
        result["quota"] = response["metrics"].get("quota", {})
        result["request_id"] = request_id
        result["cache_hit"] = False
        result["source"] = {"type": source, **(source_payload or {})}
        result["memory_scope"] = memory_scope
        result["sorting"] = {key: value for key, value in sorting.items() if key != "metrics"}
        result["language"] = {
            "selected": language,
            "available": ["en", "zh"],
            "content": result["story"]["zh" if language == "zh" else "en"],
        }
        result["story"]["language"] = language
        result["story"]["content_en"] = result["story"]["en"]
        result["story"]["content_zh"] = result["story"]["zh"]
        result["story"]["memory_scope"] = memory_scope
        result["story"]["sorting"] = result["sorting"]
        result["story"]["source_url"] = str((source_payload or {}).get("url") or "")[:500]
        result["story"]["source_type"] = source
        result["debug"] = trace
        _store_article(cache_key, result)
        return result
    raise GenerationError("模型输出无法整理成文章", code="AI_OUTPUT_INVALID", request_id=request_id)


def _chat_completion(cfg: dict, messages: list[dict], timeout: tuple = (10, 120),
                     json_mode: bool = False, *, skill_name: str = "story_generation",
                     prompt_version: str = "unversioned", retries: int = 1,
                     cache: bool = True, metadata: dict | None = None) -> dict:
    """Compatibility wrapper; all model traffic is delegated to llm_gateway."""
    return llm_gateway.complete(
        skill_name=skill_name,
        prompt_version=prompt_version,
        messages=messages,
        config=cfg,
        json_mode=json_mode,
        temperature=.7,
        timeout=timeout,
        retries=retries,
        cache=cache,
        metadata=metadata,
    )


def _extract_json(content: str) -> dict:
    """从模型输出提取 JSON：容忍代码块围栏与多余散文。"""
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("响应中未找到 JSON 对象")
    return json.loads(text[start: end + 1])


def _parse_article_text(content: str) -> dict:
    """Parse the delimiter protocol used because Zhida does not guarantee JSON mode."""
    text = str(content or "").replace("\r\n", "\n").strip()
    markers = ("TITLE", "GENRE", "EN", "ZH", "TAKEAWAY")
    sections: dict[str, str] = {}
    matches = list(re.finditer(r"(?im)^\s*\[(TITLE|GENRE|EN|ZH|TAKEAWAY)\]\s*$", text))
    if matches:
        for index, match in enumerate(matches):
            key = match.group(1).lower()
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            sections[key] = text[match.end():end].strip()
    else:
        raise ValueError("响应中未找到 [TITLE]/[EN]/[ZH] 分段")
    if not all(sections.get(key) for key in ("title", "en", "zh")):
        missing = ", ".join(key.upper() for key in markers if not sections.get(key.lower()))
        raise ValueError(f"输出缺少分段：{missing}")
    return {
        "title": sections["title"],
        "genre": sections.get("genre") or "daily-science",
        "en": sections["en"],
        "zh": sections["zh"],
        "takeaway": sections.get("takeaway", ""),
    }


def _parse_english_draft(content: str) -> dict:
    """Accept Zhida's common Markdown article response when it ignores delimiters."""
    text = str(content or "").replace("\r\n", "\n").strip()
    text = re.sub(r"^```(?:markdown|text)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text).strip()
    section_match = re.search(r"(?im)^\s*\[EN\]\s*$", text)
    if section_match:
        tail = text[section_match.end():]
        next_marker = re.search(r"(?im)^\s*\[(?:ZH|TAKEAWAY)\]\s*$", tail)
        body = tail[:next_marker.start()].strip() if next_marker else tail.strip()
        title_match = re.search(r"(?im)^\s*\[TITLE\]\s*\n(.+?)\s*(?:\n|$)", text)
        title = title_match.group(1).strip() if title_match else "A Closer Look at Everyday Change"
        if body:
            return {"title": title, "genre": "daily-science", "en": body}
    lines = text.splitlines()
    first = next((index for index, line in enumerate(lines) if line.strip()), None)
    if first is None:
        raise ValueError("模型未返回文章内容")
    heading = lines[first].strip()
    title = re.sub(r"^#{1,6}\s*", "", heading)
    title = re.sub(r"^\*\*(.*?)\**$", r"\1", title).strip()
    body = "\n".join(lines[first + 1:]).strip()
    if not body or len(title) > 120:
        raise ValueError("自然文本响应缺少可识别的英文标题或正文")
    return {"title": title, "genre": "daily-science", "en": body}


def _parse_translation(content: str, cards: list[dict]) -> dict:
    text = str(content or "").replace("\r\n", "\n").strip()
    takeaway = ""
    match = re.search(r"(?im)^\s*\[ZH\]\s*$", text)
    if match:
        tail = text[match.end():]
        take_match = re.search(r"(?im)^\s*\[TAKEAWAY\]\s*$", tail)
        if take_match:
            takeaway = tail[take_match.end():].strip()
            text = tail[:take_match.start()].strip()
        else:
            text = tail.strip()
    text = re.sub(r"^(?:中文翻译|翻译|Chinese Translation)\s*[：:]\s*", "", text, flags=re.IGNORECASE)
    for card in cards:
        word = str(card.get("word") or "").strip()
        if not word:
            continue
        if not re.search(re.escape(word), text, re.IGNORECASE):
            raise ValueError(f"中文翻译未保留目标词：{word}")
        text = re.sub(rf"(?<!\*)\b{re.escape(word)}\b(?!\*)", f"**{word}**", text, flags=re.IGNORECASE)
    return {"zh": text, "takeaway": takeaway}


def _validate_english_draft(draft: dict, cards: list[dict], params: dict) -> None:
    title = str(draft.get("title") or "").strip()
    english = str(draft.get("en") or "").strip()
    if not title:
        raise ValueError("文章缺少英文标题")
    if _contains_restricted_content(title, english):
        raise ValueError("文章触发内容安全规则")
    for card in cards:
        word = str(card.get("word") or "").strip()
        if not re.search(rf"\*\*{re.escape(word)}\*\*", english, re.I):
            raise ValueError(f"目标词未在英文中正确加粗：{word}")
    count = len(re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", english))
    if count < 180 or count > 260:
        raise ValueError(f"故事长度不符合目标范围：{count} 词，目标约 {params.get('length', 220)} 词")


def _gloss_line(card: dict) -> str:
    """代码生成词义表的一行：word（词性）中文释义。AI 不再输出中文，词义由词卡直接拼入。"""
    word = str(card.get("word") or "").strip()
    pos = str(card.get("pos") or "").strip()
    meaning = str(card.get("meaning_cn") or card.get("meaning") or card.get("meaning_en") or "").strip()
    return f"{word}（{pos}）{meaning}".replace("（）", "").strip() if word else ""


def _hook_line(card: dict) -> str:
    """代码生成记忆口诀行：**word**：中文释义（兼容旧练习兜底解析格式）。"""
    word = str(card.get("word") or "").strip()
    meaning = str(card.get("meaning_cn") or card.get("meaning") or card.get("meaning_en") or "").strip()
    return f"**{word}**：{meaning}" if word else ""


def _normalize_target_markup(text: str, cards: list[dict]) -> str:
    normalized = str(text or "")
    for card in cards:
        word = str(card.get("word") or "").strip()
        if not word or re.search(rf"\*\*{re.escape(word)}\*\*", normalized, re.IGNORECASE):
            continue
        if not re.search(rf"\b{re.escape(word)}\b", normalized, re.IGNORECASE):
            raise ValueError(f"目标词未出现在文章中：{word}")
        normalized = re.sub(
            rf"(?<!\*)\b{re.escape(word)}\b(?!\*)",
            lambda match: f"**{match.group(0)}**",
            normalized,
            count=1,
            flags=re.IGNORECASE,
        )
    return normalized


def _normalize(mode: str, payload: dict, cards: list[dict] | None = None, params: dict | None = None) -> dict:
    """校验并规整 AI 返回结构；不满足结构则抛 ValueError 以触发重试。

    AI 输出双语文章：{title, genre, en, zh, takeaway}。记忆口诀 / 免责声明 / 报头
    元信息由代码从词卡生成。"""
    if mode == "story":
        if not isinstance(payload, dict):
            raise ValueError("输出结构不完整：应为 JSON 对象")
        title = str(payload.get("title") or "").strip()
        en = str(payload.get("en") or "").strip()
        zh = str(payload.get("zh") or "").strip()
        takeaway = str(payload.get("takeaway") or "").strip()
        if not title or not en or not zh:
            raise ValueError("输出结构不完整：缺少 title、en 或 zh 中文翻译")
        if _contains_restricted_content(title, en, zh, takeaway):
            raise ValueError("文章触发内容安全规则")
        if cards:
            en = _normalize_target_markup(en, cards)
            zh = _normalize_target_markup(zh, cards)
        # 标题自然性：2 词以上、非首字母串联、非全小写关键词列表，且避开批量问句模板。
        if len(title) > 160:
            raise ValueError("英文标题过长")
        if cards:
            for card in cards:
                word = str(card.get("word") or "").strip()
                if not re.search(rf"\*\*{re.escape(word)}\*\*", en, re.IGNORECASE):
                    raise ValueError(f"目标词未在英文中正确加粗：{word}")
                if not re.search(rf"\*\*{re.escape(word)}\*\*", zh, re.IGNORECASE):
                    raise ValueError(f"目标词未在中文翻译中保留并加粗：{word}")
        # 基本逻辑：至少 3 个完整句子，避免碎片化堆砌
        if len(re.findall(r"[.!?](?:\s|$)", en)) < 3:
            raise ValueError("文章缺少基本叙事结构：至少需要 3 个完整句子")
        if cards:
            count = len(re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", en))
            target = int((params or {}).get("length", 220))
            target = max(180, min(260, target))
            lower = 180
            upper = 260
            if count < lower or count > upper:
                raise ValueError(f"故事长度不符合目标范围：{count} 词，目标约 {target} 词")
        genre = str(payload.get("genre") or "daily-science").strip()
        if genre not in ("daily-science", "daily-curiosity", "light-entertainment"): 
            genre = "daily-science"
        # 口诀由词卡释义拼接；中文正文使用模型返回的完整译文。
        card_list = cards or []
        hooks = [h for h in (_hook_line(c) for c in card_list) if h]
        takeaway = takeaway or "Review the highlighted words and use them in your own sentence."
        return {"story": {
            "publication": "知乎英语日报 · Zhihu English Daily",
            "genre": genre,
            "dateline": "知乎英语日报 · Learning Edition",
            "title": title,
            "en": en,
            "takeaway": takeaway[:240],
            "cn": zh,
            "zh": zh,
            "hooks": hooks,
            "disclaimer": "本文为基于知乎公开内容生成的英语学习材料；已进行摘要与改写，不替代原文。",
            "source_note": "",
        }}
    raise ValueError("仅支持故事记忆")



