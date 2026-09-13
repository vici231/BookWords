/* zhihu.js — 知乎官方 API 网关：搜索 / 热榜 / 故事 / 知识 / 直答。
   含持久缓存、按日预算与请求合并（同 key in-flight 复用）。 */

const crypto = require("crypto");
const settings = require("./settings");
const { trace } = require("./util");

const DEVELOPER_BASE = "https://developer.zhihu.com";
const SEARCH_URL = `${DEVELOPER_BASE}/api/v1/content/zhihu_search`;
const ZHIDA_URL = `${DEVELOPER_BASE}/v1/chat/completions`;
const QUOTA_URL = `${DEVELOPER_BASE}/api/v1/quota`;
const DAILY_CALL_LIMIT = 10;
const GENERATION_DAILY_CALL_LIMIT = 30;
const CONTENT_DAILY_CALL_LIMITS = { zhihu_search: 5000, hot_list: 100 };
const MIN_VOTE_UPS = 5000;
const SEARCH_CACHE_TTL = 24 * 60 * 60 * 1000;
const STALE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 160;
/* 知乎调用状态 = 缓存 + 当日预算计数：进程内存（平台只读文件系统，重启重置）。 */
let stateStore = null;
const ALLOWED_MODELS = new Set(["zhida-fast-1p5", "zhida-thinking-1p5", "zhida-agent"]);
const ARTICLE_TYPES = new Set(["answer", "article"]);

const flights = new Map(); // key -> Promise<result>

class ZhihuError extends Error {}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function emptyState() {
  return { date: todayIso(), used: 0, generation_used: 0, calls_by_api: {}, cache: {} };
}

function loadState() {
  if (!stateStore || typeof stateStore !== "object") stateStore = emptyState();
  const s = stateStore;
  if (!s.cache || typeof s.cache !== "object") s.cache = {};
  if (typeof s.generation_used !== "number") s.generation_used = 0;
  if (s.date !== todayIso()) {
    s.date = todayIso();
    s.used = 0;
    s.generation_used = 0;
    s.calls_by_api = {};
  }
  s.used = Math.max(0, Number(s.used) || 0);
  s.generation_used = Math.max(0, Number(s.generation_used) || 0);
  if (!s.calls_by_api || typeof s.calls_by_api !== "object") s.calls_by_api = {};
  return s;
}

function saveState(state) {
  stateStore = state; /* 内存态：无可持久化失败路径 */
}

function stateSummary() {
  const state = loadState();
  return {
    date: state.date,
    used: state.used,
    limit: DAILY_CALL_LIMIT,
    remaining: Math.max(0, DAILY_CALL_LIMIT - state.used),
    generation_used: state.generation_used,
    generation_limit: GENERATION_DAILY_CALL_LIMIT,
    generation_remaining: Math.max(0, GENERATION_DAILY_CALL_LIMIT - state.generation_used),
    calls_by_api: { ...state.calls_by_api },
    content_limits: { ...CONTENT_DAILY_CALL_LIMITS },
  };
}

function status() {
  const secret = settings.zhihuSecret();
  const quota = stateSummary();
  return {
    ok: true,
    available: Boolean(secret) && quota.generation_remaining > 0,
    has_secret: Boolean(secret),
    model: "zhida-thinking-1p5",
    min_vote_ups: 0, /* 已放开：任意赞数的知乎文章/回答都可以作为选材 */
    quota,
    message: secret
      ? `知乎官方接口已配置，今日生成预算剩余 ${quota.generation_remaining}/${quota.generation_limit} 次`
      : "未配置知乎 Access Secret，请在设置中填写后再使用知乎搜索与直答",
  };
}

function headers(secret) {
  return {
    Authorization: `Bearer ${secret}`,
    "X-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
    "Content-Type": "application/json",
  };
}

