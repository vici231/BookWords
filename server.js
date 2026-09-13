/* server.js — 刊见单词 Bookwords Node 入口。
   Express 提供前端静态资源 + 全部 /api 路由（契约与 Flask 版一致）。
   运行时只读取 process.env.PORT（交付协议要求），其余配置全部来自设置页。 */

const path = require("path");
const express = require("express");

const settings = require("./lib/settings");
const auth = require("./lib/auth");
const words = require("./lib/words");
const prompts = require("./lib/prompts");
const ai = require("./lib/ai");
const grouping = require("./lib/grouping");
const zhihu = require("./lib/zhihu");
const planner = require("./lib/planner");
const periodical = require("./lib/periodical");
const pipeline = require("./lib/pipeline");
const llm = require("./lib/llm");
const jobs = require("./lib/jobs");
const { trace } = require("./lib/util");

const app = express();
app.use(express.json({ limit: "512kb" }));

/* ---------------- 本机凭证（前端配置，随请求携带） ----------------
   用户在自己浏览器里填 API Key / 知乎 Access Secret，存在 localStorage，
   每次请求通过请求头发来（POST 也接受请求体字段作为兜底）。
   服务端只在本次请求内使用，不落盘、不回显、不写日志：
   仓库和部署包因此都不含任何真实凭证。 */
app.use((req, res, next) => {
  const header = (name) => String(req.get(name) || "").trim();
  const body = req.body && typeof req.body === "object" ? req.body : {};
  settings.runWithCredentials(
    {
      api_key: header("x-ai-key") || String(body.api_key || ""),
      base_url: header("x-ai-base-url") || String(body.api_base_url || ""),
      model: header("x-ai-model") || String(body.api_model || ""),
      access_secret: header("x-zhihu-secret") || String(body.access_secret || ""),
    },
    next
  );
});

const FRONTEND_DIR = path.join(__dirname, "frontend");

/* ---------------- 工具 ---------------- */

function intArg(source, name, defaultValue, lo, hi) {
  const raw = String(source[name] || "").trim();
  if (!raw) return defaultValue;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return defaultValue;
  return Math.max(lo, Math.min(hi, value));
}

function bearerToken(req) {
  const value = req.headers.authorization || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function safeCards(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 80)) {
    if (!item || typeof item !== "object") continue;
    const word = String(item.word || "").trim().slice(0, 64);
    if (!word) continue;
    out.push({
      word,
      pos: String(item.pos || "").trim().slice(0, 24),
      meaning_cn: String(item.meaning_cn || item.meaning || "").trim().slice(0, 120),
      meaning_en: String(item.meaning_en || "").trim().slice(0, 160),
    });
  }
  return out;
}

/* ---------------- 长任务：提交即返回 + 短请求轮询 ----------------
   线上代理层对「几十秒才返回」的请求有固定时长上限（实测裸 HTTP 554），
   函数超时改了也绕不过它。LLM 类接口因此支持异步模式：
     POST <同一路径>  header X-Async: 1 / body.async=true  →  { ok, async:true, job_id }
     POST <同一路径>  body { job: "<id>" }                 →  { ok, job:{ status, result } }
     GET  <同一路径>?job=<id>                              →  同上（兼容写法）
   轮询**默认走 POST**：提交已经证明这条路径可达，不依赖网关是否放通同路径的 GET；
   轮询复用既有路由，部署描述符的 Routes 清单无需改动。 */

function wantsAsync(req) {
  const header = String(req.get("x-async") || "").trim();
  const body = req.body && typeof req.body === "object" ? req.body.async : false;
  return header === "1" || header.toLowerCase() === "true" || body === true;
}

function wantsStream(req) {
  const accept = String(req.get("accept") || "").toLowerCase();
  const body = req.body && typeof req.body === "object" ? req.body.stream : false;
  return accept.includes("text/event-stream") || body === true;
}

