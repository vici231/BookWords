/* api.js — 后端 API 封装（ES module） */

import { state } from "./state.js";

/* 后端地址前缀：固定同域（相对路径）。
   历史上支持 localStorage 覆盖（wj_api_base），但残留旧值会把所有请求
   发去失效的旧后端并报「接口不存在」，独立部署始终同源，故不再读取。 */
export function apiBase() {
  return "";
}

/* 本机凭证随每个请求发出（用户在设置页自己填，存在浏览器 localStorage）。
   服务端只在本次请求内使用，不落盘、不回显 —— 所以仓库和部署包里没有 key。 */
export function credentialHeaders() {
  const cred = state.credentials || {};
  const headers = {};
  if (cred.api_key) headers["X-AI-Key"] = cred.api_key;
  if (cred.base_url) headers["X-AI-Base-URL"] = cred.base_url;
  if (cred.model) headers["X-AI-Model"] = cred.model;
  if (cred.access_secret) headers["X-Zhihu-Secret"] = cred.access_secret;
  return headers;
}

/* AI Works 预览网关对突发请求限流（429 Too Many Requests）：首屏并发拉
   levels/config/meta 时可能被掐。GET 幂等请求自动退避重试（尊重
   Retry-After；无则指数退避+抖动）；POST/PUT 涉及生成与写库，绝不自动重发。 */
/* 平台网关限流/超时：除 400/401/403/404（业务语义，重试无意义）外，
   4xx 非标状态（如网关超时 233）与 5xx 全部退避重试 */
const NON_RETRIABLE_STATUS = new Set([400, 401, 403, 404]);
const isRetriableStatus = (s) => !NON_RETRIABLE_STATUS.has(s) && (s >= 400 || (s < 200 && s !== 204));
/* 平台网关限流窗口可达分钟级：6 次退避重试总跨度 ≈ 2 分钟
   （1.5s → 3.9s → 10s → 26s → 40s → 40s，各加 0-800ms 抖动） */
const MAX_RETRIES = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, options = {}, attempt = 0) {
  const isBody = options.body !== undefined;
  const method = (options.method || "GET").toUpperCase();
  const { headers: optionHeaders, ...requestOptions } = options;
  let res;
  try {
    res = await fetch(apiBase() + url, {
      ...requestOptions,
      headers: {
        ...(isBody ? { "Content-Type": "application/json" } : {}),
        ...credentialHeaders(),
        ...(optionHeaders || {}),
      },
    });
  } catch (networkErr) {
    /* 网络层失败（断网/网关瞬断）：仅幂等 GET 重试 */
    if (method === "GET" && attempt < MAX_RETRIES) {
      await sleep(Math.min(40000, 1500 * Math.pow(2.6, attempt)) + Math.random() * 800);
      return request(url, options, attempt + 1);
    }
    throw networkErr;
  }
  if (isRetriableStatus(res.status) && method === "GET" && attempt < MAX_RETRIES) {
    const retryAfter = parseFloat(res.headers.get("Retry-After"));
    const delay = Number.isFinite(retryAfter)
      ? retryAfter * 1000
      : Math.min(40000, 1500 * Math.pow(2.6, attempt)) + Math.random() * 800;
    await sleep(delay);
    return request(url, options, attempt + 1);
  }
  const data = await res.json().catch(() => ({}));
  /* AI Works 网关把超时包成 HTTP 200 + ret_code 200401（"Internal task
     timed out after 3 seconds"）：识别后按限流超时同样退避重试 */
  if (data && typeof data === "object" && data.ret_code && data.ret_code !== 0) {
    if (method === "GET" && attempt < MAX_RETRIES) {
      await sleep(Math.min(40000, 1500 * Math.pow(2.6, attempt)) + Math.random() * 800);
      return request(url, options, attempt + 1);
    }
    throw new Error(`网关超时（${data.ret_code}），请稍后重试`);
  }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status; /* 供长任务轮询识别 404（任务丢失）后自动重投 */
    err.data = data; /* 保留原始响应（如生成接口的 debug 轨迹），供调试台使用 */
    throw err;
  }
  return data;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/* ---- 长任务：单请求流式（首选）+ 提交轮询（兜底） ----
   线上（AI Works 预览）两个实测约束：
   1) 在云函数之前还有一层固定时长上限：几十秒才返回的请求被掐成裸 HTTP 554；
   2) 每一个请求都像是独立实例：上一个请求在进程内存里建的 job，下一个请求查不到
      （提交 200 拿到 job_id，3 次轮询全 404 job_missing）。
   所以首选「单请求流式」：函数先回响应头并每 1.5 秒发心跳字节，结果最后作为
   SSE 事件发出 —— 全部工作在一个请求内完成，既躲开时长上限，也不依赖跨请求状态。
   若流式不可用（平台改写/缓冲/报错），自动退回「提交 + 短请求轮询」。 */

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 6 * 60 * 1000;
/* 轮询兜底时任务状态在服务实例内存里：打到别的实例会回 404（job_missing），
   自动重投，最多 MAX_RESUBMIT 次，仍失败才报错。 */
