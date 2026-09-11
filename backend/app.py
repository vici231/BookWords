"""app.py — Flask 入口：路由 + 静态服务。

运行（项目根目录下）：
    python backend/app.py

然后浏览器打开 http://127.0.0.1:5000
（需在系统设置中配置 API Key；未配置 Key 时生成接口直接返回「无 Key」，不走 Mock。）

接口一览：
    GET  /                     前端页面（静态托管 frontend/）
    GET  /api/health           健康检查（POST：用候选配置做连通性测试，只测不存）
    GET  /api/mode             前端据此显示「AI 已连接 / 无 Key」
    GET  /api/meta             前端单一事实来源：最少卡牌数 / 供应商目录 / 识别规则
    GET  /api/words/levels     列出可用难度分级
    GET  /api/words/search     在指定或全部词库内搜索关键词与词性
    GET  /api/words/random     随机抽取一组词
    GET  /api/words/daily      每日记忆：按日期确定性抽一组
    *    /api/words/custom     读取 / 添加 / 清空本地自设单词
    POST /api/models           用候选配置查询该 Key 可用的模型列表
    *    /api/config           读取（脱敏）/ 保存 / 清除系统设置
    *    /api/auth/*           本地账户：注册 / 登录 / 会话 / 数据 / 登出
    POST /api/generate/story   收 >= 3 张卡 → 故事记忆材料
    GET  /api/zhihu/*          知乎热榜 / 故事 / 知识（黑客松能力）
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

try:
    from backend import ai_service, auth_store, llm_gateway, periodical_service, pipeline_service, prompt_templates, settings_store, word_catalog, zhihu_service
    from backend.zhihu_adapter import adapter as zhihu_adapter
except ImportError:  # `python backend/app.py` 直接运行时
    import ai_service  # type: ignore
    import auth_store  # type: ignore
    import llm_gateway  # type: ignore
    import periodical_service  # type: ignore
    import pipeline_service  # type: ignore
    import prompt_templates  # type: ignore
    import settings_store  # type: ignore
    import word_catalog  # type: ignore
    import zhihu_service  # type: ignore
    from zhihu_adapter import adapter as zhihu_adapter  # type: ignore

logger = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
# 开发期关闭静态资源缓存，避免前端改后浏览器仍加载旧文件
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
# 限制 JSON 请求体，避免把超大来源文本或恶意 payload 送入模型。
app.config["MAX_CONTENT_LENGTH"] = 512 * 1024


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------

def _int_arg(name: str, default: int, lo: int, hi: int) -> int:
    """安全解析查询参数为整数并夹取到 [lo, hi]；非法值回退默认（不 500）。"""
    raw = (request.args.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("查询参数 %s=%r 不是整数，使用默认值 %s", name, raw, default)
        return default
    return max(lo, min(hi, value))


def _json_body() -> dict:
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else {}


def _bearer_token() -> str:
    value = request.headers.get("Authorization", "")
    return value[7:].strip() if value.lower().startswith("bearer ") else ""


def _safe_cards(raw: object) -> list[dict]:
    """只保留生成所需的短字段，避免提示词注入和超大字段污染模型上下文。"""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw[:80]:
        if not isinstance(item, dict):
            continue
        word = str(item.get("word") or "").strip()[:64]
        if not word:
            continue
        out.append({
            "word": word,
            "pos": str(item.get("pos") or "").strip()[:24],
            "meaning_cn": str(item.get("meaning_cn") or item.get("meaning") or "").strip()[:120],
            "meaning_en": str(item.get("meaning_en") or "").strip()[:160],
        })
    return out


# ---------------------------------------------------------------------------
# 页面与静态资源
# ---------------------------------------------------------------------------

@app.after_request
def no_static_cache(resp):
    """开发期禁用静态资源缓存：避免改版后浏览器继续用旧 JS/CSS。"""
    if not resp.headers.get("Cache-Control") and (request.path == "/" or request.path.startswith(("/js/", "/css/", "/assets/"))):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/pipeline-debug")
def pipeline_debug():
    """Temporary, isolated observer for the API word-to-publication pipeline."""
    return send_from_directory(FRONTEND_DIR, "pipeline-debug.html")


# ---------------------------------------------------------------------------
# 基础 API
# ---------------------------------------------------------------------------

@app.route("/api/health", methods=["GET", "POST"])
def health():
    """GET：当前状态；POST：用候选配置做连通性测试（只测不存）。"""
    if request.method == "POST":
        return jsonify(ai_service.test_ai_config(_json_body()))
    return jsonify({"status": "ok", "app": "刊见单词 Bookwords", "ai": ai_service.ai_status()})


@app.route("/api/mode")
def mode():
    """前端据此显示「AI 已连接 / 无 Key」。"""
    return jsonify(ai_service.ai_status())


@app.route("/api/meta")
def meta():
    """前端单一事实来源：应用名 / 最少卡牌数 / 供应商目录 / 供应商识别规则。

    避免前后端各维护一份供应商表与常量导致漂移。
    """
    return jsonify({
        "app": "刊见单词 Bookwords",
        "min_cards": {"story": prompt_templates.min_cards("story")},
        "providers": ai_service.provider_catalog(),
        "provider_rules": ai_service.provider_determination_rules(),
    })


# ---------------------------------------------------------------------------
# 词库 API
# ---------------------------------------------------------------------------

@app.route("/api/words/levels")
def word_levels():
    """列出可用难度分级。"""
    return jsonify({"levels": word_catalog.list_levels()})


@app.route("/api/words/search")
def word_search():
    """在指定或全部词库内搜索关键词与词性。"""
    q = request.args.get("q", "")
    level = word_catalog.normalize_level_id(request.args.get("level", "all"))
    pos = request.args.get("pos", "")
    limit = _int_arg("limit", 30, 1, 100)
    words = word_catalog.search(level, q, limit, pos)
    return jsonify({"words": words, "level": level, "total": word_catalog.count(level)})


@app.route("/api/words/random")
def word_random():
    """随机抽取一组词。"""
    level = word_catalog.normalize_level_id(request.args.get("level", "all"))
    count = _int_arg("count", 12, 1, 50)
    return jsonify({"words": word_catalog.random_words(level, count), "level": level})


@app.route("/api/words/daily")
def word_daily():
    """每日记忆：按日期确定性抽一组。"""
    level = word_catalog.normalize_level_id(request.args.get("level", "all"))
    count = _int_arg("count", 12, 1, 50)
    return jsonify({"words": word_catalog.daily(level, count), "level": level})


@app.route("/api/words/custom", methods=["GET", "POST", "DELETE"])
def custom_words():
    """读取、添加或清空本地自设单词。"""
    if request.method == "GET":
        return jsonify({"words": word_catalog.load_custom_words()})
    if request.method == "DELETE":
        word_catalog.save_custom_words([])
        word_catalog.invalidate_all_cache()
        return jsonify({"success": True, "words": []})

    body = _json_body()
    raw = body.get("words") if isinstance(body.get("words"), list) else [body]
    words = word_catalog.merge_cards(raw)  # 归一化在 save 前由前端/词卡结构保证
    if not words:
        return jsonify({"error": "请填写至少一个有效单词"}), 400
    saved = word_catalog.merge_cards(word_catalog.load_custom_words() + words)
    word_catalog.save_custom_words(saved)
    word_catalog.invalidate_all_cache()
    return jsonify({"success": True, "word": words[0], "words": saved})


# ---------------------------------------------------------------------------
# AI 配置 API
# ---------------------------------------------------------------------------

@app.route("/api/models", methods=["POST"])
def models():
    """用候选配置查询该 API Key 当前可用的模型列表（只查询不落盘）。"""
    return jsonify(ai_service.fetch_ai_models(_json_body()))


@app.route("/api/config", methods=["GET", "POST", "DELETE"])
def config():
    if request.method == "DELETE":
        return jsonify(settings_store.reset())
    if request.method == "POST":
        return jsonify(settings_store.save(_json_body()))
    return jsonify(settings_store.public())


# ---------------------------------------------------------------------------
# 本地账户 API
# ---------------------------------------------------------------------------

@app.route("/api/auth/register", methods=["POST"])
def auth_register():
    body = _json_body()
    try:
        token, user = auth_store.register(body.get("username"), body.get("password"), body.get("data"))
        return jsonify({"token": token, "user": user})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    body = _json_body()
    try:
        token, user = auth_store.login(body.get("username"), body.get("password"))
        return jsonify({"token": token, "user": user})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 401


@app.route("/api/auth/me")
def auth_me():
    try:
        item = auth_store.session(_bearer_token())
        return jsonify({"user": auth_store.public_user(item["username"], item["data"])})
    except PermissionError as exc:
        return jsonify({"error": str(exc)}), 401


@app.route("/api/auth/data", methods=["PUT"])
def auth_data():
    try:
        token = _bearer_token()
        auth_store.session(token)
        body = _json_body()
        payload = body.get("data") if isinstance(body.get("data"), dict) else {}
        user = auth_store.save_session_data(token, payload)
        return jsonify({"user": user})
    except PermissionError as exc:
        return jsonify({"error": str(exc)}), 401


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    auth_store.logout(_bearer_token())
    return jsonify({"success": True})


# ---------------------------------------------------------------------------
# 生成 API
# ---------------------------------------------------------------------------

@app.route("/api/generate/<mode>", methods=["POST"])
def generate(mode):
    if mode != "story":
        return jsonify({"error": "该版本仅支持故事记忆"}), 400
    body = _json_body()
    # 只保留短字段，防止用户输入将无关指令注入提示词。
    memory_scope = "recent_3d" if body.get("memory_scope") == "recent_3d" else "pool"
    cards = _safe_cards(body.get("recent_cards") if memory_scope == "recent_3d" else body.get("cards"))
    need = prompt_templates.min_cards(mode)
    if len(cards) < need:
        return jsonify({"error": f"请至少放入 {need} 张卡牌"}), 400
    if len(cards) > 80:
        return jsonify({"error": "待分组词汇最多支持 80 个单词"}), 400
    level = body.get("level") or "junior"  # junior / senior / cet，控制其余词汇难度
    params = body.get("params") or {}      # density/richness/reasoning/abstraction，各 1-10
    source = body.get("source") or "original"
    source_payload = body.get("sourcePayload")
    # 解析并校验选题来源（知乎热榜/故事/知识）
    source_payload, src_error = zhihu_adapter.resolve(source, source_payload)
    if src_error:
        return jsonify({"error": src_error}), 400
    try:
        return jsonify(ai_service.generate(
            mode, cards, level, params, source=source, source_payload=source_payload,
            language=body.get("language") or "en", memory_scope=memory_scope,
        ))
    except ai_service.GenerationError as exc:
        return jsonify({
            "ok": False,
            "error": str(exc),
            "code": exc.code,
            "retryable": exc.retryable,
            "request_id": exc.request_id,
        }), exc.status_code


@app.route("/api/articles/periodical", methods=["GET", "POST"])
def article_periodical():
    """Aggregate client-supplied local article snapshots without any model call."""
    period = "month" if request.args.get("period") == "month" else "week"
    if request.method == "POST":
        articles = _json_body().get("articles")
    else:
        try:
            articles = auth_store.session(_bearer_token()).get("data", {}).get("articles", [])
        except PermissionError:
            articles = []
    return jsonify(periodical_service.aggregate(articles, period))


@app.route("/api/recommend/topics", methods=["POST"])
def recommend_topics():
    """根据词汇池先做智能选题；候选仅作为数据，不直接进入文章生成。"""
    body = _json_body()
    cards = _safe_cards(body.get("cards"))
    if len(cards) < prompt_templates.min_cards("story"):
        return jsonify({"error": f"请至少放入 {prompt_templates.min_cards('story')} 张卡牌后再推荐题材"}), 400
    candidates = body.get("candidates") if isinstance(body.get("candidates"), list) else []
    candidates = [item for item in candidates[:80] if isinstance(item, dict)]
    return jsonify(ai_service.recommend_topics(cards, candidates))


# ---------------------------------------------------------------------------
# Temporary observable pipeline (isolated from the main product workflow)
# ---------------------------------------------------------------------------

@app.route("/api/debug/pipeline", methods=["POST"])
def debug_pipeline():
    body = _json_body()
    source = str(body.get("source") or "original")
    source_payload = body.get("source_payload") if isinstance(body.get("source_payload"), dict) else None
    resolved = source_payload
    if source != "original":
        resolved, source_error = zhihu_adapter.resolve(source, source_payload)
        if source_error:
            return jsonify({"ok": False, "error": source_error, "stage": "zhihu_source"}), 400
    return jsonify(pipeline_service.run_pipeline(body, resolved))


@app.route("/api/debug/llm-calls", methods=["GET", "DELETE"])
def debug_llm_calls():
    if request.method == "DELETE":
        llm_gateway.clear_logs()
        return jsonify({"ok": True, "calls": []})
    limit = _int_arg("limit", 100, 1, 300)
    return jsonify({"ok": True, "calls": llm_gateway.recent_calls(limit)})


@app.route("/api/debug/prompt-versions")
def debug_prompt_versions():
    return jsonify({"ok": True, "versions": prompt_templates.versions()})


# ---------------------------------------------------------------------------
# 知乎开放平台（黑客松能力）：热榜需 Access Secret；故事/知识内容无需鉴权
# ---------------------------------------------------------------------------

@app.route("/api/zhihu/status")
def zhihu_status():
    return jsonify(zhihu_adapter.status())


@app.route("/api/zhihu/quota")
def zhihu_quota():
    try:
        return jsonify({"ok": True, "quota": zhihu_service.official_quota()})
    except zhihu_service.ZhihuError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502


@app.route("/api/zhihu/search")
def zhihu_search():
    query = str(request.args.get("q") or "").strip()
    limit = _int_arg("limit", 10, 1, 10)
    return jsonify(zhihu_adapter.search(query, limit))


@app.route("/api/zhihu/hot")
def zhihu_hot():
    limit = _int_arg("limit", 30, 1, 30)
    return jsonify(zhihu_adapter.list_topics("hot", limit))


@app.route("/api/zhihu/stories")
def zhihu_stories():
    return jsonify(zhihu_adapter.list_topics("story"))


@app.route("/api/zhihu/story")
def zhihu_story():
    work_id = (request.args.get("id") or "").strip()
    if not work_id:
        return jsonify({"error": "缺少 id 参数"}), 400
    return jsonify(zhihu_adapter.detail("story", work_id))


@app.route("/api/zhihu/knowledge")
def zhihu_knowledge():
    work_id = (request.args.get("id") or "").strip()
    if work_id:
        return jsonify(zhihu_adapter.detail("knowledge", work_id))
    return jsonify(zhihu_adapter.list_topics("knowledge"))


# ---------------------------------------------------------------------------
# 错误兜底（API 永远回 JSON，前端不白屏）
# ---------------------------------------------------------------------------

@app.errorhandler(404)
def not_found(err):
    if request.path.startswith("/api/"):
        return jsonify({"error": "接口不存在"}), 404
    return err


@app.errorhandler(Exception)
def on_error(err):
    if request.path.startswith("/api/"):
        logger.exception("API 内部错误：%s %s", request.method, request.path)
        return jsonify({"error": f"服务器内部错误：{err}"}), 500
    raise err


@app.errorhandler(413)
def request_too_large(err):
    if request.path.startswith("/api/"):
        return jsonify({"error": "请求内容过大，请减少单词数量或来源文本长度"}), 413
    return "Request too large", 413


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # Debug 模式默认关闭，仅通过 FLASK_DEBUG 环境变量开启
    app.run(host="127.0.0.1", port=5000, debug=os.environ.get("FLASK_DEBUG", "").lower() in ("1", "true", "yes"))
