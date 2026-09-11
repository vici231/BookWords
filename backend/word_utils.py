"""word_utils.py — 词条归一化 + 自动补全。

把任意结构的词条记录（中英文键、缺字段）归一化为统一的单词卡模型：
- 缺 词性(pos)      → 按词缀/词形粗略推断，推断不出留空
- 缺 情感(valence)  → 用积极/消极关键词启发式推断，默认 neutral
- 缺 花色(suit)     → 按词性/情感自动映射（动词=方块、形容词=红心、名词=梅花、其余=黑桃）
- 缺 牌面(rank)     → 按索引循环 A/J/Q/K

仅提供纯函数，不落盘（词库文件由 word_catalog 管理）。
"""

from __future__ import annotations

# 通用字段别名：优先英文标准键，其次常见中文键
_ALIAS = {
    "word": ["word", "单词", "headword", "term", "word_en", "name"],
    "pos": ["pos", "词性", "type", "part_of_speech", "词类", "词"],
    "phonetic": ["phonetic", "音标", "pronunciation", "ipa", "读音"],
    "meaning_cn": ["meaning_cn", "释义", "中文", "中文释义", "meaning", "意思", "translation", "definition", "解释"],
    "meaning_en": ["meaning_en", "英文释义", "definition_en", "english", "英文", "gloss"],
    "etymology": ["etymology", "词源", "词根", "root"],
    "valence": ["valence", "情感", "褒贬", "sentiment", "polarity", "tone"],
    "suit": ["suit", "花色"],
    "rank": ["rank", "牌面", "点数"],
    "example": ["example", "例句", "例子", "sentence", "ex"],
}

_RANKS = ["A", "J", "Q", "K"]

# 积极 / 消极情感关键词（用于缺 valence 时的启发式推断）
_POS_WORDS = {
    "bright", "happy", "love", "joy", "good", "great", "beautiful", "kind", "tender", "luminous",
    "cherish", "hope", "lucky", "peace", "warm", "gentle", "calm", "delight", "smile", "bless",
    "喜悦", "高兴", "爱", "美好", "温柔", "光明", "希望", "幸福", "喜欢", "快乐", "亲爱", "珍贵",
}
_NEG_WORDS = {
    "dark", "sad", "hate", "fear", "bad", "angry", "cruel", "bleak", "abandon", "despair",
    "pain", "loss", "lonely", "cold", "doubt", "vanish", "grim", "荒凉", "悲伤", "恐惧", "恨",
    "抛弃", "黑暗", "痛苦", "孤独", "绝望", "惨淡", "愤怒", "失败",
}


def _pick(entry: dict, key: str) -> str:
    """按别名表取字段；返回去掉首尾空白的字符串。"""
    for k in _ALIAS.get(key, [key]):
        if k in entry and entry[k] is not None:
            v = entry[k]
            if isinstance(v, (list, tuple)):
                v = v[0] if v else ""
            return str(v).strip()
    return ""


def auto_valence(entry: dict) -> str:
    """推断情感色彩：优先已有字段；否则用关键词启发式。"""
    v = _pick(entry, "valence").lower()
    if v in ("positive", "pos", "褒义", "积极", "正面", "good"):
        return "positive"
    if v in ("negative", "neg", "贬义", "消极", "负面", "bad"):
        return "negative"
    if v in ("neutral", "中性", "中立"):
        return "neutral"
    text = f"{_pick(entry, 'word')} {_pick(entry, 'meaning_cn')} {_pick(entry, 'meaning_en')}".lower()
    if any(w in text for w in _POS_WORDS):
        return "positive"
    if any(w in text for w in _NEG_WORDS):
        return "negative"
    return "neutral"


def detect_pos(entry: dict) -> str:
    """推断词性：缺 pos 时用词缀/词形粗略判断（仅供花色映射参考）。"""
    p = _pick(entry, "pos").lower()
    if p:
        if p.startswith("n"):
            return "n."
        if p.startswith("v"):
            return "v."
        if p.startswith("adj") or p.startswith("a"):
            return "adj."
        return p
    w = _pick(entry, "word").lower()
    if w.endswith("ly"):
        return "adv."
    if w.endswith(("tion", "ment", "ness", "ity", "ship", "ism", "ance", "ence", "er", "or")):
        return "n."
    if w.endswith(("ize", "ise", "ify", "ate")):
        return "v."
    if w.endswith(("ous", "ful", "ive", "able", "ible", "al", "ic")):
        return "adj."
    return ""


def auto_suit(entry: dict) -> str:
    """花色映射：词性优先，其次情感。
    框架语义：黑桃=负面/抽象 · 红心=情绪/形容词 · 方块=动词/行为 · 梅花=学术/名词。
    """
    s = _pick(entry, "suit").lower()
    if s in ("spades", "hearts", "diamonds", "clubs"):
        return s
    pos = detect_pos(entry)
    if pos.startswith("v"):
        return "diamonds"
    if pos.startswith("adj"):
        return "hearts"
    if pos.startswith("n"):
        return "clubs"
    valence = auto_valence(entry)
    if valence == "positive":
        return "hearts"
    if valence == "negative":
        return "spades"
    return "clubs"


def normalize_word(entry: dict, index: int) -> dict:
    """把一条原始记录归一化为统一的单词卡模型。"""
    word = _pick(entry, "word")
    return {
        "word": word,
        "pos": detect_pos(entry) or "",
        "phonetic": _pick(entry, "phonetic"),
        "meaning_cn": _pick(entry, "meaning_cn"),
        "meaning_en": _pick(entry, "meaning_en"),
        "etymology": _pick(entry, "etymology"),
        "valence": auto_valence(entry),
        "suit": auto_suit(entry),
        "rank": _pick(entry, "rank").upper() if _pick(entry, "rank") else _RANKS[index % 4],
        "example": _pick(entry, "example"),
    }


def normalize_words(raw: list) -> list[dict]:
    """归一化整个词库数组：跳过非法/重复词条，按索引循环分配牌面。"""
    words: list[dict] = []
    seen: set[str] = set()
    i = 0
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        word = _pick(entry, "word")
        if not word:
            continue
        if word.lower() in seen:
            continue
        seen.add(word.lower())
        words.append(normalize_word(entry, i))
        i += 1
    return words
