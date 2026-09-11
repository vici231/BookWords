from __future__ import annotations

import unittest

from backend import periodical_service


class PeriodicalServiceTests(unittest.TestCase):
    def test_local_periodical_aggregation_never_calls_ai(self) -> None:
        articles = [{
            "generatedAt": "2026-09-11T08:00:00+08:00", "weekKey": "2026-09-07",
            "targetWords": ["alpha", "brisk", "alpha"],
            "sorting": {"selected_group": {"theme": "Morning routine", "words": ["alpha", "brisk"]}},
            "story": {"source_type": "hot"},
        }]
        result = periodical_service.aggregate(articles, "week")
        self.assertEqual(result["ai_calls"], 0)
        self.assertEqual(result["groups"][0]["word_count"], 2)
        self.assertEqual(result["groups"][0]["sources"], {"hot": 1})


if __name__ == "__main__":
    unittest.main()