function cacheKey(apiId, method, url, payload) {
  const stable = { api: apiId, method, url, payload: payload || {} };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function envelope(data) {
  if (!data || typeof data !== "object") return data;
  const code = data.Code !== undefined ? data.Code : data.code;
  if (code !== undefined && code !== null && code !== 0 && code !== "0") {
    const message = String(data.Message || data.message || `知乎接口错误（Code=${code}）`);
    if (String(code) === "20001") throw new ZhihuError("知乎 Access Secret 无效或已过期");
    if (String(code) === "30001") throw new ZhihuError("知乎官方接口额度已耗尽或请求过于频繁");
    throw new ZhihuError(message);
  }
  return data.Data !== undefined ? data.Data : data.data;
}

async function requestJson(method, url, secret, payload, timeoutMs) {
  const options = { headers: headers(secret), signal: AbortSignal.timeout(timeoutMs) };
  if (method === "GET") {
    const qs = new URLSearchParams(payload).toString();
    return (await fetch(qs ? `${url}?${qs}` : url, options)).json();
  }
  options.method = "POST";
  options.body = JSON.stringify(payload);
  return (await fetch(url, options)).json();
}

async function cachedUpstream({ apiId, method, url, payload, ttl, timeoutMs = 53000, budget = "shared", useCache = true }) {
  const secret = settings.zhihuSecret();
  if (!secret) throw new ZhihuError("未配置知乎 Access Secret");
  const key = cacheKey(apiId, method, url, payload);
  const now = Date.now();
  const state0 = loadState();
  let cached = state0.cache[key];
  if (useCache && ttl > 0 && cached && typeof cached === "object" && Number(cached.expires_at || 0) > now) {
    return { value: cached.value, meta: { cache_hit: true, stale: false, api_id: apiId } };
  }
  if (flights.has(key)) {
    const { value, meta } = await flights.get(key);
    return { value, meta: { ...meta, cache_hit: true, coalesced: true } };
  }

  const exec = (async () => {
    let state = loadState();
    cached = state.cache[key];
    let used;
    let limit;
    if (budget === "generation") {
      used = state.generation_used;
      limit = GENERATION_DAILY_CALL_LIMIT;
    } else {
      used = Number(state.calls_by_api[apiId]) || 0;
      limit = CONTENT_DAILY_CALL_LIMITS[apiId] !== undefined ? CONTENT_DAILY_CALL_LIMITS[apiId] : DAILY_CALL_LIMIT;
    }
    if (used >= limit) {
      if (useCache && cached && typeof cached === "object" && Number(cached.created_at || 0) + STALE_CACHE_TTL > now) {
        return { value: cached.value, meta: { cache_hit: true, stale: true, api_id: apiId } };
      }
      throw new ZhihuError(`知乎接口今日已达到本地上限 ${limit} 次，请明日再试`);
    }
    if (budget === "generation") state.generation_used += 1;
    else state.used += 1;
    state.calls_by_api[apiId] = (Number(state.calls_by_api[apiId]) || 0) + 1;
    saveState(state);

    const started = Date.now();
    let data;
    try {
      data = await requestJson(method, url, secret, payload, timeoutMs);
    } catch (err) {
      throw new ZhihuError(`知乎接口请求失败：${err.message}`);
    }
    state = loadState();
    if (useCache && ttl > 0) {
      state.cache[key] = { api_id: apiId, created_at: now, expires_at: now + ttl, value: data };
      const keys = Object.keys(state.cache);
      if (keys.length > MAX_CACHE_ENTRIES) {
        keys
          .sort((a, b) => Number(state.cache[a].created_at || 0) - Number(state.cache[b].created_at || 0))
          .slice(0, keys.length - MAX_CACHE_ENTRIES)
          .forEach((old) => delete state.cache[old]);
      }
      saveState(state);
    }
    return { value: data, meta: { cache_hit: false, stale: false, api_id: apiId, elapsed_ms: Date.now() - started } };
  })();

  flights.set(key, exec);
  try {
    return await exec;
  } finally {
    flights.delete(key);
  }
}

function asItems(data) {
  const value = envelope(data);
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const key of ["Items", "items", "Data", "data"]) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return [];
}

