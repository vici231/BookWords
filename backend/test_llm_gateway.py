from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from backend import llm_gateway


class LlmGatewayTests(unittest.TestCase):
    @patch.object(llm_gateway.requests, "post")
    def test_openai_compatible_request_uses_saved_config(self, post: Mock) -> None:
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "model": "deepseek-chat",
            "choices": [{"message": {"content": "OK"}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
        }
        post.return_value = response

        result = llm_gateway.complete(
            skill_name="test", prompt_version="v1",
            messages=[{"role": "user", "content": "hello"}],
            config={
                "base_url": "https://api.deepseek.com",
                "api_key": "secret-key",
                "model": "deepseek-chat",
                "provider_name": "DeepSeek",
            },
            temperature=0.2,
        )

        self.assertEqual(result["content"], "OK")
        args, kwargs = post.call_args
        self.assertEqual(args[0], "https://api.deepseek.com/chat/completions")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer secret-key")
        self.assertEqual(kwargs["json"]["model"], "deepseek-chat")
        self.assertFalse(kwargs["json"]["stream"])
        self.assertEqual(result["metrics"]["provider"], "DeepSeek")


if __name__ == "__main__":
    unittest.main()
