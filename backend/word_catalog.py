"""word_catalog.py — 按难度分级的词库加载与检索。

设计原则：
- 只按需懒加载「当前选中的难度」那一本词库，不一次性读入全部；
- 对外只返回「部分结果」（搜索/随机/每日），绝不列出全部单词；
- 每条记录归一化为卡片模型（word / pos / meaning_cn / phrases …）。

词库文件：wordlist/json/{序号}-{难度}-顺序.json，如 1-初中-顺序.json。
自设单词：backend/custom_words.json（与原始词库互不影响）。

对外全部是公有函数（level_path / merge_cards 等），路由层不再触达下划线私有名。
"""

from __future__ import annotations

import datetime
import json
import random
import re
from pathlib import Path

try:
    from backend import word_utils
except ImportError:  # `python backend/app.py` 直接运行时
    import word_utils  # type: ignore

WORDLIST_DIR = Path(__file__).resolve().parent.parent / "wordlist" / "json"
CUSTOM_WORDS_FILE = Path(__file__).resolve().parent / "custom_words.json"
_RANKS = ["A", "J", "Q", "K"]

_levels_cache: list[dict] | None = None
_word_cache: dict[str, list[dict]] = {}
_all_cache: list[dict] | None = None


# ---------------------------------------------------------------------------
# 难度分级
# ---------------------------------------------------------------------------

def _scan_levels() -> list[dict]:
    """扫描 wordlist/json/ 下的难度分级文件。"""
    levels: list[dict] = []
    if WORDLIST_DIR.is_dir():
        for f in sorted(WORDLIST_DIR.glob("*.json")):
            m = re.match(r"^(\d+)-(.+)-顺序\.json$", f.name)
            if m:
                levels.append({"id": m.group(2), "label": m.group(2), "path": str(f)})
    return levels


def list_levels() -> list[dict]:
    """返回可用难度列表（不含词数，词数随加载再填充，避免全量读入）。"""
    global _levels_cache
    if _levels_cache is None:
        _levels_cache = _scan_levels()
    return _levels_cache


def level_path(level_id: str) -> str | None:
    """难度 id → 词库文件路径；不存在返回 None。"""
    for lv in list_levels():
        if lv["id"] == level_id:
            return lv["path"]
    return None


def normalize_level_id(level_id: str) -> str:
    """把任意 level 参数归一为合法难度 id（非法回退 all）。"""
    if level_id in ("all", "全部", "custom", "自设"):
        return level_id if level_id != "全部" else "all"
    return level_id if level_path(level_id) else "all"


# ---------------------------------------------------------------------------
# 词库加载
# ---------------------------------------------------------------------------

def _to_card(entry: dict, level_id: str, index: int) -> dict:
    """把原始 {word, translations, phrases} 归一化为卡片模型。"""
    word = str(entry.get("word") or "").strip()
    translations = entry.get("translations") or []
    phrases = entry.get("phrases") or []
    # 词性：由 translations 的 type 去重拼接（如 v + n -> "v.n."）
    types: list[str] = []
    for t in translations:
        ty = str((t.get("type") if isinstance(t, dict) else "") or "").strip()
        if ty and ty not in types:
            types.append(ty)
    pos = ".".join(types) + "." if types else ""
    meaning_cn = "；".join(
        str((t.get("translation") if isinstance(t, dict) else "") or "").strip()
        for t in translations
        if isinstance(t, dict) and (t.get("translation") or "").strip()
    )
    valence = word_utils.auto_valence({"word": word, "meaning_cn": meaning_cn})
    suit = word_utils.auto_suit({"word": word, "pos": pos, "meaning_cn": meaning_cn})
    phrase_list = [
        {"phrase": str(p.get("phrase") or "").strip(), "translation": str(p.get("translation") or "").strip()}
        for p in phrases if isinstance(p, dict) and (p.get("phrase") or "").strip()
    ]
    return {
        "word": word,
        "pos": pos,
        "phonetic": "",
        "meaning_cn": meaning_cn,
        "meaning_en": "",
        "etymology": "",
        "valence": valence,
        "suit": suit,
        "rank": _RANKS[index % 4],
        "example": "",
        "phrases": phrase_list,
        "level": level_id,
    }


def load_level(level_id: str) -> list[dict]:
    """懒加载并归一化某难度词库（缓存）。"""
    if level_id in _word_cache:
        return _word_cache[level_id]
    path = level_path(level_id)
    if not path:
        return []
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    cards = [
        _to_card(e, level_id, i)
        for i, e in enumerate(data)
        if isinstance(e, dict) and str(e.get("word") or "").strip()
    ]
    _word_cache[level_id] = cards
    return cards