function plainText(value, limit = 1500) {
  let text = String(value || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  text = text.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  const lines = text.split("\n").map((line) => line.replace(/[ \t\f\v]+/g, " ").trim());
  const paragraphs = lines.filter((line) => line.length >= 12);
  const clean = paragraphs.length ? paragraphs.join("\n\n") : text.replace(/[ \t\f\v]+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const clipped = clean.slice(0, limit);
  const boundary = Math.max(clipped.lastIndexOf("。"), clipped.lastIndexOf("！"), clipped.lastIndexOf("？"), clipped.lastIndexOf("."));
  return boundary >= limit / 2 ? clipped.slice(0, boundary + 1).trim() : `${clipped.trimEnd()}…`;
}

function normalizeSearchItem(raw, { minVotes = 0 } = {}) {
  const contentType = String(raw.ContentType || raw.content_type || "").trim();
  const votes = Number(raw.VoteUpCount || raw.vote_up_count || 0) || 0;
  if (!ARTICLE_TYPES.has(contentType.toLowerCase()) || votes < Math.max(0, Number(minVotes) || 0)) return null;
  const excerpt = plainText(raw.ContentText || raw.content_text || raw.Summary, 1500);
  if (!excerpt) return null;
  return {
    source: "zhihu_search",
    content_id: String(raw.ContentID || raw.content_id || "").trim(),
    content_type: contentType,
    title: plainText(raw.Title || raw.title, 220),
    excerpt,
    summary: excerpt.slice(0, 360),
    url: String(raw.Url || raw.url || "").trim(),
    author: plainText(raw.AuthorName || raw.author_name, 80),
    published_at: String(raw.PublishedAt || raw.published_at || raw.CreatedAt || raw.created_at || "").trim(),
    vote_up_count: votes,
    authority_level: raw.AuthorityLevel !== undefined ? raw.AuthorityLevel : raw.authority_level,
    ranking_score: raw.RankingScore !== undefined ? raw.RankingScore : raw.ranking_score,
  };
}

async function search(query, count = 10, { highVoteOnly = false } = {}) {
  const q = String(query || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!q) return { ok: false, error: "知乎搜索关键词不能为空", items: [], quota: stateSummary() };
  const n = Math.max(1, Math.min(Number(count) || 10, 10));
  const minVotes = highVoteOnly ? MIN_VOTE_UPS : 0;
  try {
    const { value, meta } = await cachedUpstream({
      apiId: "zhihu_search", method: "GET", url: SEARCH_URL,
      payload: { Query: q, Count: n }, ttl: SEARCH_CACHE_TTL,
    });
    const items = asItems(value)
      .filter((raw) => raw && typeof raw === "object")
      .map((raw) => normalizeSearchItem(raw, { minVotes }))
      .filter(Boolean);
    return { ok: true, query: q, items, min_vote_ups: minVotes, cache: meta, quota: stateSummary() };
  } catch (err) {
    return { ok: false, error: err.message, items: [], min_vote_ups: minVotes, quota: stateSummary() };
  }
}

/* 从本实例的搜索缓存里找这条素材（找到就用它更完整的正文/作者/赞数）。
   注意：**这只作为增强**，不再是硬性校验 —— 线上平台会跑多个实例，
   搜索与生成很可能落在不同实例上，旧实现因此必然误报「选材未通过服务器校验」。 */
function trustedSearchItem(contentId) {
  const state = loadState();
  for (const entry of Object.values(state.cache)) {
    if (!entry || typeof entry !== "object" || entry.api_id !== "zhihu_search") continue;
    for (const raw of asItems(entry.value)) {
      if (!raw || typeof raw !== "object") continue;
      const item = normalizeSearchItem(raw, { minVotes: 0 });
      if (item && item.content_id === contentId) return item;
    }
  }
  return null;
}

async function resolveSourcePayload(source, sourcePayload) {
  if (source === "original") return { payload: null, error: null };
  const sp = sourcePayload && typeof sourcePayload === "object" ? sourcePayload : null;
  if (["hot", "story", "knowledge"].includes(source)) {
    if (!sp) return { payload: null, error: "请先选择一条内容" };
    return {
      payload: {
        source,
        title: String(sp.title || "").trim(),
        content_id: String(sp.content_id || sp.work_id || "").trim(),
        excerpt: String(sp.excerpt || sp.description || "").trim(),
        summary: String(sp.summary || sp.description || sp.excerpt || "").trim(),
        author: String(sp.author || "").trim(),
        url: String(sp.url || "").trim(),
        labels: (sp.labels || []).slice(0, 10).map((v) => String(v).slice(0, 50)),
      },
      error: null,
    };
  }
  if (source !== "zhihu_search" || !sp) {
    return { payload: null, error: "该选题来源已停用，请重新选择一条知乎内容" };
  }
  /* 放开限制：任何被选中的知乎文章/回答都可以用来成文，不再要求赞数门槛，
     也不再要求「必须由本实例搜索过」。缓存命中就用缓存的正文（更完整），
     没命中就直接采用客户端选中的素材。 */
  const rawId = String(sp.content_id || sp.work_id || "").trim().replace(/^search:/, "");
  const cached = rawId ? trustedSearchItem(rawId) : null;
  const title = String((cached && cached.title) || sp.title || "").trim().slice(0, 200);
  const excerpt = String((cached && cached.excerpt) || sp.excerpt || sp.summary || sp.description || "").trim();
  const summary = String((cached && cached.summary) || sp.summary || sp.description || excerpt).trim();
  if (!title && !excerpt) {
    return { payload: null, error: "所选素材没有可用正文，请重新搜索并选择一条知乎回答或文章" };
  }
  return {
    payload: {
      content_id: rawId || String((cached && cached.content_id) || ""),
      content_type: String((cached && cached.content_type) || sp.content_type || "answer").trim(),
      title,
      author: String((cached && cached.author) || sp.author || "").trim(),
      url: String((cached && cached.url) || sp.url || "").trim(),
      vote_up_count: Number((cached && cached.vote_up_count) || sp.vote_up_count || 0) || 0,
      content: excerpt,
      summary,
      digest: String(sp.digest || "").trim().slice(0, 1200),
      labels: Array.isArray(sp.labels) ? sp.labels.slice(0, 10).map((v) => String(v).slice(0, 50)) : [],
    },
    error: null,
  };
}

async function zhidaComplete(messages, model = "zhida-thinking-1p5") {
  const m = ALLOWED_MODELS.has(model) ? model : "zhida-thinking-1p5";
  const safeMessages = (messages || [])
    .filter((item) => item && typeof item === "object")
    .map((item) => ({ role: String(item.role || "user"), content: String(item.content || "") }));
  if (!safeMessages.length) throw new ZhihuError("知乎直答消息不能为空");
  const started = Date.now();
  const { value, meta } = await cachedUpstream({
    apiId: "zhida_openai", method: "POST", url: ZHIDA_URL,
    payload: { model: m, messages: safeMessages, stream: false },
    ttl: 0, timeoutMs: 130000, budget: "generation", useCache: false,
  });
  let content;
  try {
    content = String(value.choices[0].message.content);
  } catch (err) {
    throw new ZhihuError("知乎直答返回结构不完整");
  }
  const usageRaw = value && typeof value.usage === "object" && value.usage ? value.usage : {};
  return {
    content,
    usage: usageRaw,
    model: value && typeof value.model === "string" ? value.model : m,
    cache_hit: Boolean(meta.cache_hit),
    stale: Boolean(meta.stale),
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    elapsed_ms: meta.cache_hit ? 0 : Date.now() - started,
    quota: stateSummary(),
  };
}

function normalizeHotItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.Title || raw.title || "").trim();
  if (!title) return null;
  const summary = String(raw.Summary || raw.summary || "").trim().slice(0, 300);
  return {
    title,
    content_id: String(raw.ContentId || raw.ContentID || raw.content_id || ""),
    summary,
    excerpt: summary,
    url: String(raw.Url || raw.url || "").trim(),
    thumbnail: String(raw.ThumbnailUrl || raw.thumbnail || "").trim(),
  };
}

