from __future__ import annotations

import unittest
from unittest.mock import patch

from backend.app import app


class GenerationRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = app.test_client()

    def test_recent_scope_uses_recent_cards_and_language(self) -> None:
        captured = {}

        def fake_generate(mode, cards, level, params, **kwargs):
            captured.update({"mode": mode, "cards": cards, "level": level, "params": params, **kwargs})
            return {"ok": True, "story": {"en": "en", "zh": "zh"}}

        payload = {
            "cards": [{"word": "pool1"}, {"word": "pool2"}, {"word": "pool3"}],
            "recent_cards": [{"word": "recent1"}, {"word": "recent2"}, {"word": "recent3"}],
            "memory_scope": "recent_3d", "language": "zh", "source": "original",
        }
        with patch("backend.app.ai_service.generate", side_effect=fake_generate):
            response = self.client.post("/api/generate/story", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([card["word"] for card in captured["cards"]], ["recent1", "recent2", "recent3"])
        self.assertEqual(captured["memory_scope"], "recent_3d")
        self.assertEqual(captured["language"], "zh")

    def test_periodical_route_is_local(self) -> None:
        response = self.client.post("/api/articles/periodical?period=month", json={"articles": []})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["ai_calls"], 0)


if __name__ == "__main__":
    unittest.main()