const MAX_RESUBMIT = 2;

function payloadToResult(payload) {
  const result = payload || {};
  if (!result.body) throw new Error("任务已结束但未返回结果，请重试");
  if (Number(result.status) >= 400) {
    const err = new Error(result.body.error || `请求失败（${result.status}）`);
    err.status = Number(result.status);
    err.data = result.body; /* 保留原始响应（含 debug 轨迹），供调试台使用 */
    throw err;
  }
  return result.body;
}

/* 流式：返回 null 表示「这一层不支持流式，请走轮询兜底」 */
async function runStreamTask(path, body, { signal } = {}) {
  const res = await fetch(apiBase() + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...credentialHeaders() },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) return null;
  const ctype = String(res.headers.get("content-type") || "").toLowerCase();
  if (!ctype.includes("text/event-stream")) return null; /* 平台改写成了普通响应 */
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let payload = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (chunk.startsWith("event: result")) {
        const line = chunk.split("\n").find((item) => item.startsWith("data: "));
        if (line) {
          try { payload = JSON.parse(line.slice(6)); } catch (err) { payload = null; }
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  return payload;
}

async function runLongTask(path, body, { signal } = {}) {
  /* 首选：单请求流式 */
  try {
    const streamed = await runStreamTask(path, body, { signal });
    if (streamed) {
      console.log("[bookwords] 长任务通过 SSE 单请求完成（未使用跨请求状态）");
      return payloadToResult(streamed);
    }
    console.warn("[bookwords] 平台未透传流式响应，回退到提交+轮询");
  } catch (err) {
    if (err.name === "AbortError") throw err;
    console.warn("[bookwords] 流式不可用，回退到提交+轮询：", err.message);
  }

  const submit = () =>
    request(path, {
      method: "POST",
      headers: { "X-Async": "1" },
      body: JSON.stringify({ ...body, async: true }),
      signal,
    });

  let submitted = await submit();
  /* 退回同步响应（老服务端或该接口未启用异步） */
  if (!submitted || !submitted.job_id) return submitted;

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let resubmits = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (signal && signal.aborted) throw new DOMException("已取消", "AbortError");
    let poll;
    try {
      poll = await request(path, { method: "POST", body: JSON.stringify({ job: submitted.job_id }), signal });
    } catch (err) {
      /* 任务丢了（实例切换/回收）：重投，最多 MAX_RESUBMIT 次 */
      if (err.status === 404 && resubmits < MAX_RESUBMIT && !(signal && signal.aborted)) {
        resubmits += 1;
        submitted = await submit();
        if (!submitted || !submitted.job_id) throw err;
        continue;
      }
      throw err;
    }
    const job = poll && poll.job;
    if (!job || job.status === "running") continue;
    console.log("[bookwords] 长任务通过提交+轮询完成");
    return payloadToResult(job.result);
  }
  throw new Error("等待超时：服务端仍在生成，请稍后重试");
}

