"""Observable word-to-publication pipeline used by the temporary debug window."""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import date
from typing import Any

logger = logging.getLogger(__name__)


try:
    from backend import llm_gateway, prompt_templates, settings_store, word_grouping
except ImportError:  # pragma: no cover
    import llm_gateway  # type: ignore
    import prompt_templates  # type: ignore
    import settings_store  # type: ignore
    import word_grouping  # type: ignore


def _extract_json(content: str) -> dict:
    text = str(content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("模型响应中没有 JSON 对象")
    payload = json.loads(text[start:end + 1])
    if not isinstance(payload, dict):
        raise ValueError("模型响应不是 JSON 对象")
    return payload


def import_words(raw: object, source: str) -> dict:
    items = raw if isinstance(raw, list) else []
    valid: list[dict] = []
    anomalies: list[dict] = []
    seen: set[str] = set()
    for index, item in enumerate(items[:200]):
        if isinstance(item, str):
            card = {"word": item}
        elif isinstance(item, dict):
            card = item
        else:
            anomalies.append({"index": index, "value": str(item)[:80], "reason": "不是字符串或词条对象"})
            continue
        word = str(card.get("word") or "").strip()
        if not word:
            anomalies.append({"index": index, "value": str(item)[:80], "reason": "缺少 word"})
            continue
        if not re.fullmatch(r"[A-Za-z][A-Za-z' -]{0,62}", word):
            anomalies.append({"index": index, "value": word[:80], "reason": "单词格式异常"})
            continue
        key = word.casefold()
        if key in seen:
            anomalies.append({"index": index, "value": word, "reason": "重复词条"})
            continue
        seen.add(key)
        valid.append({
            "word": word,
            "pos": str(card.get("pos") or "").strip()[:24],
            "meaning_cn": str(card.get("meaning_cn") or card.get("meaning") or "").strip()[:160],
            "meaning_en": str(card.get("meaning_en") or "").strip()[:200],
            "level": str(card.get("level") or ((card.get("levels") or [""])[0] if isinstance(card.get("levels"), list) and card.get("levels") else "")).strip()[:40],
        })
    return {
        "source": source or "manual",
        "raw_entries": items[:200],
        "raw_count": len(items),
        "valid_count": len(valid),
        "anomaly_count": len(anomalies),
        "valid_entries": valid,
        "anomalies": anomalies,
    }


def _difficulty(card: dict) -> str:
    marker = f"{card.get('level', '')} {card.get('word', '')}".lower()
    if any(token in marker for token in ("cet6", "sat", "gre", "toefl", "advanced")) or len(card["word"]) >= 10:
        return "advanced"
    if any(token in marker for token in ("cet4", "high", "senior")) or len(card["word"]) >= 7:
        return "intermediate"
    return "foundation"


def _fallback_sort(cards: list[dict]) -> dict:
    buckets: dict[str, list[str]] = {}
    for card in cards:
        pos = card.get("pos", "").lower()
        theme = "动作与变化" if pos.startswith("v") else "描述与感受" if pos.startswith(("adj", "adv")) else "人物与事物"
        buckets.setdefault(theme, []).append(card["word"])
    clusters = [{"theme": theme, "words": words} for theme, words in buckets.items()]
    layers = {"foundation": [], "intermediate": [], "advanced": []}
    for card in cards:
        layers[_difficulty(card)].append(card["word"])
    groups = []
    for index in range(0, len(cards), 6):
        words = [card["word"] for card in cards[index:index + 6]]
        groups.append({"id": f"G{len(groups) + 1:02d}", "theme": "综合记忆场景", "words": words, "reason": "按规模均衡分组，等待语义排序恢复"})
    cooccurrence = []
    for group in groups:
        words = group["words"]
        for index in range(len(words) - 1):
            cooccurrence.append({"words": [words[index], words[index + 1]], "reason": "可在同一记忆句中共同出现"})
    return {"semantic_clusters": clusters, "difficulty_layers": layers, "cooccurrence": cooccurrence[:12], "optimal_groups": groups}


def _normalize_sort(payload: dict, cards: list[dict]) -> dict:
    allowed = {card["word"].casefold(): card["word"] for card in cards}

    def words(values: object) -> list[str]:
        result = []
        for value in values if isinstance(values, list) else []:
            canonical = allowed.get(str(value).casefold())
            if canonical and canonical not in result:
                result.append(canonical)
        return result

    clusters = []
    for item in payload.get("semantic_clusters", []):
        if isinstance(item, dict) and words(item.get("words")):
            clusters.append({"theme": str(item.get("theme") or "综合主题")[:50], "words": words(item.get("words"))})
    raw_layers = payload.get("difficulty_layers") if isinstance(payload.get("difficulty_layers"), dict) else {}
    layers = {key: words(raw_layers.get(key)) for key in ("foundation", "intermediate", "advanced")}
    relations = []
    for item in payload.get("cooccurrence", []):
        pair = words(item.get("words")) if isinstance(item, dict) else []
        if len(pair) >= 2:
            relations.append({"words": pair[:3], "reason": str(item.get("reason") or "语义共现")[:120]})
    groups = []
    covered: set[str] = set()
    for item in payload.get("optimal_groups", []):
        if not isinstance(item, dict):
            continue
        group_words = [word for word in words(item.get("words")) if word.casefold() not in covered]
        if not group_words:
            continue
        covered.update(word.casefold() for word in group_words)
        groups.append({
            "id": f"G{len(groups) + 1:02d}",
            "theme": str(item.get("theme") or "综合主题")[:60],
            "words": group_words,
            "reason": str(item.get("reason") or "语义与难度平衡")[:160],
        })
    missing = [card["word"] for card in cards if card["word"].casefold() not in covered]
    for index in range(0, len(missing), 6):
        groups.append({"id": f"G{len(groups) + 1:02d}", "theme": "补充分组", "words": missing[index:index + 6], "reason": "确保所有导入词条进入生成链路"})
    if not clusters or not groups:
        raise ValueError("排序结果缺少语义聚类或最优分组")
    return {"semantic_clusters": clusters, "difficulty_layers": layers, "cooccurrence": relations, "optimal_groups": groups}


def sort_words(cards: list[dict], run_id: str) -> tuple[dict, dict]:
    grouped = word_grouping.group_cards(cards)
    groups = [{"id": f"G{index + 1:02d}", **group} for index, group in enumerate(grouped["groups"])]
    output = {
        "provider": grouped["provider"],
        "groups": grouped["groups"],
        "selected_group": grouped["selected_group"],
        "semantic_clusters": [{"theme": group["theme"], "words": group["words"]} for group in groups],
        "difficulty_layers": {"foundation": [], "intermediate": [], "advanced": []},
        "cooccurrence": [],
        "optimal_groups": groups,
    }
    metric = grouped.get("metrics") or {
        "skill": "word_sort", "prompt_version": prompt_templates.version("word_sort"),
        "provider": "local-semantic", "model": "none", "fallback": True,
        "cache_hit": False, "status": "fallback", "input_tokens": 0,
        "output_tokens": 0, "total_tokens": 0, "elapsed_ms": 0,
        "metadata": {"run_id": run_id, "word_count": len(cards)},
    }
    return output, metric


def _source_context(source: str, payload: dict | None) -> dict:
    item = payload if isinstance(payload, dict) else {}
    return {
        "type": source or "original",
        "question_or_title": str(item.get("title") or item.get("question") or "")[:240],
        "summary": str(item.get("summary") or item.get("excerpt") or item.get("description") or "")[:800],
        "answer_outline": str(item.get("content") or item.get("answer_outline") or "")[:1800],
        "tags": [str(tag)[:50] for tag in (item.get("labels") or item.get("tags") or [])[:10]],
        "author": str(item.get("author") or "")[:80],
        "url": str(item.get("url") or "")[:500],
        "vote_up_count": int(item.get("vote_up_count") or 0),
    }


def _source_note(source_context: dict) -> str:
    title = str(source_context.get("question_or_title") or "").strip()
    stype = source_context.get("type", "")
    if not title:
        return "来源：AI 原创生成｜Bookwords 英语学习材料"
    if stype == "zhihu_search":
        note = f"来源：知乎《{title}》"
        if source_context.get("author"):
            note += f"｜作者：{source_context['author']}"
        if source_context.get("vote_up_count"):
            note += f"｜赞同 {source_context['vote_up_count']}"
        return note
    if stype == "hot":
        return f"来源：知乎热榜《{title}》"
    if stype == "story":
        return f"来源：知乎故事《{title}》"
    if stype == "knowledge":
        return f"来源：知乎知识《{title}》"
    return "来源：AI 原创生成｜Bookwords 英语学习材料"


def _fallback_story(words: list[str], source_context: dict) -> dict:
    raise RuntimeError("文章生成 API 暂时不可用，请稍后重试")


def generate_story(group: dict, source_context: dict, run_id: str) -> tuple[dict, dict]:
    words = list(group.get("words") or [])
    version = prompt_templates.version("pipeline_story")
    cfg = settings_store.effective_api()
    system = (
        "你是知乎英语日报生文编辑。给定词集和题材约束，写一篇真实语境感的短文。知乎问题可作标题或切入点，"
        "回答摘要只作为论点骨架，不得逐句复制。"
        "标题必须是4至9词的编辑式陈述标题，提炼具体场景、机制、结果或反差；不得以 Why、What、How、Can、"
        "Could、Do、Does、Did、Is、Are、Should 开头，不得机械复述知乎问题，通常不用问号。"
        "每个目标词须以 **word** 出现在英文中。"
        "输出 JSON：{title,en,zh}。en 为 120-220 词英文短文，zh 为忠实中文呈现，不得增加事实。"
    )
    request_payload = {"word_group": group, "topic_constraint": source_context}
    messages = [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(request_payload, ensure_ascii=False)}]
    try:
        response = llm_gateway.complete(
            skill_name="story_generation", prompt_version=version, messages=messages, config=cfg,
            json_mode=True, temperature=.65, retries=2, metadata={"run_id": run_id, "words": words, "source": source_context.get("type")},
        )
        payload = _extract_json(response["content"])
        story = {"title": str(payload.get("title") or "").strip(), "en": str(payload.get("en") or "").strip(), "zh": str(payload.get("zh") or "").strip(), "mode": "article", "source_note": _source_note(source_context)}
        if not all(story[key] for key in ("title", "en", "zh")):
            raise ValueError("生文结果缺少 title、en 或 zh")
        for word in words:
            if not re.search(rf"\*\*{re.escape(word)}\*\*", story["en"], re.IGNORECASE):
                raise ValueError(f"目标词未加粗：{word}")
        return story, response["metrics"]
    except Exception as exc:
        logger.error("story_generation failed: %s", exc)
        metric = llm_gateway.record_fallback("story_generation", version, str(exc), cfg, {"run_id": run_id, "words": words})
        raise RuntimeError(f"文章生成 API 失败：{exc}") from exc


