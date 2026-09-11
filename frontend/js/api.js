/* api.js — 后端 API 封装（ES module） */

async function request(url, options = {}) {
  const isBody = options.body !== undefined;
  const { headers: optionHeaders, ...requestOptions } = options;
  const res = await fetch(url, {
    ...requestOptions,
    headers: { ...(isBody ? { "Content-Type": "application/json" } : {}), ...(optionHeaders || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.data = data; /* 保留原始响应（如生成接口的 debug 轨迹），供调试台使用 */
    throw err;
  }
  return data;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export const Api = {
  /* 不传参 = 当前状态；传配置对象 = 用该候选配置测试连通性（只测不存） */
  health: (cfg) =>
    cfg
      ? request("/api/health", { method: "POST", body: JSON.stringify(cfg) })
      : request("/api/health"),
  mode: () => request("/api/mode"),
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
  resetConfig: () => request("/api/config", { method: "DELETE" }),
  models: (cfg) => request("/api/models", { method: "POST", body: JSON.stringify(cfg) }),
  generate: (mode, cards, level, params, source = "original", sourcePayload = null, options = {}) =>
    request(`/api/generate/${mode}`, {
      method: "POST",
      body: JSON.stringify({
        cards,
        level,
        params,
        source,
        memory_scope: options.memoryScope || "pool",
        language: options.language || "en",
        recent_cards: options.recentCards || [],
        ...(sourcePayload ? { sourcePayload } : {}),
      }),
    }),
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