/* 分步生成/选题覆盖的每个请求都是无状态的，因此可以安全重试。
   线上网关对超时请求返回裸 HTTP 554（并已自行重试一次，客户端约 32 秒后才看到），
   模型侧耗时本身有波动（实测同一步 9–17 秒），所以被掐断时自动再试一次，
   比整条流程失败体验好得多。 */
const STAGE_RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 554]);
async function stageRequest(path, payload, { signal, retries = 1 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await request(path, { method: "POST", signal, body: JSON.stringify(payload) });
    } catch (err) {
      lastError = err;
      const retriable = STAGE_RETRY_STATUS.has(Number(err.status)) || err.name === "TypeError";
      if (signal && signal.aborted) throw err;
      if (!retriable || attempt === retries) throw err;
      console.warn(`[bookwords] 请求被网关中断（${err.message}），自动重试第 ${attempt + 1} 次`);
      await sleep(800);
    }
  }
  throw lastError || new Error("请求失败");
}

/* ---- 生成：拆成多个「都在线上时限内」的短请求 ----
   线上实测：网关只允许约 12–15 秒的请求（服务端延时 12s 通过、18s 被掐成 HTTP 554），
   而且会把响应整体缓冲（流式无效）、会重试（一次失败要等约 32 秒才报错）。
   一次跑完「智能配词 + 英文正文 + 中文翻译」需要 20 秒以上，必然被掐。
   所以拆成三步，每一步都在限内，中间结果随请求传递（不依赖服务端记忆）：
     1) 智能配词  POST /api/group/words                       （仅当调用方还没确认词组，约 9 秒）
     2) 英文草稿  POST /api/generate/story  stage=draft        （约 9 秒）
     3) 中文+总结 POST /api/generate/story  stage=localize     （约 5 秒）
   返回的对象与原来一次生成完全一致，视图层不需要改动。 */
async function generateStaged(mode, cards, level, params, source, sourcePayload, options = {}) {
  let confirmedGroup = options.confirmedGroup || null;
  if (!confirmedGroup) {
    const grouped = await stageRequest("/api/group/words", {
      cards,
      locked_words: options.lockedWords || [],
      excluded_words: options.excludedWords || [],
      max_groups: 3,
      max_words: 20,
    }, { signal: options.signal });
    confirmedGroup = (grouped && grouped.selected_group) || null;
  }

  const common = {
    cards,
    level,
    params,
    source,
    memory_scope: options.memoryScope || "pool",
    language: options.language || "en",
    recent_cards: options.recentCards || [],
    confirmed_group: confirmedGroup,
    locked_words: options.lockedWords || [],
    excluded_words: options.excludedWords || [],
    original_topic: options.originalTopic || "",
    ...(sourcePayload ? { sourcePayload } : {}),
  };

  let result = await stageRequest(`/api/generate/${mode}`, { ...common, stage: "draft" }, { signal: options.signal });
  /* 命中服务端完整文章缓存时不会有 stage=draft，直接用即可 */
  if (result && result.stage === "draft") {
    result = await stageRequest(`/api/generate/${mode}`, { stage: "localize", draft: result, language: common.language }, { signal: options.signal });
  }
  return result;
}

/* ---- 知乎选题覆盖：同样拆成短请求 ----
   线上实测整链约 30 秒（3 次 LLM + 4 次知乎搜索），一次请求必被掐成 554。
   拆成若干步，每步产物随下一步的请求体回传（服务端不保存中间态）：
     queries → candidates → plan → digest（逐个选题，各约 5 秒）→ assemble（纯本地）
   assemble 返回的对象与原来一次调用完全一致，调用方无需改动。
   实测各步：queries 4.8s ｜ candidates 2.4s ｜ plan 7.2s ｜ 每篇 digest 约 5-6s。 */
