"""Group vocabulary by whether the words can support one coherent article."""

from __future__ import annotations

import json
import re
import uuid

try:
    from backend import llm_gateway, prompt_templates, settings_store
except ImportError:  # pragma: no cover
    import llm_gateway  # type: ignore
    import prompt_templates  # type: ignore
    import settings_store  # type: ignore

MAX_ARTICLE_WORDS = 20
MAX_CANDIDATE_WORDS = 80

_DOMAINS = {
    "人物与关系": ("人", "朋友", "家庭", "社会", "关系", "交流", "情感", "person", "people", "social", "friend"),
    "思考与学习": ("学习", "知识", "思考", "记忆", "理解", "发现", "研究", "learn", "think", "idea", "knowledge"),
    "行动与变化": ("行动", "改变", "发展", "过程", "移动", "增长", "减少", "change", "move", "grow", "action"),
    "自然与环境": ("自然", "环境", "动物", "植物", "天气", "地球", "nature", "environment", "animal", "plant"),
    "科技与工作": ("科技", "技术", "工作", "商业", "系统", "工具", "网络", "technology", "work", "business", "system"),
    "感受与选择": ("感受", "情绪", "快乐", "害怕", "选择", "希望", "feel", "emotion", "choose", "hope"),
}
_TOKEN_RE = re.compile(r"[A-Za-z]{3,}|[\u4e00-\u9fff]{2,}")


