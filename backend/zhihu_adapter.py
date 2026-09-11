"""知乎素材适配层。

将应用内部的内容来源统一成一个稳定接口，当前默认复用 zhihu_service 的 HTTP 实现，
未来可无缝替换为 zhihu-cli-skill 的 CLI 调用，不让前端或生成器感知供应商差异。
"""
from __future__ import annotations
from typing import Any
try:
    from . import zhihu_service
except ImportError:  # `python backend/app.py` 直接运行时
    import zhihu_service  # type: ignore

class ZhihuSourceAdapter:
    """为文章生成提供知乎选题和正文素材。"""
    def status(self) -> dict[str, Any]:
        return zhihu_service.status()

    def list_topics(self, kind: str, limit: int = 30) -> dict[str, Any]:
        if kind == "search":
            raise ValueError("search requires a query")
        if kind == "hot":
            return zhihu_service.hot_list(limit)
        if kind == "story":
            return zhihu_service.story_list()
        if kind == "knowledge":
            return zhihu_service.knowledge_list()
        raise ValueError(f"unsupported zhihu source: {kind}")

    def search(self, query: str, limit: int = 10, preference_context: dict | None = None) -> dict[str, Any]:
        return zhihu_service.search(query, limit, preference_context)

    def resolve(self, source: str, payload: dict[str, Any] | None):
        return zhihu_service.resolve_source_payload(source, payload)

    def detail(self, kind: str, work_id: str) -> dict[str, Any]:
        if kind == "story":
            return zhihu_service.story_detail(work_id)
        if kind == "knowledge":
            return zhihu_service.knowledge_detail(work_id)
        raise ValueError(f"unsupported zhihu detail: {kind}")

adapter = ZhihuSourceAdapter()