def merge_cards(cards: list[dict]) -> list[dict]:
    """按不区分大小写的单词合并重复卡牌，并保留所有出现过的难度。"""
    merged: dict[str, dict] = {}
    for card in cards:
        key = str(card.get("word") or "").strip().casefold()
        if not key:
            continue
        if key not in merged:
            item = dict(card)
            levels = list(card.get("levels") or ([card["level"]] if card.get("level") else []))
            item["levels"] = list(dict.fromkeys(levels))
            item["level"] = " / ".join(item["levels"]) or "词库"
            merged[key] = item
            continue
        item = merged[key]
        levels = item.setdefault("levels", [])
        level = card.get("level") or ""
        if level and level not in levels:
            levels.append(level)
        item["level"] = " / ".join(levels) or "词库"
        for field in ("pos", "meaning_cn"):
            values = [v.strip() for v in str(item.get(field) or "").replace("；", ";").split(";") if v.strip()]
            incoming = [v.strip() for v in str(card.get(field) or "").replace("；", ";").split(";") if v.strip()]
            item[field] = "；".join(dict.fromkeys(values + incoming))
        if not item.get("phonetic") and card.get("phonetic"):
            item["phonetic"] = card["phonetic"]
        if not item.get("example") and card.get("example"):
            item["example"] = card["example"]
        existing_phrases = {p.get("phrase") for p in item.get("phrases") or [] if isinstance(p, dict)}
        item["phrases"] = (item.get("phrases") or []) + [
            p for p in (card.get("phrases") or [])
            if isinstance(p, dict) and p.get("phrase") not in existing_phrases
        ]
    return list(merged.values())


def cards_for_level(level_id: str) -> list[dict]:
    """返回指定词库；level=all 时合并全部词库，供全局搜索使用。"""
    global _all_cache
    if level_id in ("custom", "自设"):
        return load_custom_words()
    if not level_id or level_id in ("all", "全部"):
        if _all_cache is not None:
            return _all_cache
        cards: list[dict] = []
        for level in list_levels():
            cards.extend(load_level(level["id"]))
        cards.extend(load_custom_words())
        _all_cache = merge_cards(cards)
        return _all_cache
    return load_level(level_id)


def invalidate_all_cache() -> None:
    """自设单词发生变化后，清理全词库合并缓存。"""
    global _all_cache
    _all_cache = None


# ---------------------------------------------------------------------------
# 自设单词
# ---------------------------------------------------------------------------

def load_custom_words() -> list[dict]:
    """读取本地自设单词，不影响原始词库文件。"""
    try:
        data = json.loads(CUSTOM_WORDS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    cards = []
    for index, item in enumerate(data):
        if isinstance(item, dict) and str(item.get("word") or "").strip():
            card = dict(item)
            card["level"] = "自设"
            card["levels"] = ["自设"]
            card.setdefault("phrases", [])
            card.setdefault("rank", _RANKS[index % 4])
            cards.append(card)
    return cards


def save_custom_words(cards: list[dict]) -> None:
    CUSTOM_WORDS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CUSTOM_WORDS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cards, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CUSTOM_WORDS_FILE)


# ---------------------------------------------------------------------------
# 检索接口
# ---------------------------------------------------------------------------

def count(level_id: str) -> int:
    return len(cards_for_level(level_id))


def search(level_id: str, q: str = "", limit: int = 30, pos: str = "") -> list[dict]:
    """在指定词库（或全部词库）搜索词、释义和词性，返回匹配子集。"""
    cards = cards_for_level(level_id)
    q = (q or "").strip().lower()
    pos = (pos or "").strip().lower()
    hay = cards
    if q:
        hay = [c for c in hay if q in c["word"].lower() or q in c["meaning_cn"].lower() or q in c["pos"].lower()]
    if pos:
        hay = [c for c in hay if c["pos"].lower().startswith(pos)]
    return hay[:limit]


def random_words(level_id: str, count: int = 12) -> list[dict]:
    """随机抽取 count 个词。"""
    cards = cards_for_level(level_id)
    if not cards:
        return []
    return random.sample(cards, min(count, len(cards)))


def daily(level_id: str, count: int = 12) -> list[dict]:
    """按日期确定性抽一组（每日记忆）；同一天结果稳定。"""
    cards = cards_for_level(level_id)
    if not cards:
        return []
    seed = int(datetime.date.today().strftime("%Y%m%d"))
    return random.Random(seed).sample(cards, min(count, len(cards)))