/* 单请求内流式返回：立刻发响应头 + 一个注释块，之后每 1.5 秒一个心跳，
   最终结果作为最后一个 event 发出。两个目的：
   1) 线上那层对「长时间没有任何字节返回」的请求会掐（实测裸 HTTP 554），
      持续有字节流动就不会被当成挂死；
   2) 全部工作都在同一个请求内完成，**不依赖任何跨请求的进程内存**
      （线上实测：上一个请求建的 job，下一个请求查不到 → 每请求都是新实例）。
   若平台把流缓冲到结束才转发，正确性不受影响（客户端在结束时照样解析到结果）。 */
async function runStream(res, kind, run) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": open\n\n");
  const started = Date.now();
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now() - started}ms\n\n`);
    } catch (err) { /* 连接已断开，等 runner 结束 */ }
  }, 1500);
  let payload;
  try {
    payload = await run();
  } catch (err) {
    payload = { status: 500, body: { ok: false, error: `服务器内部错误：${err.message}` } };
  }
  clearInterval(heartbeat);
  trace("long_task_stream", { kind, ms: Date.now() - started, status: payload.status });
  try {
    res.write(`event: result\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch (err) { /* 客户端已断开 */ }
  res.end();
}

function jobIdOf(req) {
  const fromBody = req.body && typeof req.body === "object" ? req.body.job : "";
  return String(fromBody || req.query.job || "").trim();
}

function respondJob(req, res, id) {
  if (!id) return res.status(400).json({ ok: false, error: "缺少 job 参数" });
  const job = jobs.get(id);
  if (!job) {
    trace("job_miss", { job: id });
    return res.status(404).json({
      ok: false, job_missing: true,
      error: "任务不存在或已过期（服务实例可能已重启），请重新提交",
    });
  }
  res.json({ ok: true, job });
}

/* 长任务的统一处理器。
   注意：路由必须**字面量**注册（下方 app.post("/api/...")），因为平台的
   路由清单由静态扫描 `app.<method>("<literal>"` 得出，动态注册会让这些接口
   从部署描述符的 Routes 里消失、线上网关不再转发。 */
async function handleLongTask(kind, req, res, runner) {
  const body = req.body || {};
  /* 轮询优先判定：带 job 的 POST 一律是查询，绝不重新建任务 */
  const pollId = jobIdOf(req);
  if (pollId) return respondJob(req, res, pollId);
  /* 默认路径：单请求流式（不依赖跨请求状态） */
  if (wantsStream(req)) return runStream(res, kind, () => runner(body, req));
  if (wantsAsync(req)) {
    const job = jobs.create(kind, () => runner(body, req));
    trace("long_task_submit", { kind, job: job.id });
    return res.json({ ok: true, async: true, job_id: job.id, status: "running" });
  }
  const out = await runner(body, req);
  res.status(out.status).json(out.body);
}

const respondLongTaskStatus = (req, res) => respondJob(req, res, jobIdOf(req));

/* ---------------- 跨域 ----------------
   AI Works 预览是 sandbox iframe（opaque origin）：文档内 <script type="module">
   与静态资源的请求都按跨域处理，必须带 Access-Control-Allow-Origin，否则
   main.js 会被浏览器直接拒绝（页面可见但全站 JS 不执行、无法点击）。 */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Async, X-Job, X-AI-Key, X-AI-Base-URL, X-AI-Model, X-Zhihu-Secret");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

/* ---------------- 静态资源 ---------------- */

app.use(express.static(FRONTEND_DIR, { etag: true, maxAge: 0 }));

/* 改版后禁止浏览器用旧缓存（与 Flask 版 app.py 同款约定）：
   js/css/html 一律 no-cache（etag 协商），避免改版后跑旧代码。 */
app.use((req, res, next) => {
  if (/\.(js|css|html?)$/i.test(req.path) || req.path === "/") {
    res.setHeader("Cache-Control", "no-cache");
  }
  next();
});

/* 显式注册前端静态路由：部署网关按描述符 Routes 清单转发，
   express.static 这类中间件不会被源码路由枚举捕获，必须字面量声明。 */