def _fallback_digest(story: dict, words: list[str], source_context: dict) -> dict:
    return {
        "weekly": {
            "format": "vocabulary_map",
            "title": "本周词汇地图",
            "summary": f"以“{story['title']}”为起点，将 {len(words)} 个目标词按语义与难度重新组织。",
            "themes": [{"name": "当前主题", "words": words}],
            "source_note": _source_note(source_context),
        },
        "monthly": {
            "format": "theme_collection",
            "title": "本月主题合辑",
            "summary": "将每日文章沉淀为科技、商业、文化等主题单元，数据积累后再生成跨文综述。",
            "candidate_themes": ["科技", "商业", "文化"],
            "source_note": _source_note(source_context),
        },
    }


def build_digest(story: dict, sorted_words: dict, source_context: dict, run_id: str) -> tuple[dict, dict]:
    words = [word for group in sorted_words["optimal_groups"] for word in group["words"]]
    words = list(dict.fromkeys(words))
    return _fallback_digest(story, words, source_context), {
        "skill": "periodical_digest", "prompt_version": prompt_templates.version("periodical_digest"),
        "provider": "local-aggregation", "model": "none", "fallback": False,
        "cache_hit": False, "status": "success", "input_tokens": 0,
        "output_tokens": 0, "total_tokens": 0, "elapsed_ms": 0,
        "metadata": {"run_id": run_id, "word_count": len(words), "ai_calls": 0},
    }


