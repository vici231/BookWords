"""Local weekly/monthly aggregation. This module never calls an LLM."""

from __future__ import annotations

from datetime import datetime


def _date(value: object) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def aggregate(raw: object, period: str) -> dict:
    articles = [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []
    groups: dict[str, dict] = {}
    for article in articles[:500]:
        when = _date(article.get("generatedAt") or article.get("savedAt"))
        if not when:
            continue
        key = when.strftime("%Y-%m") if period == "month" else str(article.get("weekKey") or when.strftime("%Y-%W"))
        group = groups.setdefault(key, {"key": key, "articles": [], "words": set(), "themes": {}, "sources": {}})
        group["articles"].append(article)
        for word in article.get("targetWords", []) if isinstance(article.get("targetWords"), list) else []:
            if word:
                group["words"].add(str(word).casefold())
        sorting = article.get("sorting") if isinstance(article.get("sorting"), dict) else {}
        selected = sorting.get("selected_group") if isinstance(sorting.get("selected_group"), dict) else {}
        theme = str(selected.get("theme") or article.get("genre") or "其他主题")
        group["themes"].setdefault(theme, set()).update(str(word) for word in selected.get("words", []) if word)
        source = str((article.get("story") or {}).get("source_type") or "original")
        group["sources"][source] = group["sources"].get(source, 0) + 1
    result = []
    for key in sorted(groups, reverse=True):
        item = groups[key]
        result.append({
            "key": key,
            "article_count": len(item["articles"]),
            "word_count": len(item["words"]),
            "themes": [{"name": name, "words": sorted(words)} for name, words in item["themes"].items()],
            "sources": item["sources"],
        })
    return {"ok": True, "period": period, "groups": result, "ai_calls": 0}