function sendFrontend(req, res) {
  let rel;
  try {
    rel = decodeURIComponent(req.path);
  } catch (err) {
    return res.status(400).end();
  }
  const target = path.normalize(path.join(FRONTEND_DIR, rel));
  if (target !== FRONTEND_DIR && !target.startsWith(FRONTEND_DIR + path.sep)) {
    return res.status(403).end();
  }
  res.sendFile(target, (err) => {
    if (err && !res.headersSent) res.status(404).sendFile(path.join(FRONTEND_DIR, "index.html"));
  });
}

app.get("/", sendFrontend);
app.get("/index.html", sendFrontend);
app.get("/css/*", sendFrontend);
app.get("/js/*", sendFrontend);
app.get("/assets/*", sendFrontend);
app.get("/pipeline-debug", (req, res) => res.sendFile(path.join(FRONTEND_DIR, "pipeline-debug.html")));

/* ---------------- 基础 API ---------------- */

/* GET /api/health —— 同时充当诊断探针（前端「网络诊断」按钮在用）：
   ?delay=<ms>  服务端先等 0–30000ms 再应答：用来测出线上网关真实的请求时长上限
                （超时会被掐成裸 HTTP 554）。
   ?stream=1    以 SSE 返回，等待期间每 1.5s 一个心跳：用来验证网关是否透传流式。 */
app.get("/api/health", async (req, res) => {
  const delay = Math.max(0, Math.min(30000, Number.parseInt(req.query.delay, 10) || 0));
  const payload = () => ({ status: "ok", app: "刊见单词 Bookwords", delay_ms: delay, ai: ai.aiStatus() });

  if (String(req.query.stream || "") === "1") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": open\n\n");
    const started = Date.now();
    const timer = setInterval(() => {
      try {
        res.write(`: ping ${Date.now() - started}ms\n\n`);
      } catch (err) { /* 连接已断开 */ }
    }, 1500);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    clearInterval(timer);
    try {
      res.write(`event: done\ndata: ${JSON.stringify(payload())}\n\n`);
    } catch (err) { /* 客户端已断开 */ }
    return res.end();
  }

  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  res.json(payload());
});
app.post("/api/health", async (req, res) => res.json(await ai.testAiConfig(req.body)));
app.get("/api/mode", (req, res) => res.json(ai.aiStatus()));
app.get("/api/meta", (req, res) => res.json({
  app: "刊见单词 Bookwords",
  min_cards: { story: prompts.minCards("story") },
  providers: ai.providerCatalog(),
  provider_rules: ai.providerDeterminationRules(),
  wordlist: words.wordlistStatus(), /* 部署诊断：词库目录实况 */
}));

/* ---------------- 词库 API ---------------- */

app.get("/api/words/levels", (req, res) => res.json({ levels: words.listLevels() }));

app.get("/api/words/search", (req, res) => {
  const level = words.normalizeLevelId(req.query.level || "all");
  const limit = intArg(req.query, "limit", 30, 1, 4000); /* 上限放宽：词库页要能浏览整级词表 */
  const q = String(req.query.q || "").trim();
  const pos = String(req.query.pos || "");
  /* 无筛选的全量浏览命中预热快照：零计算直发（平台弱 CPU + 3 秒请求斧） */
  if (!q && !pos && limit >= 4000) {
    const snap = words.browseSnapshot(level);
    if (snap) {
      res.type("application/json").send(snap);
      return;
    }
  }
  const found = words.search(level, q, limit, pos);
  res.json({ words: found, level, total: words.count(level) });
});

app.get("/api/words/random", (req, res) => {
  const level = words.normalizeLevelId(req.query.level || "all");
  const count = intArg(req.query, "count", 12, 1, 50);
  res.json({ words: words.randomWords(level, count), level });
});

app.get("/api/words/daily", (req, res) => {
  const level = words.normalizeLevelId(req.query.level || "all");
  const count = intArg(req.query, "count", 12, 1, 50);
  res.json({ words: words.daily(level, count), level });
});

app.get("/api/words/custom", (req, res) => res.json({ words: words.loadCustomWords() }));

app.delete("/api/words/custom", (req, res) => {
  words.saveCustomWords([]);
  words.rebuildAllAsync(); /* 后台重合并，绝不阻塞请求（3 秒平台超时） */
  res.json({ success: true, words: [] });
});

