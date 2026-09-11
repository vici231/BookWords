from __future__ import annotations

import copy
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from backend import zhihu_service
from backend import ai_service


class ZhihuServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        zhihu_service._flights.clear()

    def test_search_filter_requires_supported_type_and_5000_votes(self) -> None:
        accepted = zhihu_service._normalize_search_item({
            "ContentType": "Answer",
            "ContentID": "answer-1",
            "VoteUpCount": 5000,
            "Title": "<em>Qualified</em>",
            "ContentText": "<p>A sufficiently long main paragraph for the material excerpt.</p>",
        })
        rejected = zhihu_service._normalize_search_item({
            "ContentType": "Article",
            "ContentID": "article-1",
            "VoteUpCount": 4999,
            "Title": "Below threshold",
            "ContentText": "A sufficiently long main paragraph for the material excerpt.",
        })
        self.assertEqual(accepted["vote_up_count"], 5000)
        self.assertEqual(accepted["title"], "Qualified")
        self.assertIsNone(rejected)

    def test_identical_concurrent_calls_share_one_upstream_request(self) -> None:
        state = zhihu_service._empty_state()
        state_lock = threading.Lock()
        upstream_calls = 0

        def load_state() -> dict:
            with state_lock:
                return copy.deepcopy(state)

        def save_state(value: dict) -> None:
            with state_lock:
                state.clear()
                state.update(copy.deepcopy(value))

        def request_json(*args, **kwargs):
            nonlocal upstream_calls
            upstream_calls += 1
            time.sleep(0.05)
            return {"Data": {"Items": []}}

        with (
            patch.object(zhihu_service.settings_store, "zhihu_secret", return_value="test-secret"),
            patch.object(zhihu_service, "_load_state_locked", side_effect=load_state),
            patch.object(zhihu_service, "_save_state_locked", side_effect=save_state),
            patch.object(zhihu_service, "_request_json", side_effect=request_json),
        ):
            with ThreadPoolExecutor(max_workers=5) as pool:
                results = list(pool.map(lambda _: zhihu_service._cached_upstream(
                    api_id="zhihu_search", method="GET", url="https://example.invalid",
                    payload={"Query": "same", "Count": 10}, ttl=60,
                ), range(5)))

        self.assertEqual(upstream_calls, 1)
        self.assertEqual(state["used"], 1)
        self.assertTrue(all(result[0] == {"Data": {"Items": []}} for result in results))

    def test_daily_limit_blocks_upstream(self) -> None:
        state = zhihu_service._empty_state()
        state["generation_used"] = zhihu_service.GENERATION_DAILY_CALL_LIMIT
        with (
            patch.object(zhihu_service.settings_store, "zhihu_secret", return_value="test-secret"),
            patch.object(zhihu_service, "_load_state_locked", return_value=state),
            patch.object(zhihu_service, "_save_state_locked"),
            patch.object(zhihu_service, "_request_json") as request_json,
        ):
            with self.assertRaises(zhihu_service.ZhihuError):
                zhihu_service._cached_upstream(
                    api_id="zhida_openai", method="POST", url="https://example.invalid",
                    payload={"model": "zhida-thinking-1p5"}, ttl=60, budget="generation",
                )
        request_json.assert_not_called()

    def test_direct_answer_sends_only_documented_fields(self) -> None:
        captured = {}

        def cached_upstream(**kwargs):
            captured.update(kwargs)
            return ({
                "model": "zhida-thinking-1p5",
                "choices": [{"message": {"role": "assistant", "content": "{}"}}],
            }, {"cache_hit": False})

        with patch.object(zhihu_service, "_cached_upstream", side_effect=cached_upstream):
            zhihu_service.zhida_complete([{"role": "user", "content": "hello"}])
        self.assertEqual(set(captured["payload"]), {"model", "messages", "stream"})
        self.assertFalse(captured["payload"]["stream"])

    def test_article_text_parser_accepts_delimited_output(self) -> None:
        payload = ai_service._parse_article_text(
            "[TITLE]\nSmall Clues, Big Changes\n[GENRE]\ndaily-science\n"
            "[EN]\nA **quiet** change can reshape a day. It starts small.\n"
            "[ZH]\n一个**quiet**（安静的）变化可以改变一天。它从小处开始。\n"
            "[TAKEAWAY]\nSmall changes can matter."
        )
        self.assertEqual(payload["title"], "Small Clues, Big Changes")
        self.assertEqual(payload["genre"], "daily-science")
        self.assertIn("**quiet**", payload["zh"])

    def test_article_text_parser_rejects_json_only_output(self) -> None:
        with self.assertRaises(ValueError):
            ai_service._parse_article_text('{"title":"x"}')


if __name__ == "__main__":
    unittest.main()
