"""prompt_templates.py — 运行时从 prompts/*.txt 读取提示词，拼装 system/user 消息。

设计原则：
- prompts/base_system_prompt.txt 与 prompts/story_prompt.txt 是运行时提示词的「唯一事实来源」（single source of truth），
  本模块只负责读取、清理格式外壳、按 mode 拼装，保证文档与调用一致；
- master_prompt.txt 仅作维护总纲，不参与运行时拼接；
- 结构校验（最少卡牌数）也在本模块集中定义，路由层复用。
"""

from __future__ import annotations

import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROMPTS_DIR = PROJECT_ROOT / "prompts"

_BASE_FILE = "base_system_prompt.txt"
_MODE_FILES = {
    "story": "story_prompt.txt",
}
PROMPT_VERSIONS = {
    "story": "story.v1.6.0-context-groups",
    "topic_recommend": "topic-recommend.v1.1.0-zhida",
    "word_sort": "word-sort.v2.0.0-article-coherence",
    "pipeline_story": "pipeline-story.v1.2.0-zhida",
    "periodical_digest": "periodical-digest.v1.1.0-zhida",
    "connection_test": "connection-test.v1.0.0",
}
_MIN_CARDS = {"story": 3}
_FENCE_MARKERS = ("```", "~~~")

_cache: dict[str, str] = {}


def _clean(text: str) -> str:
    """去掉 Markdown 围栏与 [System] 这类外壳标记，返回可直接使用的提示词文本。"""
    lines: list[str] = []
    in_fence = False
    for raw in text.splitlines():
        stripped = raw.strip()
        if any(stripped.startswith(marker) for marker in _FENCE_MARKERS):
            in_fence = not in_fence
            continue
        # 去掉独立的章节标签行（如 [System]、[User]），围栏内内容不动
        if not in_fence and stripped.startswith("[") and stripped.endswith("]") and len(stripped) < 40:
            continue
        lines.append(raw)
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines).strip()


def _load_prompt(filename: str) -> str:
    if filename not in _cache:
        path = PROMPTS_DIR / filename
        if not path.is_file():
            raise FileNotFoundError(f"提示词文件缺失: {path}")
        _cache[filename] = _clean(path.read_text(encoding="utf-8"))
    return _cache[filename]


def get_base_prompt() -> str:
    """记忆教练人格（所有模式共享）。"""
    return _load_prompt(_BASE_FILE)


def get_mode_prompt(mode: str) -> str:
    """故事专项规则。"""
    if mode not in _MODE_FILES:
        raise ValueError(f"未知模式: {mode}（仅支持 story）")
    return _load_prompt(_MODE_FILES[mode])


def build_system_message(mode: str) -> str:
    """base 人格 + 模式规则拼接为 System 消息。"""
    return f"{get_base_prompt()}\n\n{get_mode_prompt(mode)}"


def build_user_message(mode: str, cards: list[dict], level: str = "junior", params: dict | None = None,
                       source: str = "original", source_payload: dict | None = None) -> str:
    """把用户拖入的单词卡 JSON 注入 User 消息（含难度档位 + 生成调参 + 选题来源）。

    仅当 source 非 original 时注入 source / sourcePayload，供提示词决定如何改编。
    """
    msg = {"mode": mode, "level": level, "params": params or {}, "cards": cards}
    if source and source != "original":
        msg["source"] = source
        if isinstance(source_payload, dict):
            msg["sourcePayload"] = source_payload
    return json.dumps(msg, ensure_ascii=False)


def get_messages(mode: str, cards: list[dict], level: str = "junior", params: dict | None = None,
                 source: str = "original", source_payload: dict | None = None) -> list[dict]:
    """构造 OpenAI 兼容接口所需的完整消息数组。"""
    return [
        {"role": "system", "content": build_system_message(mode)},
        {"role": "user", "content": build_user_message(mode, cards, level, params, source, source_payload)},
    ]


def min_cards(mode: str) -> int:
    """故事模式所需的最少卡牌数。"""
    return _MIN_CARDS[mode]


def version(skill_name: str) -> str:
    """Return the explicit prompt version recorded with every LLM call."""
    return PROMPT_VERSIONS.get(skill_name, "unversioned")


def versions() -> dict[str, str]:
    return dict(PROMPT_VERSIONS)
