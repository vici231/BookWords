from __future__ import annotations

import unittest
from unittest.mock import patch

from backend import ai_service


def _valid_article(words: list[str]) -> str:
    highlighted = " ".join(f"**{word}**" for word in words)
    body_words = [highlighted] + ["steady"] * 177
    english = " ".join(body_words[:60]) + ".\n\n" + " ".join(body_words[60:120]) + ".\n\n" + " ".join(body_words[120:]) + "."
    chinese = "这是一篇完整翻译，保留目标词：" + highlighted + "。\n\n第二段解释文章机制。\n\n第三段给出日常启示。"
    return (
        "[TITLE]\nSmall Clues Shape Better Days\n"
        "[GENRE]\ndaily-science\n"
        f"[EN]\n{english}\n"
        f"[ZH]\n{chinese}\n"
        "[TAKEAWAY]\nSmall clues can guide better choices."
    )


def _english_draft(words: list[str]) -> str:
    highlighted = " ".join(f"**{word}**" for word in words)
    body_words = [highlighted] + ["steady"] * 177
    body = " ".join(body_words[:60]) + ".\n\n" + " ".join(body_words[60:120]) + ".\n\n" + " ".join(body_words[120:]) + "."
    return f"**Small Clues Shape Better Days**\n\n{body}"


class AiServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        ai_service._article_cache.clear()
        self.cards = [
            {"word": "alpha", "meaning_cn": "开始"},
            {"word": "brisk", "meaning_cn": "轻快的"},
            {"word": "calm", "meaning_cn": "平静的"},
        ]
        self.status = {
            "api_key": "test-key",
            "base_url": "https://api.example.com/v1",
            "model": "test-model",
        }
        self.sorting = {
            "provider": "external-api",
            "groups": [{"theme": "shared context", "words": ["alpha", "brisk", "calm"], "reason": "coherent", "coherence": .9}],
            "selected_group": {"theme": "shared context", "words": ["alpha", "brisk", "calm"], "reason": "coherent", "coherence": .9},
        }

    def test_validation_failure_does_not_spend_second_generation_call(self) -> None:
        response = {"content": "not structured", "usage": {}, "metrics": {"provider": "DeepSeek", "model": "test-model", "quota": {}}}
        with (
            patch.object(ai_service.settings_store, "effective_api", return_value=self.status),
            patch.object(ai_service.word_grouping, "group_cards", return_value=self.sorting),
            patch.object(ai_service, "_complete_external", return_value=response) as complete,
        ):
            with self.assertRaises(ai_service.GenerationError) as raised:
                ai_service.generate("story", self.cards, params={"length": 220})
        self.assertEqual(complete.call_count, 1)
        self.assertEqual(raised.exception.code, "AI_OUTPUT_INVALID")

    def test_network_failure_does_not_return_placeholder_article(self) -> None:
        with (
            patch.object(ai_service.settings_store, "effective_api", return_value=self.status),
            patch.object(ai_service.word_grouping, "group_cards", return_value=self.sorting),
            patch.object(ai_service, "_complete_external", side_effect=RuntimeError("timeout")) as complete,
        ):
            with self.assertRaises(ai_service.GenerationError) as raised:
                ai_service.generate("story", self.cards, params={"length": 220})
        self.assertEqual(complete.call_count, 1)
        self.assertEqual(raised.exception.code, "AI_UPSTREAM_ERROR")

    def test_only_validated_article_is_cached(self) -> None:
        response = {"content": _valid_article(["alpha", "brisk", "calm"]), "usage": {}, "metrics": {"provider": "知乎直答", "model": "zhida-thinking-1p5", "quota": {}}}
        with (
            patch.object(ai_service.settings_store, "effective_api", return_value=self.status),
            patch.object(ai_service.word_grouping, "group_cards", return_value=self.sorting),
            patch.object(ai_service, "_complete_external", return_value=response) as complete,
        ):
            first = ai_service.generate("story", self.cards, params={"length": 220})
            second = ai_service.generate("story", self.cards, params={"length": 220})
        self.assertEqual(complete.call_count, 1)
        self.assertFalse(first["cache_hit"])
        self.assertTrue(second["cache_hit"])

    def test_language_and_memory_scope_are_returned(self) -> None:
        response = {"content": _valid_article(["alpha", "brisk", "calm"]), "usage": {}, "metrics": {"provider": "DeepSeek", "model": "test-model", "quota": {}}}
        with (
            patch.object(ai_service.settings_store, "effective_api", return_value=self.status),
            patch.object(ai_service.word_grouping, "group_cards", return_value=self.sorting),
            patch.object(ai_service, "_complete_external", return_value=response) as complete,
        ):
            result = ai_service.generate("story", self.cards, params={"length": 220}, language="zh", memory_scope="recent_3d")
        self.assertEqual(complete.call_count, 1)
        self.assertEqual(result["language"]["selected"], "zh")
        self.assertEqual(result["language"]["content"], result["story"]["zh"])
        self.assertEqual(result["memory_scope"], "recent_3d")

    def test_missing_external_api_returns_not_configured(self) -> None:
        with patch.object(ai_service.settings_store, "effective_api", return_value={
            "api_key": "", "base_url": "https://api.example.com/v1", "model": "test-model",
        }):
            with self.assertRaises(ai_service.GenerationError) as raised:
                ai_service.generate("story", self.cards, params={"length": 220})
        self.assertEqual(raised.exception.code, "AI_NOT_CONFIGURED")
        self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