def run_pipeline(payload: dict, resolved_source: dict | None = None) -> dict:
    run_id = uuid.uuid4().hex[:12]
    language = "zh" if payload.get("language") == "zh" else "en"
    imported = import_words(payload.get("words"), str(payload.get("import_source") or "manual"))
    cards = imported["valid_entries"]
    if len(cards) < 3:
        return {"ok": False, "run_id": run_id, "error": "至少需要 3 个有效词条", "import": imported}

    sorted_output, sort_metric = sort_words(cards, run_id)
    primary_group = sorted_output["optimal_groups"][0]
    source_context = _source_context(str(payload.get("source") or "original"), resolved_source or payload.get("source_payload"))
    story, story_metric = generate_story(primary_group, source_context, run_id)
    digests, digest_metric = build_digest(story, sorted_output, source_context, run_id)
    selected_content = story["zh"] if language == "zh" else story["en"]
    fallback = any(metric.get("fallback") for metric in (sort_metric, story_metric, digest_metric))
    daily = {
        "date": date.today().isoformat(),
        "word_set": primary_group["words"],
        "title": story["title"],
        "content": selected_content,
        "content_en": story["en"],
        "content_zh": story["zh"],
        "language": language,
        "status": "fallback_success" if fallback else "success",
        "source_note": story["source_note"],
    }
    return {
        "ok": True,
        "run_id": run_id,
        "import": imported,
        "sorting": sorted_output,
        "story": {
            "input_words": primary_group["words"],
            "topic_constraint": source_context,
            "title": story["title"],
            "en": story["en"],
            "zh": story["zh"],
            "mode": story["mode"],
            "prompt_version": prompt_templates.version("pipeline_story"),
            "fallback": bool(story_metric.get("fallback")),
            "source_note": story["source_note"],
        },
        "language": {"selected": language, "available": ["zh", "en"], "content": selected_content},
        "daily": daily,
        "weekly": digests["weekly"],
        "monthly": digests["monthly"],
        "metrics": [sort_metric, story_metric, digest_metric],
        "prompt_versions": prompt_templates.versions(),
    }