def _extract_json(content: str) -> dict:
    text = str(content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("排序响应中没有 JSON 对象")
    payload = json.loads(text[start:end + 1])
    if not isinstance(payload, dict):
        raise ValueError("排序响应不是 JSON 对象")
    return payload


def _card_text(card: dict) -> str:
    return " ".join(str(card.get(key) or "") for key in ("word", "meaning_cn", "meaning_en")).casefold()


def _tokens(card: dict) -> set[str]:
    return {token.casefold() for token in _TOKEN_RE.findall(_card_text(card))}


def _domain_scores(card: dict) -> dict[str, int]:
    text = _card_text(card)
    return {name: sum(token in text for token in keywords) for name, keywords in _DOMAINS.items()}


def _source_tokens(source_payload: dict | None) -> set[str]:
    item = source_payload if isinstance(source_payload, dict) else {}
    text = " ".join([
        str(item.get("title") or ""), str(item.get("summary") or item.get("excerpt") or ""),
        " ".join(str(label) for label in (item.get("labels") or [])[:10]),
    ])
    return {token.casefold() for token in _TOKEN_RE.findall(text)}


def local_group(cards: list[dict], source_payload: dict | None = None) -> dict:
    """Deterministic semantic fallback; it never groups by POS or difficulty."""
    cards = cards[:MAX_CANDIDATE_WORDS]
    source = _source_tokens(source_payload)
    buckets: dict[str, list[dict]] = {}
    unclassified: list[dict] = []
    for card in cards:
        scores = _domain_scores(card)
        domain, score = max(scores.items(), key=lambda item: item[1])
        if score:
            buckets.setdefault(domain, []).append(card)
        else:
            unclassified.append(card)

    groups: list[dict] = []
    for theme, items in buckets.items():
        for index in range(0, len(items), MAX_ARTICLE_WORDS):
            chunk = items[index:index + MAX_ARTICLE_WORDS]
            words = [item["word"] for item in chunk]
            overlap = len(set().union(*(_tokens(item) for item in chunk)) & source) if source else 0
            groups.append({
                "theme": theme,
                "words": words,
                "reason": f"这些词的释义共同指向“{theme}”，可以在同一场景、动作或因果链中自然展开。",
                "coherence": min(1.0, round(0.48 + len(words) * 0.025 + overlap * 0.04, 2)),
            })
    if unclassified:
        for index in range(0, len(unclassified), MAX_ARTICLE_WORDS):
            words = [item["word"] for item in unclassified[index:index + MAX_ARTICLE_WORDS]]
            groups.append({
                "theme": "日常问题与具体选择",
                "words": words,
                "reason": "这些词可围绕一个具体人物、问题和结果组织为连续的日常文章。",
                "coherence": min(0.62, round(0.38 + len(words) * 0.02, 2)),
            })
    if not groups:
        raise ValueError("没有可供分组的有效词汇")
    groups.sort(key=lambda group: (group["coherence"], len(group["words"])), reverse=True)
    selected = next((group for group in groups if len(group["words"]) >= 3), groups[0])
    if len(selected["words"]) < 3:
        groups = [{
            "theme": "日常问题与具体选择",
            "words": [card["word"] for card in cards[index:index + MAX_ARTICLE_WORDS]],
            "reason": "将词汇合并为具体人物、问题和结果明确的日常语境。",
            "coherence": 0.4,
        } for index in range(0, len(cards), MAX_ARTICLE_WORDS)]
        selected = groups[0]
    return {"provider": "local-semantic", "groups": groups, "selected_group": dict(selected)}


def _normalize(payload: dict, cards: list[dict]) -> dict:
    allowed = {str(card["word"]).casefold(): str(card["word"]) for card in cards}
    groups: list[dict] = []
    for item in payload.get("groups", []):
        if not isinstance(item, dict):
            continue
        words: list[str] = []
        for value in item.get("words", []) if isinstance(item.get("words"), list) else []:
            word = allowed.get(str(value).casefold())
            if word and word not in words and len(words) < MAX_ARTICLE_WORDS:
                words.append(word)
        if not words:
            continue
        try:
            coherence = float(item.get("coherence", 0.5))
        except (TypeError, ValueError):
            coherence = 0.5
        groups.append({
            "theme": str(item.get("theme") or "共同语境")[:80],
            "words": words,
            "reason": str(item.get("reason") or "这些词可在同一篇文章中自然表达")[:240],
            "coherence": max(0.0, min(1.0, coherence)),
        })
    if not groups:
        raise ValueError("排序结果缺少有效 groups")
    covered = {word.casefold() for group in groups for word in group["words"]}
    missing_cards = [card for card in cards if str(card["word"]).casefold() not in covered]
    if missing_cards:
        groups.extend(local_group(missing_cards)["groups"])
    groups.sort(key=lambda group: (group["coherence"], len(group["words"])), reverse=True)
    selected = next((group for group in groups if len(group["words"]) >= 3), None)
    if not selected:
        raise ValueError("排序结果没有至少 3 个词的可成文分组")
    return {"provider": "external-api", "groups": groups, "selected_group": dict(selected)}


def group_cards(cards: list[dict], source_payload: dict | None = None) -> dict:
    cards = cards[:MAX_CANDIDATE_WORDS]
    version = prompt_templates.version("word_sort")
    cfg = settings_store.effective_api()
    prompt = (
        "你是词汇成文规划器。唯一任务是判断哪些目标词能在同一篇短文中自然表达。"
        "不要按词性、首字母或难度机械分类；应寻找共同人物、场景、动作、问题、机制或因果关系。"
        "每组 3—20 词，不得添加输入外的词。按语境完整度、词义兼容度、覆盖量、可读性和题材匹配度排序。"
        "只输出 JSON：{groups:[{theme,words,reason,coherence}]}，coherence 为 0 到 1。"
    )
    request = {"cards": cards, "topic": source_payload or {}}
    try:
        response = llm_gateway.complete(
            skill_name="word_sort", prompt_version=version,
            messages=[{"role": "system", "content": prompt}, {"role": "user", "content": json.dumps(request, ensure_ascii=False)}],
            config=cfg, json_mode=True, temperature=0.15, retries=0, cache=False,
            metadata={"request_id": uuid.uuid4().hex[:12], "word_count": len(cards)},
        )
        result = _normalize(_extract_json(response["content"]), cards)
        result["metrics"] = response["metrics"]
        return result
    except Exception as exc:
        result = local_group(cards, source_payload)
        result["reason"] = f"AI 排序不可用，已使用本地语境规则：{exc}"
        return result
