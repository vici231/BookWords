from __future__ import annotations

import unittest
from unittest.mock import patch

from backend import word_grouping


class WordGroupingTests(unittest.TestCase):
    def test_local_fallback_groups_by_shared_context_not_pos(self) -> None:
        cards = [
            {"word": "forest", "pos": "n.", "meaning_cn": "森林环境"},
            {"word": "bloom", "pos": "v.", "meaning_cn": "植物开花"},
            {"word": "wild", "pos": "adj.", "meaning_cn": "自然野生的"},
        ]
        result = word_grouping.local_group(cards)
        self.assertEqual(result["selected_group"]["theme"], "自然与环境")
        self.assertEqual(set(result["selected_group"]["words"]), {"forest", "bloom", "wild"})

    def test_external_failure_uses_local_semantic_fallback(self) -> None:
        cards = [{"word": f"word{i}", "meaning_cn": "学习知识"} for i in range(24)]
        with patch.object(word_grouping.llm_gateway, "complete", side_effect=RuntimeError("offline")):
            result = word_grouping.group_cards(cards)
        self.assertEqual(result["provider"], "local-semantic")
        self.assertLessEqual(len(result["selected_group"]["words"]), 20)
        self.assertEqual(sum(len(group["words"]) for group in result["groups"]), 24)


if __name__ == "__main__":
    unittest.main()