async function coverageStaged(cards, days = 3) {
  const base = { cards, days };
  const post = (payload) => stageRequest("/api/topics/zhihu-coverage", payload);

  const queries = await post({ ...base, stage: "queries" });
  const picked = await post({ ...base, stage: "candidates", queries: queries.queries });
  const planned = await post({ ...base, stage: "plan", queries: queries.queries, candidates: picked.candidates });

  /* 逐篇概括：整批一次要 20 秒以上，会被线上网关掐断 */
  const digested = [];
  for (const plan of planned.plans || []) {
    const one = await post({ ...base, stage: "digest", plans: [plan] });
    digested.push(...((one && one.plans) || [plan]));
  }

  return post({
    ...base,
    stage: "assemble",
    plans: digested,
    provider: planned.provider,
    search_errors: picked.errors,
  });
}

export const Api = {
  mode: () => request("/api/mode"),
  /* 用当前（本机配置的）凭证做一次真实连通性测试 */
  testAiConfig: (payload = {}) => request("/api/health", { method: "POST", body: JSON.stringify(payload) }),
  /* 前端单一事实来源：最少卡牌数 / 供应商目录 / 识别规则 */
  meta: () => request("/api/meta"),
  levels: () => request("/api/words/levels"),
  searchWords: (q, level, limit = 60, pos = "") =>
    request(`/api/words/search?q=${encodeURIComponent(q)}&level=${encodeURIComponent(level)}&pos=${encodeURIComponent(pos)}&limit=${limit}`),
  randomWords: (level, count = 12) =>
    request(`/api/words/random?level=${encodeURIComponent(level)}&count=${count}`),
  dailyWords: (level, count = 12) =>
    request(`/api/words/daily?level=${encodeURIComponent(level)}&count=${count}`),
  addCustomWord: (word, pos, meaning_cn) =>
    request("/api/words/custom", { method: "POST", body: JSON.stringify({ word, pos, meaning_cn }) }),
  getConfig: () => request("/api/config"),
  saveConfig: (cfg) => request("/api/config", { method: "POST", body: JSON.stringify(cfg) }),
  /* 智能配词：单次 LLM 调用，约 9 秒，普通请求即可（不要再走长任务通道） */
  groupWords: (cards, options = {}) => request("/api/group/words", {
    method: "POST",
    body: JSON.stringify({
      cards,
      locked_words: options.lockedWords || [],
      excluded_words: options.excludedWords || [],
      source_hint: options.sourceHint || null,
      max_groups: 3,
      max_words: 20,
    }),
  }),
  zhihuCoverage: (cards, days = 3) => coverageStaged(cards, days),
  generate: (mode, cards, level, params, source = "original", sourcePayload = null, options = {}) =>
    generateStaged(mode, cards, level, params, source, sourcePayload, options),
  periodical: (period, articles) => request(`/api/articles/periodical?period=${encodeURIComponent(period)}`, {
    method: "POST",
    body: JSON.stringify({ articles }),
  }),
  recommendTopics: (cards, candidates) =>
    request("/api/recommend/topics", {
      method: "POST",
      body: JSON.stringify({ cards, candidates }),
    }),
  /* 知乎能力：文章选材只使用可核验赞数的知乎搜索。 */
  zhihuStatus: () => request("/api/zhihu/status"),
  zhihuSearch: (query, limit = 10) => request(`/api/zhihu/search?q=${encodeURIComponent(query)}&limit=${limit}`),
  zhihuHot: (limit = 30) => request(`/api/zhihu/hot?limit=${limit}`),
  zhihuStories: () => request("/api/zhihu/stories"),
  zhihuStory: (id) => request(`/api/zhihu/story?id=${encodeURIComponent(id)}`),
  zhihuKnowledge: (id) =>
    id
      ? request(`/api/zhihu/knowledge?id=${encodeURIComponent(id)}`)
      : request("/api/zhihu/knowledge"),
  authRegister: (username, password, data) =>
    request("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password, data }) }),
  authLogin: (username, password) =>
    request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  authMe: (token) => request("/api/auth/me", { headers: authHeaders(token) }),
  authSaveData: (token, data) =>
    request("/api/auth/data", { method: "PUT", headers: authHeaders(token), body: JSON.stringify({ data }) }),
  authLogout: (token) =>
    request("/api/auth/logout", { method: "POST", headers: authHeaders(token), body: JSON.stringify({}) }),
};