async function hotList(limit = 30) {
  const count = Math.max(1, Math.min(Number(limit) || 30, 30));
  try {
    const { value, meta } = await cachedUpstream({
      apiId: "hot_list", method: "GET", url: `${DEVELOPER_BASE}/api/v1/content/hot_list`,
      payload: { Limit: count }, ttl: SEARCH_CACHE_TTL,
    });
    const items = asItems(value).filter((raw) => raw && typeof raw === "object").map(normalizeHotItem).filter(Boolean);
    return { ok: true, items, cache: meta, quota: stateSummary() };
  } catch (err) {
    return { ok: false, error: err.message, items: [], quota: stateSummary() };
  }
}

async function hackathonList(kind) {
  try {
    const resp = await fetch(`https://api.zhihu.com/km-indep-home/hackathon/v2/${kind}/list`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(38000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.json();
    const items = Array.isArray(raw) ? raw : [];
    return {
      ok: true,
      items: items
        .filter((item) => item && typeof item === "object" && item.work_id)
        .map((item) => ({
          work_id: String(item.work_id),
          title: String(item.title || "").trim(),
          description: String(item.description || "").trim(),
          labels: Array.isArray(item.labels) ? item.labels : [],
        })),
    };
  } catch (err) {
    return { ok: false, error: err.message, items: [] };
  }
}

const storyList = () => hackathonList("story");
const knowledgeList = () => hackathonList("knowledge");

async function hackathonDetail(kind, workId) {
  const safeId = String(workId || "").trim();
  if (!safeId || /[/?#\r\n]/.test(safeId)) return { ok: false, error: "无效的 work_id", detail: null };
  try {
    const resp = await fetch(`https://api.zhihu.com/km-indep-home/hackathon/v2/${kind}/${safeId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(38000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.json();
    if (!raw || typeof raw !== "object") return { ok: false, error: "返回格式异常", detail: null };
    return {
      ok: true,
      detail: {
        work_id: String(raw.work_id || safeId),
        title: String(raw.chapter_name || raw.title || "").trim(),
        author: String(raw.author_name || "").trim(),
        labels: Array.isArray(raw.labels) ? raw.labels : [],
        introduction: String(raw.introduction || "").trim(),
        content: String(raw.content || "").trim(),
      },
    };
  } catch (err) {
    return { ok: false, error: err.message, detail: null };
  }
}

const storyDetail = (id) => hackathonDetail("story", id);
const knowledgeDetail = (id) => hackathonDetail("knowledge", id);

async function officialQuota(apiId = "zhida_openai") {
  const secret = settings.zhihuSecret();
  if (!secret) throw new ZhihuError("未配置知乎 Access Secret");
  let items;
  try {
    const resp = await fetch(`${QUOTA_URL}?APIIDs=${encodeURIComponent(apiId)}`, {
      headers: headers(secret),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    items = asItems(await resp.json());
  } catch (err) {
    if (err instanceof ZhihuError) throw err;
    throw new ZhihuError(`知乎额度查询失败：${err.message}`);
  }
  for (const item of items) {
    if (item && typeof item === "object" && String(item.APIID || item.api_id || "") === apiId) {
      return {
        api_id: apiId,
        total: Number(item.TotalQuota || item.total || 0) || 0,
        used: Number(item.TotalUsed || item.used || 0) || 0,
        remaining: Number(item.RemainingQuota || item.remaining || 0) || 0,
      };
    }
  }
  throw new ZhihuError("知乎额度接口未返回直答额度");
}

module.exports = {
  ZhihuError, status, stateSummary, search, resolveSourcePayload, zhidaComplete,
  hotList, storyList, knowledgeList, storyDetail, knowledgeDetail, officialQuota,
};