app.post("/api/words/custom", (req, res) => {
  const body = req.body || {};
  const raw = Array.isArray(body.words) ? body.words : [body];
  const merged = words.mergeCards(raw);
  if (!merged.length) return res.status(400).json({ error: "请填写至少一个有效单词" });
  const saved = words.mergeCards([...words.loadCustomWords(), ...merged]);
  words.saveCustomWords(saved);
  words.syncCustomIntoAll(); /* 增量合并（毫秒级），不清空全池 */
  res.json({ success: true, word: merged[0], words: saved });
});

/* ---------------- AI 配置 API ---------------- */

app.post("/api/models", async (req, res) => res.json(await ai.fetchAiModels(req.body)));

app.get("/api/config", (req, res) => res.json(settings.publicView()));
app.post("/api/config", (req, res) => res.json(settings.save(req.body)));
app.delete("/api/config", (req, res) => res.json(settings.reset()));

/* ---------------- 本地账户 API ---------------- */

app.post("/api/auth/register", (req, res) => {
  const body = req.body || {};
  try {
    const { token, user } = auth.register(body.username, body.password, body.data);
    res.json({ token, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/login", (req, res) => {
  const body = req.body || {};
  try {
    const { token, user } = auth.login(body.username, body.password);
    res.json({ token, user });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get("/api/auth/me", (req, res) => {
  try {
    const item = auth.session(bearerToken(req));
    res.json({ user: auth.publicUser(item.username, item.data) });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.put("/api/auth/data", (req, res) => {
  try {
    const token = bearerToken(req);
    auth.session(token);
    const body = req.body || {};
    const payload = body.data && typeof body.data === "object" ? body.data : {};
    res.json({ user: auth.saveSessionData(token, payload) });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/api/auth/logout", (req, res) => {
  auth.logout(bearerToken(req));
  res.json({ ok: true });
});

/* ---------------- 生成 API ---------------- */

async function runGroupRequest(body) {
  const cards = safeCards(body.cards);
  if (cards.length < prompts.minCards("story")) {
    return { status: 400, body: { ok: false, error: "智能配词至少需要 3 个单词", stage: "grouping" } };
  }
  try {
    const result = await grouping.groupCards(cards, body.source_hint && typeof body.source_hint === "object" ? body.source_hint : null, {
      lockedWords: Array.isArray(body.locked_words) ? body.locked_words : [],
      excludedWords: Array.isArray(body.excluded_words) ? body.excluded_words : [],
      maxGroups: body.max_groups || 3,
      maxWords: body.max_words || 20,
    });
    const { metrics, ...rest } = result;
    return { status: 200, body: { ok: true, request_id: Math.random().toString(16).slice(2, 14), ...rest } };
  } catch (err) {
    return {
      status: 422,
      body: {
        ok: false, error: err.message, stage: "grouping",
        suggestions: [{ action: "adjust_locks", label: "调整必用词" }],
      },
    };
  }
}

app.post("/api/group/words", (req, res) => handleLongTask("grouping", req, res, (body) => runGroupRequest(body)));
app.get("/api/group/words", respondLongTaskStatus);

async function runGenerateRequest(body, mode) {
  if (mode !== "story") return { status: 400, body: { error: "该版本仅支持故事记忆" } };
  const stage = body.stage === "localize" ? "localize" : body.stage === "draft" ? "draft" : "full";

  /* 第二步（翻译）：只吃客户端回传的草稿，不需要重新校验卡牌 —— 服务端不保存中间态 */
  if (stage === "localize") {
    try {
      const localized = await ai.localizeStory(body.draft, { language: body.language === "zh" ? "zh" : "en" });
      return { status: 200, body: localized };
    } catch (err) {
      if (err instanceof ai.GenerationError) {
        return {
          status: err.statusCode,
          body: {
            ok: false, error: err.message, code: err.code, retryable: err.retryable,
            request_id: err.requestId, stage: err.stage, suggestions: err.suggestions,
          },
        };
      }
      console.error("localize failed:", err);
      return { status: 500, body: { error: `服务器内部错误：${err.message}` } };
    }
  }

  const memoryScope = body.memory_scope === "recent_3d" ? "recent_3d" : "pool";
  const cards = safeCards(memoryScope === "recent_3d" ? body.recent_cards : body.cards);
  const need = prompts.minCards(mode);
  if (cards.length < need) return { status: 400, body: { error: `请至少放入 ${need} 张卡牌` } };
  if (cards.length > 80) return { status: 400, body: { error: "待分组词汇最多支持 80 个单词" } };

  const source = body.source || "original";
  let sourcePayload = body.sourcePayload;
  try {
    const resolved = await zhihu.resolveSourcePayload(source, sourcePayload);
    if (resolved.error) {
      return {
        status: 400,
        body: { error: resolved.error, stage: "topic", suggestions: [{ action: "change_topic", label: "更换题材" }] },
      };
    }
    sourcePayload = resolved.payload;
  } catch (err) {
    return {
      status: 400,
      body: { error: err.message, stage: "topic", suggestions: [{ action: "change_topic", label: "更换题材" }] },
    };
  }

  try {
    const result = await ai.generate("story", cards, body.level || "junior", body.params || {}, {
      source,
      sourcePayload,
      language: body.language || "en",
      memoryScope,
      confirmedGroup: body.confirmed_group && typeof body.confirmed_group === "object" ? body.confirmed_group : null,
      lockedWords: Array.isArray(body.locked_words) ? body.locked_words : [],
      excludedWords: Array.isArray(body.excluded_words) ? body.excluded_words : [],
      originalTopic: body.original_topic || "",
      stage,
    });
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof ai.GenerationError) {
      return {
        status: err.statusCode,
        body: {
          ok: false, error: err.message, code: err.code, retryable: err.retryable,
          request_id: err.requestId, stage: err.stage, suggestions: err.suggestions,
        },
      };
    }
    console.error("generate failed:", err);
    return { status: 500, body: { error: `服务器内部错误：${err.message}` } };
  }
}

app.post("/api/generate/:mode", (req, res) => handleLongTask("generate", req, res, (body, req2) => runGenerateRequest(body, req2.params.mode)));
app.get("/api/generate/:mode", respondLongTaskStatus);

app.get("/api/articles/periodical", (req, res) => {
  let articles = [];
  try {
    const item = auth.session(bearerToken(req));
    articles = (item.data && item.data.articles) || [];
  } catch (err) {
    articles = [];
  }
  res.json(periodical.aggregate(articles, req.query.period === "month" ? "month" : "week"));
});

app.post("/api/articles/periodical", (req, res) => {
  const period = req.query.period === "month" ? "month" : "week";
  res.json(periodical.aggregate((req.body || {}).articles, period));
});

app.post("/api/recommend/topics", (req, res) => {
  const body = req.body || {};
  const cards = safeCards(body.cards);
  const need = prompts.minCards("story");
  if (cards.length < need) {
    return res.status(400).json({ error: `请至少放入 ${need} 张卡牌后再推荐题材` });
  }
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 80).filter((c) => c && typeof c === "object") : [];
  res.json(ai.recommendTopics(cards, candidates));
});

async function runCoverageRequest(body) {
  const cards = safeCards(body.cards);
  const days = body.days === 7 ? 7 : 3;
  const stage = typeof body.stage === "string" ? body.stage.toLowerCase() : "";

  /* 分步执行：每一步都是一个短请求（线上单请求上限约 12–15 秒），
     中间产物（queries / candidates / plans）由客户端回传，服务端不保存任何状态。 */
  if (planner.COVERAGE_STAGES.includes(stage)) {
    try {
      return { status: 200, body: await planner.runCoverageStage(stage, { ...body, cards }) };
    } catch (err) {
      if (err.stage === "zhihu_search") {
        return { status: 502, body: { ok: false, error: err.message, stage: "zhihu_search", retryable: true } };
      }
      const code = Number(err.statusCode);
      return {
        status: code >= 400 && code < 500 ? code : 400,
        body: { ok: false, error: err.message, stage: err.stage || "topic_planning" },
      };
    }
  }

  try {
    return { status: 200, body: await planner.buildCoveragePlan(cards, days) };
  } catch (err) {
    if (err.stage === "zhihu_search") {
      return { status: 502, body: { ok: false, error: err.message, stage: "zhihu_search", retryable: true } };
    }
    return { status: 400, body: { ok: false, error: err.message, stage: "topic_planning" } };
  }
}

app.post("/api/topics/zhihu-coverage", (req, res) => handleLongTask("coverage", req, res, (body) => runCoverageRequest(body)));
app.get("/api/topics/zhihu-coverage", respondLongTaskStatus);

/* ---------------- 调试 API ---------------- */

app.post("/api/debug/pipeline", async (req, res) => {
  const body = req.body || {};
  const source = String(body.source || "original");
  let resolved = body.source_payload && typeof body.source_payload === "object" ? body.source_payload : null;
  if (source !== "original") {
    try {
      const result = await zhihu.resolveSourcePayload(source, resolved);
      if (result.error) return res.status(400).json({ ok: false, error: result.error, stage: "zhihu_source" });
      resolved = result.payload;
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message, stage: "zhihu_source" });
    }
  }
  try {
    res.json(await pipeline.runPipeline(body, resolved));
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.get("/api/debug/llm-calls", (req, res) => {
  const limit = intArg(req.query, "limit", 100, 1, 300);
  res.json({ ok: true, calls: llm.recentCalls(limit) });
});

app.delete("/api/debug/llm-calls", (req, res) => {
  llm.clearLogs();
  res.json({ ok: true, calls: [] });
});

app.get("/api/debug/prompt-versions", (req, res) => res.json({ ok: true, versions: prompts.versions() }));

/* ---------------- 知乎开放平台 API ---------------- */

app.get("/api/zhihu/status", (req, res) => res.json(zhihu.status()));

app.get("/api/zhihu/quota", async (req, res) => {
  try {
    res.json({ ok: true, quota: await zhihu.officialQuota() });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.get("/api/zhihu/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  const limit = intArg(req.query, "limit", 10, 1, 10);
  res.json(await zhihu.search(query, limit));
});

app.get("/api/zhihu/hot", async (req, res) => {
  const limit = intArg(req.query, "limit", 30, 1, 30);
  res.json(await zhihu.hotList(limit));
});

app.get("/api/zhihu/stories", async (req, res) => res.json(await zhihu.storyList()));

app.get("/api/zhihu/story", async (req, res) => {
  const workId = String(req.query.id || "").trim();
  if (!workId) return res.status(400).json({ error: "缺少 id 参数" });
  res.json(await zhihu.storyDetail(workId));
});

app.get("/api/zhihu/knowledge", async (req, res) => {
  const workId = String(req.query.id || "").trim();
  if (workId) return res.json(await zhihu.knowledgeDetail(workId));
  res.json(await zhihu.knowledgeList());
});

/* ---------------- 兜底：API 永远回 JSON ---------------- */

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "接口不存在" });
  res.status(404).sendFile(path.join(FRONTEND_DIR, "index.html"));
});

/* eslint-disable-next-line no-unused-vars */
app.use((err, req, res, next) => {
  if (req.path.startsWith("/api/")) {
    const status = err.type === "entity.too.large" ? 413 : 500;
    const message = status === 413 ? "请求内容过大，请减少单词数量或来源文本长度" : `服务器内部错误：${err.message}`;
    return res.status(status).json({ error: message });
  }
  console.error(err);
  res.status(500).send("Internal error");
});

/* ---------------- 启动：PORT 是唯一允许读取的环境变量 ---------------- */

const port = Number.parseInt(process.env.PORT || "9000", 10) || 9000;
app.listen(port, "0.0.0.0", () => {
  trace("server_start", { port });
  console.log(`刊见单词 Bookwords listening on http://0.0.0.0:${port}`);
  words.warmup(); /* 后台预热词库：平台对请求有 3 秒超时，冷启动必须提前热好 */
});
