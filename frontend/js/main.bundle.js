(() => {
  // frontend/js/state.js
  var MAX_STORY_CARDS = 20;
  var state = {
    pool: [],
    targetSelection: /* @__PURE__ */ new Set(),
    wordbook: [],
    wordbookSort: "time-desc",
    levels: [],
    // [{id, label}]
    level: "all",
    // 当前词库难度；all 表示全部词库
    libraryCards: [],
    // 当前库展示的子集（搜索 / 随机 / 每日），绝不全部
    diff: 3,
    // 故事难度滑条（1-10）
    sliders: { density: 5, richness: 5, reasoning: 5, abstraction: 5, length: 220 },
    memoryScope: "pool",
    articleLanguage: "en",
    periodicalView: "daily",
    periodicalSelections: { week: {}, month: {} },
    workflowStage: "words",
    generationRoute: "zhihu",
    coverageDays: 3,
    coveragePlans: [],
    coverageStatus: null,
    groupCandidates: [],
    selectedGroup: null,
    lockedWords: /* @__PURE__ */ new Set(),
    excludedWords: /* @__PURE__ */ new Set(),
    groupVariantIndex: 0,
    originalTopic: "",
    customStyle: { genre: "daily-science", tone: "clear", structure: "scene-explain", length: 220 },
    resultMode: "reading",
    practiceMode: "target",
    masteredWords: {},
    recentMistakes: [],
    practiceResults: {},
    workflowError: null,
    settings: { api: { base_url: "", model: "", has_key: false, api_key_masked: "" }, zhihu: {}, theme: "paper" },
    /* 本机凭证：只存在浏览器 localStorage，随每个请求发给后端（后端不落盘）。
       仓库与部署包默认不含任何真实凭证。 */
    credentials: { base_url: "", api_key: "", model: "", access_secret: "" },
    theme: "paper",
    search: "",
    pos: "",
    lastStory: null,
    lastGeneration: null,
    articles: [],
    lastArticleId: "",
    practiceCompleted: false,
    poolUpdatedAt: "",
    wbSelection: /* @__PURE__ */ new Set(),
    dailyRecords: [],
    profile: { name: "刊见学习者", goal: "每天记住 10 个词", signature: "", avatar: "学", updatedAt: "" },
    auth: { token: "", user: null, registering: false },
    settingsUpdatedAt: "",
    generating: false,
    /* 当前选题来源；知乎强化路线由覆盖计划设置，今日创作使用 original。 */
    source: "original",
    sourceSelection: null,
    sourceRecommendations: [],
    sourceRecommendationKey: "",
    zhihuSearchCache: /* @__PURE__ */ new Map(),
    zhihuHotCache: null,
    zhihuStoriesCache: null,
    zhihuKnowledgeCache: null,
    /* /api/meta 下发的单一事实来源 */
    minCards: 3
  };
  var listeners = /* @__PURE__ */ new Map();
  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, /* @__PURE__ */ new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  }
  function emit(event, payload) {
    listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[bus] ${event} 处理失败`, e);
      }
    });
  }

  // frontend/js/api.js
  function apiBase() {
    return "";
  }
  function credentialHeaders() {
    const cred = state.credentials || {};
    const headers = {};
    if (cred.api_key) headers["X-AI-Key"] = cred.api_key;
    if (cred.base_url) headers["X-AI-Base-URL"] = cred.base_url;
    if (cred.model) headers["X-AI-Model"] = cred.model;
    if (cred.access_secret) headers["X-Zhihu-Secret"] = cred.access_secret;
    return headers;
  }
  var NON_RETRIABLE_STATUS = /* @__PURE__ */ new Set([400, 401, 403, 404]);
  var isRetriableStatus = (s) => !NON_RETRIABLE_STATUS.has(s) && (s >= 400 || s < 200 && s !== 204);
  var MAX_RETRIES = 6;
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function request(url, options = {}, attempt = 0) {
    const isBody = options.body !== void 0;
    const method = (options.method || "GET").toUpperCase();
    const { headers: optionHeaders, ...requestOptions } = options;
    let res;
    try {
      res = await fetch(apiBase() + url, {
        ...requestOptions,
        headers: {
          ...isBody ? { "Content-Type": "application/json" } : {},
          ...credentialHeaders(),
          ...optionHeaders || {}
        }
      });
    } catch (networkErr) {
      if (method === "GET" && attempt < MAX_RETRIES) {
        await sleep(Math.min(4e4, 1500 * Math.pow(2.6, attempt)) + Math.random() * 800);
        return request(url, options, attempt + 1);
      }
      throw networkErr;
    }
    if (isRetriableStatus(res.status) && method === "GET" && attempt < MAX_RETRIES) {
      const retryAfter = parseFloat(res.headers.get("Retry-After"));
      const delay = Number.isFinite(retryAfter) ? retryAfter * 1e3 : Math.min(4e4, 1500 * Math.pow(2.6, attempt)) + Math.random() * 800;
      await sleep(delay);
      return request(url, options, attempt + 1);
    }
    const data = await res.json().catch(() => ({}));
    if (data && typeof data === "object" && data.ret_code && data.ret_code !== 0) {
      if (method === "GET" && attempt < MAX_RETRIES) {
        await sleep(Math.min(4e4, 1500 * Math.pow(2.6, attempt)) + Math.random() * 800);
        return request(url, options, attempt + 1);
      }
      throw new Error(`网关超时（${data.ret_code}），请稍后重试`);
    }
    if (!res.ok) {
      const err = new Error(data.error || `请求失败（${res.status}）`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  function authHeaders(token) {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  var POLL_TIMEOUT_MS = 6 * 60 * 1e3;
  var STAGE_RETRY_STATUS = /* @__PURE__ */ new Set([408, 425, 429, 500, 502, 503, 504, 554]);
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
  async function generateStaged(mode, cards, level, params, source, sourcePayload, options = {}) {
    let confirmedGroup = options.confirmedGroup || null;
    if (!confirmedGroup) {
      const grouped = await stageRequest("/api/group/words", {
        cards,
        locked_words: options.lockedWords || [],
        excluded_words: options.excludedWords || [],
        max_groups: 3,
        max_words: 20
      }, { signal: options.signal });
      confirmedGroup = grouped && grouped.selected_group || null;
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
      ...sourcePayload ? { sourcePayload } : {}
    };
    let result = await stageRequest(`/api/generate/${mode}`, { ...common, stage: "draft" }, { signal: options.signal });
    if (result && result.stage === "draft") {
      result = await stageRequest(`/api/generate/${mode}`, { stage: "localize", draft: result, language: common.language }, { signal: options.signal });
    }
    return result;
  }
  async function coverageStaged(cards, days = 3) {
    const base = { cards, days };
    const post = (payload) => stageRequest("/api/topics/zhihu-coverage", payload);
    const queries = await post({ ...base, stage: "queries" });
    const picked = await post({ ...base, stage: "candidates", queries: queries.queries });
    const planned = await post({ ...base, stage: "plan", queries: queries.queries, candidates: picked.candidates });
    const digested = [];
    for (const plan of planned.plans || []) {
      const one = await post({ ...base, stage: "digest", plans: [plan] });
      digested.push(...one && one.plans || [plan]);
    }
    return post({
      ...base,
      stage: "assemble",
      plans: digested,
      provider: planned.provider,
      search_errors: picked.errors
    });
  }
  var Api = {
    mode: () => request("/api/mode"),
    /* 用当前（本机配置的）凭证做一次真实连通性测试 */
    testAiConfig: (payload = {}) => request("/api/health", { method: "POST", body: JSON.stringify(payload) }),
    /* 前端单一事实来源：最少卡牌数 / 供应商目录 / 识别规则 */
    meta: () => request("/api/meta"),
    levels: () => request("/api/words/levels"),
    searchWords: (q, level, limit = 60, pos = "") => request(`/api/words/search?q=${encodeURIComponent(q)}&level=${encodeURIComponent(level)}&pos=${encodeURIComponent(pos)}&limit=${limit}`),
    randomWords: (level, count = 12) => request(`/api/words/random?level=${encodeURIComponent(level)}&count=${count}`),
    dailyWords: (level, count = 12) => request(`/api/words/daily?level=${encodeURIComponent(level)}&count=${count}`),
    addCustomWord: (word, pos, meaning_cn) => request("/api/words/custom", { method: "POST", body: JSON.stringify({ word, pos, meaning_cn }) }),
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
        max_words: 20
      })
    }),
    zhihuCoverage: (cards, days = 3) => coverageStaged(cards, days),
    generate: (mode, cards, level, params, source = "original", sourcePayload = null, options = {}) => generateStaged(mode, cards, level, params, source, sourcePayload, options),
    periodical: (period, articles) => request(`/api/articles/periodical?period=${encodeURIComponent(period)}`, {
      method: "POST",
      body: JSON.stringify({ articles })
    }),
    recommendTopics: (cards, candidates) => request("/api/recommend/topics", {
      method: "POST",
      body: JSON.stringify({ cards, candidates })
    }),
    /* 知乎能力：文章选材只使用可核验赞数的知乎搜索。 */
    zhihuStatus: () => request("/api/zhihu/status"),
    zhihuSearch: (query, limit = 10) => request(`/api/zhihu/search?q=${encodeURIComponent(query)}&limit=${limit}`),
    zhihuHot: (limit = 30) => request(`/api/zhihu/hot?limit=${limit}`),
    zhihuStories: () => request("/api/zhihu/stories"),
    zhihuStory: (id) => request(`/api/zhihu/story?id=${encodeURIComponent(id)}`),
    zhihuKnowledge: (id) => id ? request(`/api/zhihu/knowledge?id=${encodeURIComponent(id)}`) : request("/api/zhihu/knowledge"),
    authRegister: (username, password, data) => request("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password, data }) }),
    authLogin: (username, password) => request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
    authMe: (token) => request("/api/auth/me", { headers: authHeaders(token) }),
    authSaveData: (token, data) => request("/api/auth/data", { method: "PUT", headers: authHeaders(token), body: JSON.stringify({ data }) }),
    authLogout: (token) => request("/api/auth/logout", { method: "POST", headers: authHeaders(token), body: JSON.stringify({}) })
  };

  // frontend/js/utils.js
  function esc(s) {
    return String(s ?? "").replace(
      /[&<>"']/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
    );
  }
  function formatBold(text) {
    return esc(text).replace(/\*\*([^*]+)\*\*/g, '<strong class="tw">$1</strong>');
  }
  var $ = (sel, root = document) => root.querySelector(sel);
  var nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
  function parseStamp(value) {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? null : date;
  }
  function pad2(number) {
    return String(number).padStart(2, "0");
  }
  function formatStamp(value, prefix = "") {
    const date = parseStamp(value);
    if (!date) return null;
    return `${prefix}${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
  function toast(msg, ms = 2600) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.hidden = true, ms);
  }
  function wordbookPos(pos) {
    const value = String(pos || "").toLowerCase();
    if (value.startsWith("adj")) return "adj.";
    if (value.startsWith("adv")) return "adv.";
    if (value.startsWith("n")) return "n.";
    if (value.startsWith("v")) return "v.";
    return pos || "词汇";
  }
  function wordbookMeaning(word) {
    const parts = String(word.meaning_cn || word.meaning || "暂无释义").split(/[；;，,、/]/).map((part) => part.trim()).filter(Boolean);
    return parts.slice(0, 3).join("；") + (parts.length > 3 ? "…" : "");
  }
  function formatWordbookDate(value) {
    const date = parseStamp(value);
    if (!date) return "时间未记录";
    return `${date.getFullYear()}年${pad2(date.getMonth() + 1)}月${pad2(date.getDate())}日`;
  }
  function formatWordbookTime(value) {
    const date = parseStamp(value);
    if (!date) return "—";
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
  function dateKey(date = /* @__PURE__ */ new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }
  function dateLabel(key) {
    const date = /* @__PURE__ */ new Date(`${key}T00:00:00`);
    if (Number.isNaN(date.getTime())) return key;
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  function avatarMarkup(value) {
    const val = value || "学";
    return String(val).startsWith("data:") ? `<img class="avatar-img" src="${esc(val)}" alt="头像">` : esc(val);
  }
  function fileToAvatar(file, max = 256) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取文件失败"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("解析图片失败"));
        img.onload = () => {
          try {
            const scale = Math.min(1, max / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", 0.85));
          } catch (e) {
            reject(e);
          }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // frontend/js/store.js
  var KEYS = {
    wordbook: "wj-wordbook",
    pool: "wj-pool",
    articles: "wj-articles",
    daily: "wj-daily-checkins",
    profile: "wj-profile",
    token: "wj-auth-token",
    settingsAt: "wj-settings-updated-at",
    learning: "wj-learning-state",
    credentials: "wj-credentials"
  };
  var LEGACY = {
    [KEYS.wordbook]: "ciyu-wordbook",
    [KEYS.pool]: "ciyu-story-pool",
    [KEYS.articles]: "ciyu-articles",
    [KEYS.daily]: "ciyu-daily-checkins",
    [KEYS.profile]: "ciyu-profile",
    [KEYS.settingsAt]: "ciyu-settings-updated-at"
  };
  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
    }
  }
  function migrateLegacyStorage() {
    try {
      if (localStorage.getItem(KEYS.wordbook) !== null) return;
      for (const [key, legacy] of Object.entries(LEGACY)) {
        if (localStorage.getItem(key) === null) {
          const raw = localStorage.getItem(legacy);
          if (raw !== null) {
            try {
              localStorage.setItem(key, JSON.parse(raw) ?? null);
            } catch (e) {
            }
          }
        }
      }
    } catch (e) {
    }
  }
  function userDataSnapshot() {
    return {
      profile: state.profile,
      wordbook: state.wordbook,
      pool: state.pool,
      articles: state.articles,
      dailyRecords: state.dailyRecords,
      masteredWords: state.masteredWords,
      recentMistakes: state.recentMistakes,
      practiceResults: state.practiceResults,
      periodicalSelections: state.periodicalSelections
    };
  }
  var syncTimer = null;
  var syncChain = Promise.resolve();
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, 800);
  }
  function runSync() {
    const token = state.auth.token;
    if (!token) return;
    const snapshot = JSON.parse(JSON.stringify(userDataSnapshot()));
    syncChain = syncChain.catch(() => void 0).then(() => Api.authSaveData(token, snapshot)).catch((err) => {
      if (state.auth.token === token) toast("加密数据同步失败：" + err.message);
    });
  }
  function persist() {
    writeJson(KEYS.wordbook, state.wordbook);
    writeJson(KEYS.pool, state.pool);
    writeJson(KEYS.articles, state.articles);
    writeJson("wj-periodical-selections", state.periodicalSelections);
    writeJson(KEYS.daily, state.dailyRecords);
    writeJson(KEYS.profile, state.profile);
    writeJson(KEYS.learning, { masteredWords: state.masteredWords, recentMistakes: state.recentMistakes, practiceResults: state.practiceResults });
    if (state.auth.token) scheduleSync();
  }
  function writeLocalOnly() {
    writeJson(KEYS.wordbook, state.wordbook);
    writeJson(KEYS.pool, state.pool);
    writeJson(KEYS.articles, state.articles);
    writeJson("wj-periodical-selections", state.periodicalSelections);
    writeJson(KEYS.daily, state.dailyRecords);
    writeJson(KEYS.profile, state.profile);
    writeJson(KEYS.learning, { masteredWords: state.masteredWords, recentMistakes: state.recentMistakes, practiceResults: state.practiceResults });
  }
  function persistSettingsStamp() {
    state.settingsUpdatedAt = nowIso();
    try {
      localStorage.setItem(KEYS.settingsAt, state.settingsUpdatedAt);
    } catch (e) {
    }
  }
  function loadSettingsStamp() {
    try {
      state.settingsUpdatedAt = localStorage.getItem(KEYS.settingsAt) || "";
    } catch (e) {
      state.settingsUpdatedAt = "";
    }
  }
  function normalizeWordEntry(entry) {
    if (entry && entry.review) {
      try {
        delete entry.review;
      } catch (e) {
        entry.review = void 0;
      }
    }
    return entry;
  }
  var migrateArticlesFn = null;
  function registerArticleMigrator(fn) {
    migrateArticlesFn = fn;
  }
  function loadLocal() {
    state.wordbook = readJson(KEYS.wordbook, []).filter((w) => w && w.word).map((w) => normalizeWordEntry({ ...w, savedAt: w.savedAt || nowIso() }));
    state.pool = readJson(KEYS.pool, []).filter((w) => w && w.word).slice(0, MAX_STORY_CARDS).map((w) => ({ ...w, addedAt: w.addedAt || nowIso() }));
    state.targetSelection = new Set(state.pool.map((word) => String(word.word || "").toLowerCase()));
    state.poolUpdatedAt = state.pool.reduce((latest, word) => word.addedAt > latest ? word.addedAt : latest, "");
    state.articles = readJson(KEYS.articles, []).filter((article) => article && article.story && article.story.en);
    const periodicalSelections = readJson("wj-periodical-selections", { week: {}, month: {} });
    state.periodicalSelections = periodicalSelections && typeof periodicalSelections === "object" ? { week: periodicalSelections.week || {}, month: periodicalSelections.month || {} } : { week: {}, month: {} };
    state.dailyRecords = readJson(KEYS.daily, []).filter((item) => item && item.date && item.checkedAt);
    state.profile = { ...state.profile, ...readJson(KEYS.profile, {}) };
    const learning = readJson(KEYS.learning, {});
    state.masteredWords = learning.masteredWords && typeof learning.masteredWords === "object" ? learning.masteredWords : {};
    state.recentMistakes = Array.isArray(learning.recentMistakes) ? learning.recentMistakes : [];
    state.practiceResults = learning.practiceResults && typeof learning.practiceResults === "object" ? learning.practiceResults : {};
    loadCredentials();
    migrateArticlesFn?.();
  }
  function loadCredentials() {
    const saved = readJson(KEYS.credentials, null);
    if (!saved || typeof saved !== "object") return state.credentials;
    state.credentials = {
      base_url: String(saved.base_url || ""),
      api_key: String(saved.api_key || ""),
      model: String(saved.model || ""),
      access_secret: String(saved.access_secret || "")
    };
    return state.credentials;
  }
  function saveCredentials(next) {
    const current = state.credentials || {};
    const merged = {
      base_url: String(next && next.base_url !== void 0 ? next.base_url : current.base_url || "").trim(),
      api_key: String(next && next.api_key !== void 0 ? next.api_key : current.api_key || "").trim(),
      model: String(next && next.model !== void 0 ? next.model : current.model || "").trim(),
      access_secret: String(next && next.access_secret !== void 0 ? next.access_secret : current.access_secret || "").trim()
    };
    state.credentials = merged;
    writeJson(KEYS.credentials, merged);
    return merged;
  }
  function setToken(token) {
    try {
      localStorage.setItem(KEYS.token, token);
    } catch (e) {
    }
  }
  function getToken() {
    try {
      return localStorage.getItem(KEYS.token) || "";
    } catch (e) {
      return "";
    }
  }
  function clearToken() {
    try {
      localStorage.removeItem(KEYS.token);
    } catch (e) {
    }
  }
  function applyUserData(data) {
    const source = data && typeof data === "object" ? data : {};
    state.wordbook = Array.isArray(source.wordbook) ? source.wordbook.filter((w) => w && w.word).map((w) => normalizeWordEntry({ ...w, savedAt: w.savedAt || nowIso() })) : [];
    state.pool = Array.isArray(source.pool) ? source.pool.filter((w) => w && w.word).slice(0, MAX_STORY_CARDS).map((w) => ({ ...w, addedAt: w.addedAt || nowIso() })) : [];
    state.targetSelection = new Set(state.pool.map((word) => String(word.word || "").toLowerCase()));
    state.poolUpdatedAt = state.pool.reduce((latest, word) => word.addedAt > latest ? word.addedAt : latest, "");
    state.articles = Array.isArray(source.articles) ? source.articles.filter((article) => article && article.story && article.story.en) : [];
    state.periodicalSelections = source.periodicalSelections && typeof source.periodicalSelections === "object" ? { week: source.periodicalSelections.week || {}, month: source.periodicalSelections.month || {} } : { week: {}, month: {} };
    state.dailyRecords = Array.isArray(source.dailyRecords) ? source.dailyRecords.filter((item) => item && item.date && item.checkedAt) : [];
    state.profile = { ...state.profile, ...source.profile && typeof source.profile === "object" ? source.profile : {} };
    state.masteredWords = source.masteredWords && typeof source.masteredWords === "object" ? source.masteredWords : {};
    state.recentMistakes = Array.isArray(source.recentMistakes) ? source.recentMistakes : [];
    state.practiceResults = source.practiceResults && typeof source.practiceResults === "object" ? source.practiceResults : {};
    migrateArticlesFn?.();
    writeLocalOnly();
  }
  function emitDataChanged() {
    emit("pool");
    emit("wordbook");
    emit("articles");
    emit("daily");
    emit("profile");
    emit("auth");
  }

  // frontend/js/router.js
  var viewRenderers = /* @__PURE__ */ new Map();
  function registerView(viewId, render) {
    viewRenderers.set(viewId, render);
  }
  function showView(viewId) {
    document.body.classList.toggle("is-home", viewId === "home-view");
    document.querySelectorAll(".view").forEach((view) => {
      const active = view.id === viewId;
      view.hidden = !active;
      view.classList.toggle("active", active);
    });
    document.querySelectorAll(".nav-item, .sidebar-item, .mobile-tabbar button").forEach((nav) => {
      const isActive = nav.dataset.view === viewId;
      nav.classList.toggle("active", isActive);
      nav.classList.toggle("is-active", isActive);
    });
    requestAnimationFrame(updateNavIndicator);
    viewRenderers.get(viewId)?.();
    if (viewId === "story-pool-view") {
      const section = $("#story-pool-view");
      section.classList.remove("anim-once");
      void section.offsetWidth;
      section.classList.add("anim-once");
      clearTimeout(showView._poolAnimT);
      showView._poolAnimT = setTimeout(() => section.classList.remove("anim-once"), 900);
    }
    $(".app-shell")?.scrollTo({ top: 0, behavior: "smooth" });
  }
  function updateNavIndicator() {
    const nav = document.querySelector(".main-nav");
    const active = nav?.querySelector(".nav-item.active");
    if (!nav || !active) return;
    const navRect = nav.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    nav.style.setProperty("--nav-left", `${itemRect.left - navRect.left}px`);
    nav.style.setProperty("--nav-width", `${itemRect.width}px`);
  }
  function bindNavigation() {
    document.querySelectorAll("[data-view]").forEach((item) => {
      if (item.closest("#home-view")) return;
      item.addEventListener("click", () => showView(item.dataset.view));
    });
    updateNavIndicator();
    window.addEventListener("resize", updateNavIndicator);
  }

  // frontend/js/auth.js
  function setAuthMode(registering) {
    $("#auth-title").textContent = registering ? "创建本地账户" : "登录刊见单词";
    $("#auth-intro").textContent = registering ? "创建后，当前浏览器中的学习数据会迁移到本机加密 JSON 文件。" : "登录后读取本机账户的加密资料、文章生成词组、日报与练习记录。";
    $("#btn-auth-submit").textContent = registering ? "创建并登录" : "登录";
    $("#btn-auth-switch").textContent = registering ? "已有账户，去登录" : "创建本地账户";
    $("#auth-confirm-wrap").hidden = !registering;
    $("#auth-password").autocomplete = registering ? "new-password" : "current-password";
    $("#auth-status").textContent = "";
    state.auth.registering = registering;
  }
  function openAuthModal(registering = false) {
    setAuthMode(registering);
    $("#auth-modal").hidden = false;
    $("#auth-username")?.focus();
  }
  async function submitAuth() {
    const username = $("#auth-username").value.trim();
    const password = $("#auth-password").value;
    const registering = Boolean(state.auth.registering);
    const status = $("#auth-status");
    if (registering && password !== $("#auth-confirm").value) {
      status.classList.add("is-error");
      status.textContent = "两次输入的密码不一致";
      return;
    }
    status.textContent = registering ? "正在创建加密账户…" : "正在解锁本地账户…";
    status.classList.remove("is-error");
    try {
      const result = registering ? await Api.authRegister(username, password, userDataSnapshot()) : await Api.authLogin(username, password);
      state.auth.token = result.token;
      state.auth.user = result.user;
      setToken(result.token);
      applyUserData(result.user?.data || {});
      $("#auth-modal").hidden = true;
      emitDataChanged();
      toast(registering ? "账户已创建，学习数据已加密保存" : "登录成功，已解锁加密学习数据");
    } catch (err) {
      status.classList.add("is-error");
      status.textContent = err.message;
    }
  }
  async function restoreAuth() {
    const token = getToken();
    if (!token) return;
    try {
      const result = await Api.authMe(token);
      state.auth.token = token;
      state.auth.user = result.user;
      applyUserData(result.user?.data || {});
    } catch (err) {
      clearToken();
      state.auth.token = "";
      state.auth.user = null;
    }
  }
  async function logout() {
    const token = state.auth.token;
    try {
      if (token) await Api.authLogout(token);
    } catch (e) {
    }
    state.auth = { token: "", user: null, registering: false };
    clearToken();
    emitDataChanged();
    toast("已退出当前账户");
  }
  function bindAuthEvents() {
    $("#btn-auth-switch").addEventListener("click", () => setAuthMode(!state.auth.registering));
    $("#btn-auth-submit").addEventListener("click", submitAuth);
    $("#auth-password").addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitAuth();
    });
    $("#auth-confirm").addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitAuth();
    });
    $("#btn-close-auth").addEventListener("click", () => $("#auth-modal").hidden = true);
    $("#auth-modal").addEventListener("click", (event) => {
      if (event.target.id === "auth-modal") $("#auth-modal").hidden = true;
    });
    if ($("#btn-auth-profile")) $("#btn-auth-profile").addEventListener("click", () => openAuthModal(false));
    $("#btn-logout-profile").addEventListener("click", logout);
  }

  // frontend/js/articles.js
  function dailyWeekInfo(value = nowIso()) {
    const date = parseStamp(value) || /* @__PURE__ */ new Date();
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const day = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - day);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const fmt = (d) => `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
    return { key: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`, label: `${fmt(start)}–${fmt(end)}` };
  }
  function migrateArticles() {
    state.articles.forEach((article) => {
      if (!article.generatedAt) article.generatedAt = article.savedAt || article.createdAt || "";
      const week = dailyWeekInfo(article.generatedAt);
      if (!article.weekKey) article.weekKey = week.key;
      if (!article.weekLabel) article.weekLabel = week.label;
      if (!article.publication) article.publication = "Zhihu English Daily";
      if (!article.genre) article.genre = "gossip";
      if (!Array.isArray(article.targetWords)) {
        article.targetWords = Array.isArray(article.story?.hooks) && article.story.hooks.length ? article.story.hooks.map((hook) => String(hook).trim()).filter(Boolean) : [];
      }
      if (article.story && !article.story.zh && article.story.cn) article.story.zh = article.story.cn;
      if (!article.language) article.language = article.story?.language === "zh" ? "zh" : "en";
      if (!article.memoryScope) article.memoryScope = article.story?.memory_scope === "recent_3d" ? "recent_3d" : "pool";
      if (!article.sorting || typeof article.sorting !== "object") article.sorting = {};
    });
  }
  function saveArticle(story, options = {}) {
    const now = nowIso();
    const week = dailyWeekInfo(now);
    const sourceCards = Array.isArray(options.cards) && options.cards.length ? options.cards : state.pool.slice(0, MAX_STORY_CARDS);
    const targetWords2 = sourceCards.slice(0, MAX_STORY_CARDS).map((word) => word.word).filter(Boolean);
    const targetCards2 = sourceCards.slice(0, MAX_STORY_CARDS).map((word) => ({
      word: word.word,
      pos: word.pos || "",
      meaning_cn: word.meaning_cn || word.meaning || "",
      meaning_en: word.meaning_en || "",
      phonetic: word.phonetic || ""
    }));
    const article = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: story.title || "知乎英语日报",
      publication: story.publication || "Zhihu English Daily",
      genre: story.genre || "gossip",
      dateline: story.dateline || "Zhihu Daily",
      weekKey: week.key,
      weekLabel: week.label,
      memoryReserve: targetWords2.length,
      language: options.language === "zh" ? "zh" : "en",
      memoryScope: options.memoryScope === "recent_3d" ? "recent_3d" : "pool",
      sorting: options.sorting && typeof options.sorting === "object" ? options.sorting : {},
      story: {
        title: story.title || "知乎英语日报",
        en: story.en || "",
        takeaway: story.takeaway || "",
        cn: story.cn || "",
        zh: story.zh || story.cn || "",
        content_en: story.content_en || story.en || "",
        content_zh: story.content_zh || story.zh || story.cn || "",
        language: options.language === "zh" ? "zh" : "en",
        memory_scope: options.memoryScope === "recent_3d" ? "recent_3d" : "pool",
        hooks: Array.isArray(story.hooks) ? story.hooks : [],
        publication: story.publication || "Zhihu English Daily",
        genre: story.genre || "gossip",
        dateline: story.dateline || "Zhihu Daily",
        source_note: story.source_note || "来源：Bookwords 本地存档（历史文章未记录来源）",
        source_url: story.source_url || "",
        source_type: story.source_type || "original",
        disclaimer: story.disclaimer || ""
      },
      targetWords: targetWords2,
      targetCards: targetCards2,
      createdAt: now,
      generatedAt: now,
      updatedAt: now,
      savedAt: now,
      completedAt: ""
    };
    state.articles.unshift(article);
    state.lastArticleId = article.id;
    persist();
    emit("articles");
    return article;
  }
  function markArticleCompleted() {
    const article = state.articles.find((item) => item.id === state.lastArticleId);
    if (!article) return;
    const now = nowIso();
    if (!article.completedAt) article.completedAt = now;
    article.lastPracticedAt = now;
    article.updatedAt = now;
    persist();
    emit("articles");
  }
  function deleteArticle(articleId) {
    const id = String(articleId || "");
    const index = state.articles.findIndex((article) => article.id === id);
    if (index < 0) return false;
    state.articles.splice(index, 1);
    for (const period of ["week", "month"]) {
      const selections = state.periodicalSelections?.[period] || {};
      Object.keys(selections).forEach((key) => {
        selections[key] = (selections[key] || []).filter((selectedId) => selectedId !== id);
        if (!selections[key].length) delete selections[key];
      });
    }
    if (state.lastArticleId === id) {
      state.lastArticleId = state.articles[0]?.id || "";
      state.lastStory = state.articles[0]?.story || null;
    }
    persist();
    emit("articles");
    return true;
  }
  function activeArticle() {
    return state.articles.find((item) => item.id === state.lastArticleId) || state.articles.find((item) => (item.weekKey || dailyWeekInfo(item.generatedAt).key) === dailyWeekInfo().key) || state.articles[0] || null;
  }
  function articlesOfWeek(weekKey) {
    return state.articles.filter((item) => (item.weekKey || dailyWeekInfo(item.generatedAt).key) === weekKey).sort((a, b) => String(a.generatedAt || "").localeCompare(String(b.generatedAt || "")));
  }
  function currentWeekArticles() {
    return articlesOfWeek(dailyWeekInfo().key);
  }
  function weekGroups() {
    const groups = /* @__PURE__ */ new Map();
    state.articles.forEach((item) => {
      const key = item.weekKey || dailyWeekInfo(item.generatedAt).key;
      if (!groups.has(key)) groups.set(key, { weekKey: key, weekLabel: item.weekLabel || dailyWeekInfo(item.generatedAt).label, articles: [] });
      groups.get(key).articles.push(item);
    });
    return Array.from(groups.values()).map((g) => ({ ...g, articles: g.articles.sort((a, b) => String(a.generatedAt || "").localeCompare(String(b.generatedAt || ""))) })).sort((a, b) => b.weekKey.localeCompare(a.weekKey));
  }
  function weekWordCount(weekKey) {
    const set = /* @__PURE__ */ new Set();
    articlesOfWeek(weekKey).forEach((a) => (a.targetWords || []).forEach((w) => w && set.add(String(w).toLowerCase())));
    return set.size;
  }
  function monthGroups() {
    const groups = /* @__PURE__ */ new Map();
    state.articles.forEach((article) => {
      const date = parseStamp(article.generatedAt || article.savedAt);
      if (!date) return;
      const key = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
      if (!groups.has(key)) groups.set(key, { key, label: `${date.getFullYear()}年${date.getMonth() + 1}月`, articles: [] });
      groups.get(key).articles.push(article);
    });
    return Array.from(groups.values()).sort((a, b) => b.key.localeCompare(a.key));
  }
  function localPeriodicalGroups(period) {
    const raw = period === "month" ? monthGroups() : weekGroups().map((group) => ({ key: group.weekKey, label: group.weekLabel, articles: group.articles }));
    return raw.map((group) => {
      const words = /* @__PURE__ */ new Set();
      const themes = /* @__PURE__ */ new Map();
      const sources = /* @__PURE__ */ new Map();
      group.articles.forEach((article) => {
        (article.targetWords || []).forEach((word) => word && words.add(String(word).toLowerCase()));
        const selected = article.sorting?.selected_group || {};
        const theme = selected.theme || genreLabel(article.genre);
        if (!themes.has(theme)) themes.set(theme, /* @__PURE__ */ new Set());
        (selected.words || article.targetWords || []).forEach((word) => word && themes.get(theme).add(word));
        const source = article.story?.source_type || "original";
        sources.set(source, (sources.get(source) || 0) + 1);
      });
      return {
        ...group,
        articleCount: group.articles.length,
        wordCount: words.size,
        themes: Array.from(themes, ([name, values]) => ({ name, words: Array.from(values) })),
        sources: Object.fromEntries(sources)
      };
    });
  }
  function genreLabel(genre) {
    return { "daily-science": "知乎日常科普", "daily-curiosity": "知乎冷知识", "light-entertainment": "轻娱乐观察", gossip: "知乎日常科普", "odd-fact": "知乎冷知识", "fictional-breaking": "轻娱乐观察" }[genre] || "本期选题";
  }
  function genreLabelEn(genre) {
    return { "daily-science": "DAILY SCIENCE", "daily-curiosity": "DAILY CURIOSITY", "light-entertainment": "LIGHT ENTERTAINMENT", gossip: "DAILY SCIENCE", "odd-fact": "DAILY CURIOSITY", "fictional-breaking": "LIGHT ENTERTAINMENT" }[genre] || "TODAY'S TOPIC";
  }

  // frontend/js/newspaper/markup.js
  function newspaperMarkup(article) {
    const story = article?.story || {};
    const sourceNote = story.source_note || "来源：Bookwords 本地存档（历史文章未记录来源）";
    const targets = Array.isArray(article?.targetWords) ? article.targetWords.filter(Boolean) : [];
    return `
    <article class="newspaper-page">
      <header class="newspaper-masthead">
        <div class="newspaper-masthead-top"><span>ZHIHU ENGLISH DAILY</span><span>${esc(article?.weekLabel || dailyWeekInfo(article?.generatedAt).label)} · ${esc(genreLabelEn(article?.genre))}</span></div>
        <div class="newspaper-nameplate">ZHIHU ENGLISH DAILY</div>
      <div class="newspaper-dateline">LEARNING EDITION · ${esc(genreLabelEn(article?.genre))} · ZHIHU LEARNING DESK</div>
      </header>
      <div class="newspaper-grid">
        <section class="newspaper-lead">
          <p class="newspaper-kicker">${esc(genreLabelEn(article?.genre))} · Zhihu REPORT</p>
          <h1>${esc(story.title || article?.title || "Zhihu English Daily")}</h1>
          <p class="newspaper-byline">By the Zhihu Freelance Desk</p>
          <div class="newspaper-rule"></div>
          <div class="newspaper-en">${formatBold(story.en || "")}</div>
          ${story.takeaway ? `<aside class="newspaper-takeaway"><b>TAKEAWAY</b><span>${esc(story.takeaway)}</span></aside>` : ""}
          ${story.zh || story.cn ? `<section class="newspaper-translation"><p class="newspaper-kicker">中文翻译</p><div>${formatBold(story.zh || story.cn).replace(/\n/g, "<br>")}</div></section>` : ""}
          <p class="newspaper-source-note">${esc(sourceNote)}</p>
        </section>
        <aside class="newspaper-sidebar">
          <div class="newspaper-box newspaper-box-highlight"><span class="newspaper-box-label">THE MEMORY DESK</span><strong>${targets.length}</strong><small>WORDS STOCKED THIS WEEK</small></div>
        </aside>
      </div>
      <footer class="newspaper-footer"><span>Zhihu Daily</span><span>ISSUE ${esc(article?.weekLabel || dailyWeekInfo(article?.generatedAt).label)}</span></footer>
    </article>`;
  }
  function paperParagraphs(text) {
    return formatBold(String(text || "")).split(/\n{2,}/).map((part) => part.trim()).filter(Boolean).map((part) => `<p>${part.replace(/\n/g, "<br>")}</p>`).join("");
  }
  function bookPage(bodyHtml, folioLabel, attrs = "") {
    const folio = folioLabel ? `<div class="paper-folio"><span>ZHIHU ENGLISH DAILY</span><span>${esc(folioLabel)}</span></div>` : "";
    return `
    <section class="book-page"${attrs}>
      <div class="page-face page-face-front">${bodyHtml}${folio}</div>
      <div class="page-face page-face-back"><span class="page-back-stamp">ZHIHU ENGLISH DAILY · ZHIHU LEARNING DESK</span></div>
    </section>`;
  }
  function newspaperIssueCoverBody(articles) {
    const list = (articles || []).filter(Boolean);
    const weekLabel = list[0]?.weekLabel || dailyWeekInfo(list[0]?.generatedAt).label;
    const volBase = Date.parse(list[0]?.weekKey || "");
    const vol = Number.isFinite(volBase) ? Math.max(1, Math.round((volBase - Date.parse("2026-01-05")) / 6048e5) + 1) : 1;
    const targets = /* @__PURE__ */ new Set();
    list.forEach((a) => (a.targetWords || []).forEach((w) => w && targets.add(String(w).toLowerCase())));
    const lines = list.slice(0, 3).map((a) => `<span>${esc(a.story?.title || a.title || "")}</span>`).join("");
    return `
    <div class="mag-mini-cover" aria-label="The Zhihu Review, ${list.length} stories">
      <div class="mag-mini-top"><span>VOL.${String(vol).padStart(2, "0")}</span><span>${esc(weekLabel)}</span></div>
      <div class="mag-mini-mast">The Zhihu Review</div>
      <p class="mag-mini-sub">ZHIHU LEARNING DESK · ENGLISH EDITION</p>
      <div class="mag-mini-orn"><span></span><i>✦</i><span></span></div>
      <div class="mag-mini-lines">${lines || "<span>This issue is being prepared…</span>"}</div>
      <div class="mag-mini-foot"><span>${list.length} ${list.length > 1 ? "STORIES" : "STORY"}</span><span>${targets.size} TARGET WORDS</span><span>OPEN →</span></div>
    </div>`;
  }
  function issuePages(articles) {
    const list = (articles || []).filter(Boolean);
    const pages = [bookPage(articleCoverBody(list), null)];
    list.forEach((article, i) => pages.push(articleFrontPage(article, i, list.length)));
    return pages;
  }
  function articleCoverBody(articles) {
    const list = (articles || []).filter(Boolean);
    return `
    <div class="paper-cover-frame paper-cover-minimal" aria-label="Zhihu English Daily${list.length ? `, ${list.length} stories` : ""}">
      <div class="paper-cover-wordmark">
        <span>ZHIHU</span>
        <span>ENGLISH</span>
        <span>DAILY</span>
      </div>
    </div>`;
  }
  function articleFrontPage(article, articleIdx, articleCount) {
    const story = article?.story || {};
    const sourceNote = story.source_note || "来源：Bookwords 本地存档（历史文章未记录来源）";
    const targets = Array.isArray(article?.targetWords) ? article.targetWords.filter(Boolean) : [];
    const weekLabel = esc(article?.weekLabel || dailyWeekInfo(article?.generatedAt).label);
    const storyNo = articleCount > 1 ? `STORY ${articleIdx + 1}/${articleCount} · ` : "";
    return bookPage(`
    <section class="newspaper-page">
      <header class="newspaper-masthead">
        <div class="newspaper-masthead-top"><span>ZHIHU ENGLISH DAILY</span><span>${weekLabel} · ${esc(genreLabelEn(article?.genre))}</span></div>
        <div class="newspaper-nameplate">ZHIHU ENGLISH DAILY</div>
        <div class="newspaper-dateline">${esc(story.dateline || article?.dateline || "Zhihu Daily")} · ZHIHU LEARNING DESK</div>
      </header>
      <div class="newspaper-grid">
        <section class="newspaper-lead">
          <p class="newspaper-kicker">${esc(genreLabelEn(article?.genre))} · Zhihu REPORT</p>
          <h1>${esc(story.title || article?.title || "Zhihu English Daily")}</h1>
          <p class="newspaper-byline">By the Zhihu Freelance Desk</p>
          <div class="newspaper-rule"></div>
          <div class="newspaper-en">${paperParagraphs(story.en)}</div>
          ${story.takeaway ? `<aside class="newspaper-takeaway"><b>TAKEAWAY</b><span>${esc(story.takeaway)}</span></aside>` : ""}
          <p class="newspaper-source-note">${esc(sourceNote)}</p>
        </section>
      </div>
    </section>
    <div class="paper-gloss" data-gloss="words" hidden>
      <div class="paper-gloss-card">
        <p class="newspaper-kicker">THIS STORY · KEY WORDS</p>
        <div class="paper-gloss-words">${targets.length ? targets.map((word) => `<span>${esc(word)}</span>`).join("") : "<small>No target words</small>"}</div>
      </div>
    </div>`, `FRONT PAGE${articleCount > 1 ? ` · STORY ${articleIdx + 1}` : ""}`, ` data-article-idx="${articleIdx}"`);
  }

  // frontend/js/newspaper/pagination.js
  function measureRunhead(pageEl) {
    const probe = document.createElement("div");
    probe.className = "page-face";
    probe.style.cssText = "position: fixed; left: -9999px; top: 0; visibility: hidden; width: " + pageEl.clientWidth + "px;";
    probe.innerHTML = '<section class="newspaper-page"><header class="newspaper-runhead"><span>ZHIHU ENGLISH DAILY</span><span>CONT. · FRONT PAGE</span></header></section>';
    document.body.appendChild(probe);
    const head = probe.querySelector(".newspaper-runhead");
    const h = head ? head.offsetHeight + (parseFloat(getComputedStyle(head).marginBottom) || 0) : 0;
    probe.remove();
    return h;
  }
  function paginateFrontPages(articles) {
    const list = Array.isArray(articles) ? articles : [articles];
    list.forEach((article, i) => paginateArticle(article, i, list.length));
  }
  function paginateArticle(article, articleIdx, articleCount) {
    const candidates = Array.from(document.querySelectorAll(`#newspaper-body .book-page[data-article-idx="${articleIdx}"]`));
    const origPage = candidates.find((p) => p.querySelector(".newspaper-page"));
    if (!origPage) return;
    const face = origPage.querySelector(".page-face-front");
    const pageEl = face ? face.querySelector(".newspaper-page") : null;
    const en = pageEl ? pageEl.querySelector(".newspaper-en") : null;
    if (!pageEl || !en) return;
    const ps = Array.from(en.querySelectorAll("p"));
    if (!ps.length) return;
    const allPages = Array.from(document.querySelectorAll("#newspaper-body .book-page"));
    const pageOffset = Math.max(1, allPages.indexOf(origPage));
    const cs = getComputedStyle(pageEl);
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const folio = face.querySelector(".paper-folio");
    const folioH = folio ? folio.offsetHeight : 0;
    const chromeFull = en.offsetTop - pageEl.offsetTop;
    const runheadH = measureRunhead(pageEl);
    const availPage0 = Math.max(1, Math.floor(face.clientHeight - folioH - chromeFull - padBottom - 30));
    const availCont = Math.max(1, Math.floor(face.clientHeight - folioH - runheadH - padBottom - 30));
    const paragraphChunks = (p, size = 8) => {
      const tokens = [];
      p.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          tokens.push(...String(node.textContent || "").trim().split(/\s+/).filter(Boolean).map(esc));
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          tokens.push(node.outerHTML);
        }
      });
      if (!tokens.length) return [p.innerHTML];
      const chunks = [];
      for (let i = 0; i < tokens.length; i += size) chunks.push(tokens.slice(i, i + size).join(" "));
      return chunks;
    };
    const frags = [];
    ps.forEach((p, pid) => {
      const parts = paragraphChunks(p);
      parts.forEach((part, si) => frags.push({ pid, cont: si > 0, html: part }));
    });
    const colGap = parseFloat(getComputedStyle(en).columnGap) || 30;
    const colW = Math.max(60, (en.clientWidth - colGap) / 2);
    const probe = document.createElement("div");
    probe.className = "newspaper-en pagination-probe";
    probe.lang = "en";
    probe.style.width = colW + "px";
    document.body.appendChild(probe);
    const capPage0 = Math.max(1, availPage0 * 2 - 28);
    const capCont = Math.max(1, availCont * 2 - 28);
    const groupBody = (group) => {
      let body = "";
      let j = 0;
      while (j < group.length) {
        const f = frags[group[j]];
        let para = f.html;
        let k = j + 1;
        while (k < group.length && frags[group[k]].pid === f.pid) {
          para += " " + frags[group[k]].html;
          k++;
        }
        body += `<p${f.cont ? ' style="text-indent:0"' : ""}>${para}</p>`;
        j = k;
      }
      return body;
    };
    const slotUsed = (slot, isFirst = false) => {
      probe.classList.toggle("is-cont", !isFirst);
      probe.innerHTML = groupBody(slot);
      return probe.scrollHeight;
    };
    const slots = [];
    let cur = [];
    for (let i = 0; i < frags.length; i++) {
      const budget = slots.length === 0 ? capPage0 : capCont;
      if (cur.length && slotUsed(cur.concat(i), slots.length === 0) > budget) {
        slots.push(cur);
        cur = [i];
      } else {
        cur.push(i);
      }
    }
    if (cur.length) slots.push(cur);
    if (slots.length === 1) {
      en.classList.add("is-double");
      const folioText = folio?.querySelectorAll("span");
      if (folioText?.length >= 2) {
        folioText[0].textContent = `ISSUE ${article?.weekLabel || dailyWeekInfo(article?.generatedAt).label}`;
        folioText[1].textContent = `PAGE ${pageOffset}${articleCount > 1 ? ` · STORY ${articleIdx + 1}/${articleCount}` : ""}`;
      }
      probe.remove();
      return;
    }
    probe.remove();
    const story = article?.story || {};
    const sourceNote = esc(story.source_note || "来源：Bookwords 本地存档（历史文章未记录来源）");
    const targets = Array.isArray(article?.targetWords) ? article.targetWords.filter(Boolean) : [];
    const weekLabel = esc(article?.weekLabel || dailyWeekInfo(article?.generatedAt).label);
    const genreHtml = esc(genreLabelEn(article?.genre));
    const title = esc(story.title || article?.title || "Zhihu English Daily");
    const holder = document.createElement("div");
    let html = "";
    slots.forEach((group, gi) => {
      const body = groupBody(group);
      const isFirst = gi === 0;
      const pageNumber = pageOffset + gi;
      const gloss = isFirst ? `
      <div class="paper-gloss" data-gloss="words" hidden>
        <div class="paper-gloss-card">
          <p class="newspaper-kicker">THIS ISSUE · KEY WORDS</p>
          <div class="paper-gloss-words">${targets.length ? targets.map((word) => `<span>${esc(word)}</span>`).join("") : "<small>No target words</small>"}</div>
        </div>
      </div>` : "";
      const headHtml = isFirst ? `<header class="newspaper-masthead">
          <div class="newspaper-masthead-top"><span>ZHIHU ENGLISH DAILY</span><span>${weekLabel} · ${genreHtml}</span></div>
          <div class="newspaper-nameplate">ZHIHU ENGLISH DAILY</div>
         <div class="newspaper-dateline">LEARNING EDITION · ${genreHtml} · ZHIHU LEARNING DESK</div>
        </header>` : `<header class="newspaper-runhead"><span>${genreHtml} · CONTINUED</span></header>`;
      const attribution = gi === slots.length - 1 ? `<p class="newspaper-source-note">${sourceNote}</p>` : "";
      const leadHtml = isFirst ? `<section class="newspaper-lead">
          <p class="newspaper-kicker">${genreHtml} · Zhihu REPORT</p>
          <h1>${title}</h1>
          <p class="newspaper-byline">By the Zhihu Freelance Desk</p>
          <div class="newspaper-rule"></div>
          <div class="newspaper-en is-double" lang="en">${body}</div>${attribution}
        </section>` : `<section class="newspaper-lead">
          <div class="newspaper-en is-cont is-double" lang="en">${body}</div>${attribution}
        </section>`;
      html += `
    <section class="book-page" data-article-idx="${articleIdx}">
      <div class="page-face page-face-front">
        <section class="newspaper-page">
          ${headHtml}
          <div class="newspaper-grid">
            ${leadHtml}
          </div>
        </section>
        <div class="paper-folio"><span>ISSUE ${weekLabel}</span><span>PAGE ${pageNumber}${articleCount > 1 ? ` · STORY ${articleIdx + 1}/${articleCount}` : ""}</span></div>
        ${gloss}
      </div>
      <div class="page-face page-face-back"><span class="page-back-stamp">ZHIHU ENGLISH DAILY · ZHIHU LEARNING DESK</span></div>
    </section>`;
    });
    holder.innerHTML = html;
    origPage.replaceWith(...Array.from(holder.childNodes));
  }

  // frontend/js/newspaper/magazine.js
  var MONTHS_EN = [
    "JANUARY",
    "FEBRUARY",
    "MARCH",
    "APRIL",
    "MAY",
    "JUNE",
    "JULY",
    "AUGUST",
    "SEPTEMBER",
    "OCTOBER",
    "NOVEMBER",
    "DECEMBER"
  ];
  function articleWords(article) {
    const en = String(article?.story?.en || "");
    return (en.match(/[A-Za-z0-9'’-]+/g) || []).length;
  }
  function articleSentences(article) {
    return String(article?.story?.en || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z"“'(])/).map((s) => s.trim()).filter(Boolean);
  }
  function articleDek(article) {
    const takeaway = String(article?.story?.takeaway || "").trim();
    const latin = (takeaway.match(/[A-Za-z]/g) || []).length;
    if (takeaway && latin >= takeaway.length * 0.5) return takeaway;
    const first = articleSentences(article)[0] || "";
    return first.length > 150 ? `${first.slice(0, 147).trimEnd()}…` : first;
  }
  function articlePull(article) {
    const s = articleSentences(article)[1] || "";
    const words = (s.match(/[A-Za-z0-9'’-]+/g) || []).length;
    return s && words >= 8 && words <= 32 ? s : "";
  }
  function articleMinutes(words) {
    return Math.max(1, Math.round(words / 200));
  }
  function articleTargets(article) {
    return Array.isArray(article?.targetWords) ? article.targetWords.filter(Boolean) : [];
  }
  function issueLabel(meta, articles) {
    if (meta?.period === "month" && /^\d{4}-\d{2}$/.test(meta.key || "")) {
      const [y, m] = meta.key.split("-").map(Number);
      return `${MONTHS_EN[m - 1]} ${y}`;
    }
    return articles[0]?.weekLabel || dailyWeekInfo(articles[0]?.generatedAt).label;
  }
  function issueVol(meta, articles) {
    if (meta?.period === "month" && /^\d{4}-\d{2}$/.test(meta.key || "")) {
      const [y, m] = meta.key.split("-").map(Number);
      return Math.max(1, (y - 2026) * 12 + m);
    }
    const key = articles[0]?.weekKey || dailyWeekInfo(articles[0]?.generatedAt).key;
    const base = Date.parse(key || "");
    return Number.isFinite(base) ? Math.max(1, Math.round((base - Date.parse("2026-01-05")) / 6048e5) + 1) : 1;
  }
  function genImage(prompt, size) {
    return `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodeURIComponent(prompt)}&image_size=${size}`;
  }
  var GENRE_SCENE = {
    "daily-science": "everyday science wonders on a study desk",
    "daily-curiosity": "curious mind exploring strange little facts",
    "light-entertainment": "playful pop culture scene with stars"
  };
  function articleHero(article) {
    const title = String(article?.story?.title || article?.title || "").slice(0, 90);
    const scene = GENRE_SCENE[article?.genre] || "quiet reading corner with books";
    return genImage(
      `flat editorial magazine illustration, ${scene}, about ${title}, limited palette of cobalt blue, sky blue and pure white, bold flat shapes, risograph print grain, vintage poster art, elegant, no text`,
      "landscape_16_9"
    );
  }
  function issueCoverImage(meta, articles) {
    const label = issueLabel(meta, articles);
    return genImage(
      `flat editorial magazine cover illustration, tall stack of books and an open magazine with a lighthouse, sea of clouds, limited palette of cobalt blue, sky blue and pure white, bold flat shapes, risograph print grain, vintage poster art, elegant, no text, ${label}`,
      "portrait_4_3"
    );
  }
  var MAG_PERIOD_NOUN = (meta) => meta?.period === "month" ? "month" : "week";
  function magCoverHtml(articles, meta) {
    const list = (articles || []).filter(Boolean);
    const label = issueLabel(meta, list);
    const vol = issueVol(meta, list);
    const words = /* @__PURE__ */ new Set();
    list.forEach((a) => articleTargets(a).forEach((w) => w && words.add(String(w).toLowerCase())));
    const lines = list.slice(0, 3).map((a, i) => `
    <li class="mag-cover-line" data-goto-page="cover" data-mag-article="${i}">
      <span class="mag-cover-line-no">0${i + 1}</span>
      <span class="mag-cover-line-title">${esc(a.story?.title || a.title || "")}</span>
      <span class="mag-cover-line-page" data-mag-ref="${i}">—</span>
    </li>`).join("");
    return `
    <div class="mag-cover">
      <header class="mag-cover-top">
        <span class="mag-cover-vol">VOL.${String(vol).padStart(2, "0")} · ${esc(label)}</span>
        <span class="mag-cover-edition">${meta?.period === "month" ? "MONTHLY EDITION" : "WEEKLY EDITION"}</span>
      </header>
      <div class="mag-cover-mast">The Zhihu Review</div>
      <p class="mag-cover-sub">ZHIHU LEARNING DESK · ENGLISH EDITION · YOUR ${MAG_PERIOD_NOUN(meta).toUpperCase()}, IN PLAIN ENGLISH</p>
      <figure class="mag-cover-figure"><img src="${issueCoverImage(meta, list)}" alt="Issue cover illustration in cobalt blue and white"></figure>
      <ul class="mag-cover-lines">${lines || "<li class='mag-cover-line'><span class='mag-cover-line-title'>This issue is being prepared…</span></li>"}</ul>
      <footer class="mag-cover-foot">
        <span>${list.length} ${list.length > 1 ? "STORIES" : "STORY"} · ${words.size} TARGET WORDS</span>
        <span class="mag-cover-cta">OPEN THE ISSUE →</span>
      </footer>
    </div>`;
  }
  function magTocHtml(articles, meta) {
    const list = (articles || []).filter(Boolean);
    const rows = list.map((a, i) => {
      const words = articleWords(a);
      const tier = words <= 300 ? "brief" : "feature";
      return `
    <li class="mag-toc-row" data-goto-page="toc" data-mag-article="${i}">
      <span class="mag-toc-no">${String(i + 1).padStart(2, "0")}</span>
      <div class="mag-toc-main">
        <h3>${esc(a.story?.title || a.title || "")}</h3>
        <p>${esc(articleDek(a))} — By the Zhihu Freelance Desk</p>
      </div>
      <div class="mag-toc-meta">
        <span class="mag-chip mag-chip-${tier}">${tier === "brief" ? "BRIEF" : "FEATURE"}</span>
        <span>${words} W</span>
        <span class="mag-toc-page" data-mag-ref="${i}">—</span>
      </div>
    </li>`;
    }).join("");
    return `
    <div class="mag-toc">
      <header class="mag-toc-head">
        <p class="mag-kicker">IN THIS ISSUE · ${esc(issueLabel(meta, list))}</p>
        <h2 class="mag-toc-title">Contents</h2>
        <div class="mag-toc-legend">
          <span class="mag-chip mag-chip-brief">BRIEF · 2 COLUMNS · ≤300 WORDS</span>
          <span class="mag-chip mag-chip-feature">FEATURE · 3 COLUMNS · 301+ WORDS</span>
        </div>
      </header>
      <ol class="mag-toc-list">${rows}</ol>
      <footer class="mag-toc-foot"><span>THE ZHIHU REVIEW</span><span>EDITED IN A SMALL ROOM WITH GOOD LIGHT</span></footer>
    </div>`;
  }
  function magArticleFirstInner(article, articleIdx, articleCount, meta) {
    const story = article?.story || {};
    const words = articleWords(article);
    const tier = words <= 300 ? "brief" : "feature";
    const genre = esc(genreLabelEn(article?.genre));
    const title = esc(story.title || article?.title || "Zhihu English Daily");
    const pull = articlePull(article);
    const hero = tier === "feature" ? `<figure class="mag-hero"><img src="${articleHero(article)}" alt="${esc(story.title || "")} illustration"></figure>` : "";
    const pullHtml = tier === "feature" && pull ? `<aside class="mag-pull">${esc(pull)}</aside>` : "";
    return `
    <section class="mag-article mag-tier-${tier}" lang="en">
      <header class="mag-head">
        <span class="mag-spec mag-spec-${tier}">${tier === "brief" ? "BRIEF · TWO COLUMNS" : "FEATURE SPREAD · THREE COLUMNS"} — ${words} WORDS</span>
        <p class="mag-kicker">${genre} · ZHIHU REPORT${articleCount > 1 ? ` · STORY ${articleIdx + 1}/${articleCount}` : ""}</p>
        <h1 class="mag-title">${title}</h1>
        <p class="mag-dek">${esc(articleDek(article))}</p>
        <p class="mag-byline">By the Zhihu Freelance Desk · ${articleMinutes(words)} MIN READ</p>
        ${pullHtml}
      </header>
      <div class="mag-en">${paperParagraphs(story.en)}</div>
    </section>`;
  }
  function magArticleContInner(article, tier, genreHtml) {
    return `
    <section class="mag-article mag-tier-${tier}" lang="en">
      <header class="mag-runhead"><span>${genreHtml} · CONTINUED</span><span>THE ZHIHU REVIEW</span></header>
      <div class="mag-en"></div>
    </section>`;
  }
  function magArticleFirstPage(article, articleIdx, articleCount, meta) {
    return bookPage(
      magArticleFirstInner(article, articleIdx, articleCount, meta),
      `ISSUE ${esc(issueLabel(meta, [article]))}`,
      ` data-mag-idx="${articleIdx}"`
    );
  }
  function issueMagazinePages(articles, meta = {}) {
    const list = (articles || []).filter(Boolean);
    const pages = [bookPage(magCoverHtml(list, meta), null)];
    pages.push(bookPage(magTocHtml(list, meta), `ISSUE ${esc(issueLabel(meta, list))}`));
    list.forEach((article, i) => pages.push(magArticleFirstPage(article, i, list.length, meta)));
    return pages;
  }
  function measureMagRunhead(width) {
    const probe = document.createElement("div");
    probe.className = "page-face";
    probe.style.cssText = `position: fixed; left: -9999px; top: 0; visibility: hidden; width: ${width}px;`;
    probe.innerHTML = '<section class="mag-article mag-tier-feature"><header class="mag-runhead"><span>GENRE · CONTINUED</span><span>THE ZHIHU REVIEW</span></header></section>';
    document.body.appendChild(probe);
    const head = probe.querySelector(".mag-runhead");
    const h = head ? head.offsetHeight + (parseFloat(getComputedStyle(head).marginBottom) || 0) : 0;
    probe.remove();
    return h;
  }
  function paginateMagazine(articles, meta = {}) {
    const list = (articles || []).filter(Boolean);
    const refs = [];
    list.forEach((article, articleIdx) => {
      const origPage = document.querySelector(`#newspaper-body .book-page[data-mag-idx="${articleIdx}"]`);
      if (!origPage) return;
      const face = origPage.querySelector(".page-face-front");
      const pageEl = face ? face.querySelector(".mag-article") : null;
      const en = pageEl ? pageEl.querySelector(".mag-en") : null;
      const ps = en ? Array.from(en.querySelectorAll("p")) : [];
      if (!pageEl || !en || !ps.length) return;
      const story = article?.story || {};
      const words = articleWords(article);
      const tier = words <= 300 ? "brief" : "feature";
      const cols = tier === "brief" ? 2 : 3;
      const genre = esc(genreLabelEn(article?.genre));
      const label = esc(issueLabel(meta, [article]));
      const allPages = Array.from(document.querySelectorAll("#newspaper-body .book-page"));
      const pageOffset = Math.max(1, allPages.indexOf(origPage));
      refs[articleIdx] = pageOffset;
      const cs = getComputedStyle(pageEl);
      const padBottom = parseFloat(cs.paddingBottom) || 0;
      const folio = face.querySelector(".paper-folio");
      const folioH = folio ? folio.offsetHeight : 0;
      const chromeFull = en.offsetTop - pageEl.offsetTop;
      const runheadH = measureMagRunhead(face.clientWidth);
      const availPage0 = Math.max(1, Math.floor(face.clientHeight - folioH - chromeFull - padBottom - 30));
      const availCont = Math.max(1, Math.floor(face.clientHeight - folioH - runheadH - padBottom - 30));
      const paragraphChunks = (p, size = 8) => {
        const tokens = [];
        p.childNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            tokens.push(...String(node.textContent || "").trim().split(/\s+/).filter(Boolean).map(esc));
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            tokens.push(node.outerHTML);
          }
        });
        if (!tokens.length) return [p.innerHTML];
        const chunks = [];
        for (let i = 0; i < tokens.length; i += size) chunks.push(tokens.slice(i, i + size).join(" "));
        return chunks;
      };
      const frags = [];
      ps.forEach((p, pid) => {
        paragraphChunks(p).forEach((part, si) => frags.push({ pid, cont: si > 0, html: part }));
      });
      const colGap = parseFloat(getComputedStyle(en).columnGap) || 26;
      const colW = Math.max(60, (en.clientWidth - colGap * (cols - 1)) / cols);
      const probe = document.createElement("div");
      probe.className = `mag-en mag-tier-${tier} pagination-probe`;
      probe.lang = "en";
      probe.style.width = colW + "px";
      document.body.appendChild(probe);
      const capPage0 = Math.max(1, availPage0 * cols - 14 * cols);
      const capCont = Math.max(1, availCont * cols - 14 * cols);
      const groupBody = (group) => {
        let body = "";
        let j = 0;
        while (j < group.length) {
          const f = frags[group[j]];
          let para = f.html;
          let k = j + 1;
          while (k < group.length && frags[group[k]].pid === f.pid) {
            para += " " + frags[group[k]].html;
            k++;
          }
          body += `<p${f.cont ? ' style="text-indent:0"' : ""}>${para}</p>`;
          j = k;
        }
        return body;
      };
      const slotUsed = (slot, isFirst = false) => {
        probe.classList.toggle("is-cont", !isFirst);
        probe.innerHTML = groupBody(slot);
        return probe.scrollHeight;
      };
      const slots = [];
      let cur = [];
      for (let i = 0; i < frags.length; i++) {
        const budget = slots.length === 0 ? capPage0 : capCont;
        if (cur.length && slotUsed(cur.concat(i), slots.length === 0) > budget) {
          slots.push(cur);
          cur = [i];
        } else {
          cur.push(i);
        }
      }
      if (cur.length) slots.push(cur);
      probe.remove();
      const sourceNote = esc(story.source_note || "来源：Bookwords 本地存档（历史文章未记录来源）");
      const title = esc(story.title || article?.title || "Zhihu English Daily");
      const holder = document.createElement("div");
      let html = "";
      slots.forEach((group, gi) => {
        const body = groupBody(group);
        const isFirst = gi === 0;
        const pageNumber = pageOffset + gi;
        const isLast = gi === slots.length - 1;
        const inner = isFirst ? magArticleFirstInner(article, articleIdx, list.length, meta) : magArticleContInner(article, tier, genre);
        const finalInner = isFirst ? inner : inner.replace('<div class="mag-en"></div>', `<div class="mag-en is-cont">${body}</div>`);
        const attribution = isLast ? `<p class="mag-source">${sourceNote}</p>` : "";
        const articleHtml = isLast ? finalInner.replace("</section>", `${attribution}</section>`) : finalInner;
        html += `
    <section class="book-page" data-mag-idx="${articleIdx}">
      <div class="page-face page-face-front">${articleHtml}
        <div class="paper-folio"><span>THE ZHIHU REVIEW · ${label}</span><span>PAGE ${pageNumber}</span></div>
      </div>
      <div class="page-face page-face-back"><span class="page-back-stamp">THE ZHIHU REVIEW · ZHIHU LEARNING DESK</span></div>
    </section>`;
      });
      holder.innerHTML = html;
      origPage.replaceWith(...Array.from(holder.childNodes));
    });
    document.querySelectorAll("#newspaper-body [data-mag-ref]").forEach((node) => {
      const idx = parseInt(node.dataset.magRef, 10);
      if (Number.isFinite(idx) && refs[idx] != null) {
        node.textContent = `P. ${String(refs[idx]).padStart(2, "0")}`;
        const row = node.closest("[data-goto-page]");
        if (row) row.dataset.gotoPage = String(refs[idx]);
      }
    });
  }

  // frontend/js/newspaper/reader.js
  var paperIndex = 0;
  var paperTurning = false;
  var currentOpen = null;
  function paperPages() {
    return Array.from(document.querySelectorAll("#newspaper-body .book-page"));
  }
  function paperFlipDuration() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 880;
  }
  function sizeBook() {
    const wrap = document.querySelector(".book-wrap");
    const book = document.querySelector(".book");
    if (!wrap || !book) return;
    const w = wrap.clientWidth - 24;
    const h = wrap.clientHeight - 24;
    if (w <= 0 || h <= 0) return;
    let bw = h * 210 / 297;
    if (bw > w) bw = w;
    const bh = bw * 297 / 210;
    book.style.width = bw.toFixed(1) + "px";
    book.style.height = bh.toFixed(1) + "px";
  }
  function resetPaperPages(pages) {
    (pages || paperPages()).forEach((page, i) => {
      page.classList.remove("is-anim", "is-flipped");
      page.style.zIndex = "1";
      page.style.visibility = i === paperIndex ? "visible" : "hidden";
    });
  }
  function applyPaperIndicator() {
    const pages = paperPages();
    if (!pages.length) return;
    const indicator = $("#paper-page-indicator");
    if (indicator) indicator.textContent = paperIndex === 0 ? "COVER" : `PAGE ${paperIndex} / ${pages.length - 1}`;
    const prev = $("#paper-prev");
    const next = $("#paper-next");
    if (prev) prev.disabled = paperTurning || paperIndex <= 0;
    if (next) next.disabled = paperTurning || paperIndex >= pages.length - 1;
  }
  function paperGo(delta) {
    const pages = paperPages();
    const target = paperIndex + delta;
    if (paperTurning || target < 0 || target >= pages.length) return;
    const dur = paperFlipDuration();
    if (!dur) {
      paperIndex = target;
      resetPaperPages(pages);
      applyPaperIndicator();
      return;
    }
    paperTurning = true;
    applyPaperIndicator();
    const forward = delta > 0;
    const mover = pages[forward ? paperIndex : target];
    const under = pages[forward ? target : paperIndex];
    pages.forEach((page) => {
      page.style.zIndex = page === mover ? "30" : page === under ? "10" : "1";
      page.style.visibility = page === mover || page === under ? "visible" : "hidden";
    });
    mover.classList.add("is-anim");
    if (forward) {
      requestAnimationFrame(() => requestAnimationFrame(() => mover.classList.add("is-flipped")));
    } else {
      mover.style.transition = "none";
      mover.classList.add("is-flipped");
      void mover.offsetWidth;
      mover.style.transition = "";
      requestAnimationFrame(() => requestAnimationFrame(() => mover.classList.remove("is-flipped")));
    }
    setTimeout(() => {
      mover.classList.remove("is-anim", "is-flipped");
      paperIndex = target;
      paperTurning = false;
      resetPaperPages(pages);
      applyPaperIndicator();
    }, dur + 50);
  }
  function openNewspaper(id) {
    const article = state.articles.find((item) => item.id === id) || activeArticle();
    if (!article) return;
    state.lastArticleId = article.id;
    state.lastStory = article.story;
    renderPaper([article], { type: "article", id: article.id });
  }
  function openIssue(weekKey) {
    const articles = articlesOfWeek(weekKey);
    if (!articles.length) return;
    renderPaper(articles, { type: "issue", weekKey, period: "week" });
  }
  function openIssueArticles(articles, meta = {}) {
    const list = (articles || []).filter(Boolean);
    if (!list.length) return;
    renderPaper(list, { type: "issue", ids: list.map((a) => a.id), period: meta.period || "week", key: meta.key || "", label: meta.label || "" });
  }
  function renderPaper(articles, open) {
    const viewport = $("#newspaper-body");
    if (!viewport) return;
    currentOpen = open;
    $("#newspaper-modal").hidden = false;
    paperIndex = 0;
    paperTurning = false;
    const isIssue = open.type === "issue";
    viewport.innerHTML = (isIssue ? issueMagazinePages(articles, open) : issuePages(articles)).join("");
    sizeBook();
    if (isIssue) paginateMagazine(articles, open);
    else paginateFrontPages(articles);
    resetPaperPages();
    applyPaperIndicator();
    document.querySelectorAll("#newspaper-body .paper-gloss").forEach((glass) => glass.hidden = true);
    ["words"].forEach((key) => {
      const btn = document.querySelector(`#btn-gloss-${key}`);
      if (btn) btn.classList.remove("is-active");
    });
    const wordsBtn = $("#btn-gloss-words");
    if (wordsBtn) wordsBtn.hidden = isIssue;
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if ($("#newspaper-modal").hidden || !sameOpen(currentOpen, open)) return;
        const keep = paperIndex;
        viewport.innerHTML = (isIssue ? issueMagazinePages(articles, open) : issuePages(articles)).join("");
        sizeBook();
        if (isIssue) paginateMagazine(articles, open);
        else paginateFrontPages(articles);
        paperIndex = Math.min(keep, Math.max(0, paperPages().length - 1));
        resetPaperPages();
        applyPaperIndicator();
      }).catch(() => {
      });
    }
  }
  function sameOpen(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === "issue") return a.weekKey === b.weekKey && (a.ids?.join() || "") === (b.ids?.join() || "");
    return a.id === b.id;
  }
  function reopenPaper() {
    const keep = paperIndex;
    if (currentOpen?.type === "issue") {
      if (Array.isArray(currentOpen.ids) && currentOpen.ids.length) {
        openIssueArticles(currentOpen.ids.map((id) => state.articles.find((a) => a.id === id)).filter(Boolean), currentOpen);
      } else openIssue(currentOpen.weekKey);
    } else if (currentOpen?.type === "article" && state.articles.some((a) => a.id === currentOpen.id)) openNewspaper(currentOpen.id);
    else return;
    const pages = paperPages();
    if (pages.length) {
      paperIndex = Math.min(keep, pages.length - 1);
      resetPaperPages();
      applyPaperIndicator();
    }
  }
  function paperGoto(index) {
    const pages = paperPages();
    const target = Math.max(0, Math.min(Number(index) || 0, pages.length - 1));
    if (paperTurning || target === paperIndex) return;
    paperIndex = target;
    resetPaperPages(pages);
    applyPaperIndicator();
  }
  function toggleGloss(key) {
    const panel2 = document.querySelector(`#newspaper-body .paper-gloss[data-gloss="${key}"]`);
    const btn = document.querySelector(`#btn-gloss-${key}`);
    if (!panel2) return;
    const show = panel2.hidden;
    if (show) {
      document.querySelectorAll("#newspaper-body .paper-gloss").forEach((g) => g.hidden = true);
      ["words"].forEach((k) => {
        const b = document.querySelector(`#btn-gloss-${k}`);
        if (b) b.classList.remove("is-active");
      });
    }
    panel2.hidden = !show;
    if (btn) btn.classList.toggle("is-active", show);
  }
  function bindReaderEvents() {
    $("#btn-close-newspaper").addEventListener("click", () => $("#newspaper-modal").hidden = true);
    $("#newspaper-modal").addEventListener("click", (e) => {
      if (e.target.id === "newspaper-modal") $("#newspaper-modal").hidden = true;
    });
    let paperResizeTimer = null;
    window.addEventListener("resize", () => {
      const modal = $("#newspaper-modal");
      if (!modal || modal.hidden || !currentOpen) return;
      clearTimeout(paperResizeTimer);
      paperResizeTimer = setTimeout(reopenPaper, 120);
    });
    $("#paper-prev").addEventListener("click", () => paperGo(-1));
    $("#paper-next").addEventListener("click", () => paperGo(1));
    $("#newspaper-body").addEventListener("click", (e) => {
      const row = e.target.closest("[data-goto-page]");
      if (row) paperGoto(row.dataset.gotoPage);
    });
    document.querySelectorAll(".paper-toggle").forEach(
      (btn) => btn.addEventListener("click", () => toggleGloss(btn.dataset.gloss))
    );
    document.addEventListener("keydown", (e) => {
      if ($("#newspaper-modal").hidden) return;
      if (e.key === "ArrowRight") paperGo(1);
      else if (e.key === "ArrowLeft") paperGo(-1);
      else if (e.key === "Escape") $("#newspaper-modal").hidden = true;
    });
  }

  // frontend/js/newspaper/export.js
  function exportTarget(articles) {
    const cur = (Array.isArray(articles) ? articles : []).filter(Boolean);
    if (cur.length) return cur;
    const week = currentWeekArticles();
    if (week.length) return week;
    const active = activeArticle();
    return active ? [active] : [];
  }
  function downloadWordArticle(articles) {
    const target = exportTarget(articles);
    if (!target.length) {
      toast("还没有可以导出的日报");
      return;
    }
    const first = target[0];
    const issueName = target.length > 1 ? `Zhihu-English-Daily-${(first.weekLabel || first.generatedAt || "").replace(/[\\/:*?"<>|.\s]/g, "-")}` : String(first.title || first.story?.title || "Zhihu-English-Daily").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Georgia,'Times New Roman',serif;color:#211c18;line-height:1.8}h1{font-family:'Playfair Display',Georgia,serif;font-size:30px;border-bottom:2px solid #211c18;padding-bottom:12px}.newspaper-masthead{text-align:center}.newspaper-nameplate{font-family:'Playfair Display',Georgia,serif;font-size:26px;font-weight:700;letter-spacing:3px}.newspaper-dateline,.newspaper-byline,.newspaper-kicker,.newspaper-status,.newspaper-footer{font-family:Arial,sans-serif;color:#806f61;font-size:11px}.newspaper-en{font-size:15px;font-family:Georgia,'Times New Roman',serif}.newspaper-translation{border-top:1px solid #b9aa98;margin-top:24px;padding-top:18px}.newspaper-translation>div{font-family:'Microsoft YaHei',sans-serif}.newspaper-box{border:1px solid #b9aa98;padding:12px;margin-top:12px}.newspaper-word-list span{display:inline-block;margin:3px 8px 3px 0}.newspaper-footer{border-top:1px solid #211c18;margin-top:24px;padding-top:10px;display:flex;justify-content:space-between}.issue-sep{page-break-before:always}</style></head><body>${target.map((a) => newspaperMarkup(a)).join("\n")}</body></html>`;
    const blob = new Blob(["\uFEFF", html], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${issueName}.doc`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  function printNewspaper(articles) {
    const target = exportTarget(articles);
    if (!target.length) {
      toast("还没有可以导出的日报");
      return;
    }
    const cur = (Array.isArray(articles) ? articles : []).filter(Boolean);
    if (!cur.length) {
      if (target.length > 1) openIssue(target[0].weekKey || dailyWeekInfo(target[0].generatedAt).key);
      else openNewspaper(target[0].id);
    }
    const cleanup = () => document.body.classList.remove("print-newspaper");
    document.body.classList.add("print-newspaper");
    window.addEventListener("afterprint", cleanup, { once: true });
    window.print();
    setTimeout(cleanup, 2500);
  }

  // frontend/js/views/practice.js
  var MODES = [["target", "目标词填空"], ["choice", "选词填空"], ["spelling", "拼写"], ["sentence", "句子排序"]];
  var activeArticle2 = () => state.articles.find((item) => item.id === state.lastArticleId) || null;
  var escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function targetCards() {
    const article = activeArticle2();
    if (article?.targetCards?.length) return article.targetCards;
    const words = Array.from(String(state.lastStory?.en || "").matchAll(/\*\*([^*]+)\*\*/g), (match) => match[1]);
    return words.map((word) => state.pool.find((card) => String(card.word).toLowerCase() === word.toLowerCase()) || { word });
  }
  function contextFor(word) {
    const plain = String(state.lastStory?.en || "").replace(/\*\*/g, "");
    return plain.split(/(?<=[.!?])\s+/).find((sentence) => new RegExp(`\\b${escapeRe(word)}\\b`, "i").test(sentence)) || plain.slice(0, 180);
  }
  function practiceInput(word, index) {
    return `<span class="practice-blank"><span class="practice-blank-index">${String(index).padStart(2, "0")}</span><input class="practice-input" type="text" autocomplete="off" data-answer="${esc(word)}"></span>`;
  }
  function targetExercise() {
    let index = 0;
    return `<div class="inline-exercise-text">${esc(state.lastStory.en).replace(/\*\*([^*]+)\*\*/g, (_, word) => practiceInput(word.trim(), ++index)).replace(/\n/g, "<br>")}</div>`;
  }
  function choiceExercise() {
    const options = targetCards().map((card) => card.word).filter(Boolean);
    const body = esc(state.lastStory.en).replace(/\*\*([^*]+)\*\*/g, (_, word) => `<select class="practice-choice" data-answer="${esc(word.trim())}"><option value="">选择</option>${options.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("")}</select>`);
    return `<div class="inline-exercise-text">${body.replace(/\n/g, "<br>")}</div>`;
  }
  function spellingExercise() {
    return `<div class="spelling-grid">${targetCards().map((card) => `<label class="spelling-card"><span>${esc(card.meaning_cn || card.meaning || card.meaning_en || "根据语境拼写")}</span><small>${esc(contextFor(card.word).replace(new RegExp(`\\b${escapeRe(card.word)}\\b`, "ig"), "____"))}</small><input type="text" data-answer="${esc(card.word)}" autocomplete="off" spellcheck="false"></label>`).join("")}</div>`;
  }
  function sentenceExercise() {
    const sentences = String(state.lastStory.en || "").replace(/\*\*/g, "").split(/(?<=[.!?])\s+/).filter((sentence) => targetCards().some((card) => new RegExp(`\\b${escapeRe(card.word)}\\b`, "i").test(sentence))).slice(0, 5);
    const shuffled = sentences.map((sentence, index) => ({ sentence, index })).sort((a, b) => (a.index * 7 + 3) % 11 - (b.index * 7 + 3) % 11);
    return `<div class="sentence-sort">${shuffled.map((item) => `<div class="sentence-sort-row" data-answer-index="${item.index}"><span>${esc(item.sentence)}</span><button type="button" data-move="up">↑</button><button type="button" data-move="down">↓</button></div>`).join("")}</div>`;
  }
  var renderModeBody = () => state.practiceMode === "choice" ? choiceExercise() : state.practiceMode === "spelling" ? spellingExercise() : state.practiceMode === "sentence" ? sentenceExercise() : targetExercise();
  function renderInlinePractice() {
    const root = $("#inline-practice");
    if (!root || !state.lastStory?.en) return;
    const result = state.practiceResults[state.lastArticleId]?.[state.practiceMode];
    root.innerHTML = `<div class="practice-mode-tabs">${MODES.map(([id, label]) => `<button class="${state.practiceMode === id ? "is-active" : ""}" type="button" data-practice-mode="${id}">${label}</button>`).join("")}</div><div class="inline-practice-head"><strong>${MODES.find(([id]) => id === state.practiceMode)?.[1]}</strong><span>${result ? `上次 ${result.score}/${result.total}` : "完成后记录错词"}</span></div><div id="inline-practice-body">${renderModeBody()}</div><div id="inline-practice-feedback" class="practice-feedback" hidden></div><div class="practice-actions"><button id="btn-check-inline-practice" class="btn-primary" type="button">提交并检查</button><button id="btn-reset-inline-practice" class="btn-ghost" type="button">重新练习</button></div>`;
    root.querySelectorAll("[data-practice-mode]").forEach((button) => button.addEventListener("click", () => {
      state.practiceMode = button.dataset.practiceMode;
      renderInlinePractice();
    }));
    root.querySelectorAll("[data-move]").forEach((button) => button.addEventListener("click", () => {
      const row = button.closest(".sentence-sort-row");
      const sibling = button.dataset.move === "up" ? row.previousElementSibling : row.nextElementSibling;
      if (!sibling) return;
      if (button.dataset.move === "up") row.parentElement.insertBefore(row, sibling);
      else row.parentElement.insertBefore(sibling, row);
    }));
    $("#btn-check-inline-practice")?.addEventListener("click", checkInlinePractice);
    $("#btn-reset-inline-practice")?.addEventListener("click", renderInlinePractice);
  }
  function recordMistakes(words) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const cards = targetCards();
    const keys = new Set(words.map((word) => String(word).toLowerCase()));
    state.recentMistakes = state.recentMistakes.filter((item) => !keys.has(String(item.word).toLowerCase()));
    words.forEach((word) => {
      const key = String(word).toLowerCase();
      delete state.masteredWords[key];
      state.recentMistakes.unshift({ word, card: cards.find((card) => String(card.word).toLowerCase() === key) || { word }, wrongAt: now, articleId: state.lastArticleId, practiceMode: state.practiceMode });
    });
    const cutoffDate = /* @__PURE__ */ new Date();
    cutoffDate.setHours(0, 0, 0, 0);
    cutoffDate.setDate(cutoffDate.getDate() - 2);
    const cutoff = cutoffDate.getTime();
    state.recentMistakes = state.recentMistakes.filter((item) => new Date(item.wrongAt).getTime() >= cutoff);
  }
  function checkInlinePractice() {
    var _a, _b;
    const root = $("#inline-practice-body");
    let results;
    if (state.practiceMode === "sentence") {
      results = [...root.querySelectorAll(".sentence-sort-row")].map((row, index) => ({ input: row, answers: targetCards().filter((card) => row.textContent.toLowerCase().includes(String(card.word).toLowerCase())).map((card) => card.word), correct: Number(row.dataset.answerIndex) === index }));
    } else {
      results = [...root.querySelectorAll("input[data-answer], select[data-answer]")].map((input) => ({ input, answers: [input.dataset.answer], correct: input.value.trim().toLowerCase() === input.dataset.answer.trim().toLowerCase() }));
    }
    if (!results.length) return;
    results.forEach((item) => item.input.classList.toggle("is-wrong", !item.correct));
    const wrongWords = Array.from(new Set(results.filter((item) => !item.correct).flatMap((item) => item.answers).filter(Boolean)));
    const score = results.filter((item) => item.correct).length;
    (_a = state.practiceResults)[_b = state.lastArticleId] || (_a[_b] = {});
    state.practiceResults[state.lastArticleId][state.practiceMode] = { score, total: results.length, wrongWords, completedAt: (/* @__PURE__ */ new Date()).toISOString() };
    recordMistakes(wrongWords);
    if (wrongWords.length) {
      const article = activeArticle2();
      if (article) article.completedAt = "";
    }
    const allPerfect = MODES.every(([mode]) => {
      const value = state.practiceResults[state.lastArticleId]?.[mode];
      return value && value.total > 0 && value.score === value.total;
    });
    state.practiceCompleted = allPerfect;
    if (allPerfect) markArticleCompleted();
    persist();
    emit("articles");
    const feedback = $("#inline-practice-feedback");
    feedback.hidden = false;
    feedback.className = `practice-feedback is-${wrongWords.length ? "warning" : "success"}`;
    feedback.innerHTML = `<span class="practice-feedback-icon">${wrongWords.length ? "!" : "✓"}</span><span><strong>得分 ${score} / ${results.length}</strong><small>${wrongWords.length ? `错词已回流近三日：${esc(wrongWords.join("、"))}` : allPerfect ? "四种练习全部满分，本期已完成。" : "本模式满分，继续完成其他练习。"}</small></span>`;
  }
  function withStoryGlosses(text, story, article = null) {
    const cards = article?.targetCards?.length ? article.targetCards : [...state.pool, ...state.wordbook];
    const meanings = new Map(cards.map((card) => [String(card.word).toLowerCase(), String(card.meaning_cn || card.meaning || card.meaning_en || "").split(/[；;，,、/|]/)[0]]));
    const used = /* @__PURE__ */ new Set();
    return String(text || "").replace(/\*\*([^*]+)\*\*/g, (full, raw) => {
      const key = raw.trim().toLowerCase();
      if (!meanings.get(key) || used.has(key)) return full;
      used.add(key);
      return `**${raw}**（${meanings.get(key)}）`;
    });
  }
  function renderPractice() {
    const empty = $("#practice-empty");
    const card = $("#practice-card");
    const story = $("#practice-story");
    if (!empty || !card || !story) return;
    empty.hidden = Boolean(state.lastStory?.en);
    card.hidden = !state.lastStory?.en;
    if (!state.lastStory?.en) return;
    let index = 0;
    story.innerHTML = `<h3>${esc(state.lastStory.title || "记忆故事")}</h3><p>${esc(state.lastStory.en).replace(/\*\*([^*]+)\*\*/g, (_, word) => practiceInput(word, ++index)).replace(/\n/g, "<br>")}</p>`;
    $("#practice-score").textContent = `${index} 个空 · 完整练习请使用文章上方“练习”标签`;
  }
  function openPracticeArticle(id) {
    const article = state.articles.find((item) => item.id === id);
    if (!article) return;
    state.lastArticleId = article.id;
    state.lastStory = article.story;
    state.practiceCompleted = false;
    state.workflowStage = "result";
    state.resultMode = "practice";
    showView("story-pool-view");
    requestAnimationFrame(() => {
      renderPractice();
      $("#practice-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  function bindPracticeEvents() {
    $("#btn-check-practice")?.addEventListener("click", () => {
      document.querySelectorAll("#practice-story input[data-answer]").forEach((input) => input.classList.toggle("is-wrong", input.value.trim().toLowerCase() !== input.dataset.answer.trim().toLowerCase()));
    });
    $("#btn-reset-practice")?.addEventListener("click", renderPractice);
  }

  // frontend/js/views/storybook.js
  function weekGroupHtml(group, isCurrent) {
    const toc = group.articles.map((article, index) => `
    <li>
      <span class="weekly-toc-no">${String(index + 1).padStart(2, "0")}</span>
      <span class="weekly-toc-title">${esc(article.title || article.story?.title || "知乎英语日报")}</span>
      <button class="weekly-practice-button${article.completedAt ? " is-complete" : ""}" type="button" data-article-id="${esc(article.id)}">${article.completedAt ? "再练习" : "练习"}</button>
      <button class="weekly-delete-button" type="button" data-delete-article="${esc(article.id)}">删除</button>
    </li>`).join("");
    return `
  <section class="article-week-group${isCurrent ? " is-current" : ""}">
    <header class="article-week-head">
      <div class="article-week-info">
        <span class="article-week-label">${esc(group.weekLabel)}</span>
        <span class="article-week-meta">${group.articles.length} 篇文章 · ${weekWordCount(group.weekKey)} 个目标词${isCurrent ? " · 本周" : ""}</span>
      </div>
    </header>
    <div class="weekly-cover-layout">
      <button class="weekly-cover-button" type="button" data-week-key="${esc(group.weekKey)}" aria-label="阅读${esc(group.weekLabel)}周刊">
        <span class="weekly-cover-viewport"><span class="weekly-cover-page">${newspaperIssueCoverBody(group.articles)}</span></span>
      </button>
      <div class="weekly-toc"><p class="weekly-toc-kicker">IN THIS ISSUE · ${group.articles.length} STORIES</p><ol>${toc}</ol></div>
    </div>
  </section>`;
  }
  function bindArticleList(root) {
    root.querySelectorAll(".weekly-cover-button").forEach((button) => button.addEventListener("click", () => openIssue(button.dataset.weekKey)));
    root.querySelectorAll(".weekly-practice-button").forEach((button) => button.addEventListener("click", () => openPracticeArticle(button.dataset.articleId)));
    root.querySelectorAll("[data-delete-article]").forEach((button) => button.addEventListener("click", () => removeArticle(button.dataset.deleteArticle)));
    root.querySelectorAll(".weekly-cover-button").forEach((button) => fitWeeklyCover(button));
  }
  function removeArticle(id) {
    const article = state.articles.find((item) => item.id === id);
    if (!article || !window.confirm(`确定删除《${article.title || "知乎英语日报"}》吗？删除后不可恢复。`)) return;
    deleteArticle(id);
  }
  function fitWeeklyCover(button) {
    const viewport = button.querySelector(".weekly-cover-viewport");
    const page = button.querySelector(".weekly-cover-page");
    if (!viewport || !page) return;
    const scale = Math.min(0.72, Math.max(0.28, (viewport.clientWidth - 2) / 980));
    const frame = page.querySelector(".paper-cover-frame, .mag-mini-cover");
    const sourceHeight = Math.max(420, frame?.scrollHeight || page.scrollHeight || 930);
    page.style.transform = `scale(${scale})`;
    viewport.style.height = `${Math.round(sourceHeight * scale)}px`;
  }
  function periodicalHtml(period) {
    const groups = localPeriodicalGroups(period);
    if (!groups.length) return `<div class="article-empty">积累日报后，这里会自动形成${period === "month" ? "月刊" : "周刊"}词汇地图。</div>`;
    return `<div class="periodical-summary">${groups.map((group) => {
      const saved = state.periodicalSelections?.[period]?.[group.key];
      const selected = new Set(Array.isArray(saved) && saved.length ? saved : group.articles.map((article) => article.id));
      const selectedArticles = group.articles.filter((article) => selected.has(article.id));
      const selectedWords = new Set(selectedArticles.flatMap((article) => article.targetWords || []).map((word) => String(word).toLowerCase()));
      const sourceCount = Object.entries(selectedArticles.reduce((map, article) => {
        const source = article.story?.source_type || "original";
        map[source] = (map[source] || 0) + 1;
        return map;
      }, {})).map(([name, count]) => `${name} ${count}`).join(" · ");
      const themes = selectedArticles.flatMap((article) => {
        const group2 = article.sorting?.selected_group || {};
        return [{ name: group2.theme || "本期选题", words: group2.words || article.targetWords || [] }];
      }).map((theme) => `<span title="${esc(theme.words.join(", "))}">${esc(theme.name)} · ${theme.words.length}词</span>`).join("");
      const rows = group.articles.map((article) => `<label class="periodical-article-option"><input type="checkbox" data-periodical-period="${period}" data-periodical-group="${esc(group.key)}" value="${esc(article.id)}" ${selected.has(article.id) ? "checked" : ""}><span>${esc(article.title || article.story?.title || "知乎英语日报")}</span><small>${esc(String(article.generatedAt || "").slice(0, 10))}</small></label>`).join("");
      return `<section class="periodical-summary-card"><header class="periodical-summary-head"><div><h4>${esc(group.label || group.key)} ${period === "month" ? "月刊" : "周刊"}</h4><p>${selectedArticles.length} / ${group.articleCount} 篇文章 · ${selectedWords.size} 个去重目标词</p><p>题材来源：${esc(sourceCount || "尚未选择")}</p></div><div class="periodical-card-actions"><button class="btn-ghost periodical-read" type="button" data-periodical-read="${esc(group.key)}" data-periodical-period="${period}">阅读整刊</button><button class="btn-ghost periodical-save" type="button" data-periodical-save="${esc(group.key)}" data-periodical-period="${period}">保存选刊</button></div></header><div class="periodical-article-options">${rows}</div><div class="periodical-theme-list">${themes || "<span>选择文章后生成主题地图</span>"}</div></section>`;
    }).join("")}</div>`;
  }
  function bindPeriodicalList(root) {
    root.querySelectorAll("[data-periodical-save]").forEach((button) => button.addEventListener("click", () => {
      const period = button.dataset.periodicalPeriod;
      const key = button.dataset.periodicalSave;
      const ids = Array.from(root.querySelectorAll(`input[data-periodical-period="${period}"][data-periodical-group="${key}"]:checked`)).map((input) => input.value);
      if (!ids.length) return toast("至少保留一篇文章才能组成刊物");
      state.periodicalSelections[period][key] = ids;
      persist();
      renderArticleBook();
    }));
    root.querySelectorAll("[data-periodical-read]").forEach((button) => button.addEventListener("click", () => {
      const period = button.dataset.periodicalPeriod;
      const key = button.dataset.periodicalRead;
      const group = localPeriodicalGroups(period).find((item) => item.key === key);
      if (!group) return;
      const saved = state.periodicalSelections?.[period]?.[key];
      const selected = new Set(Array.isArray(saved) && saved.length ? saved : group.articles.map((article) => article.id));
      const articles = group.articles.filter((article) => selected.has(article.id));
      if (!articles.length) return toast("这一期还没有文章");
      openIssueArticles(articles, { period, key, label: group.label });
    }));
  }
  function dailyHtml() {
    return `<div class="article-list">${state.articles.map((article) => `
    <article class="article-card">
      <div class="article-card-meta"><small>${esc(String(article.generatedAt || "").slice(0, 10))} · ${article.language === "zh" ? "中文呈现" : "英文呈现"}</small><strong>${esc(article.title || article.story?.title || "知乎英语日报")}</strong><span>${esc((article.targetWords || []).join(" · "))}</span></div>
      <div class="article-card-actions"><button class="btn-ghost article-open" type="button" data-article-id="${esc(article.id)}">阅读</button><button class="btn-primary article-practice" type="button" data-article-id="${esc(article.id)}">练习</button><button class="btn-ghost article-delete" type="button" data-delete-article="${esc(article.id)}">删除</button></div>
    </article>`).join("")}</div>`;
  }
  function bindDailyList(root) {
    root.querySelectorAll(".article-open").forEach((button) => button.addEventListener("click", () => openNewspaper(button.dataset.articleId)));
    root.querySelectorAll(".article-practice").forEach((button) => button.addEventListener("click", () => openPracticeArticle(button.dataset.articleId)));
    root.querySelectorAll("[data-delete-article]").forEach((button) => button.addEventListener("click", () => removeArticle(button.dataset.deleteArticle)));
  }
  function renderArticleBook() {
    const list = $("#article-list");
    const storyList = $("#story-book-list");
    const count = $("#article-count");
    const storyCount = $("#story-book-count");
    if (!list && !storyList) return;
    const currentWeek = dailyWeekInfo();
    const weekArticles = state.articles.filter((article) => (article.weekKey || dailyWeekInfo(article.generatedAt).key) === currentWeek.key);
    const weeklyWordCount = $("#weekly-word-count");
    const weeklyIssueNote = $("#weekly-issue-note");
    if (weeklyWordCount) weeklyWordCount.textContent = weekWordCount(currentWeek.key) || state.wordbook.filter((word) => dailyWeekInfo(word.savedAt).key === currentWeek.key).length;
    if (weeklyIssueNote) weeklyIssueNote.textContent = weekArticles.length ? `${currentWeek.label} · 本周已出版 ${weekArticles.length} 篇，整合为一期刊物` : `${currentWeek.label} · 今天尚未生成`;
    const readIssueBtn = $("#btn-read-weekly-issue");
    if (readIssueBtn) readIssueBtn.hidden = !weekArticles.length;
    if (count) count.textContent = state.articles.length;
    const containers = [list, storyList].filter(Boolean);
    if (!state.articles.length) {
      containers.forEach((root) => root.innerHTML = `<div class="article-empty">生成刊物后，每周的文章会整合成一期日报保存在这里。</div>`);
      return;
    }
    const activeView = document.querySelector(".view.active");
    const groups = weekGroups();
    if (storyCount) storyCount.textContent = state.periodicalView === "daily" ? groups.length : localPeriodicalGroups(state.periodicalView).length;
    for (const root of containers) {
      if (activeView && activeView.contains(root)) {
        if (root === storyList && state.periodicalView === "daily") {
          root.innerHTML = dailyHtml();
          bindDailyList(root);
        } else if (root === storyList) {
          root.innerHTML = periodicalHtml(state.periodicalView);
          bindPeriodicalList(root);
        } else {
          root.innerHTML = groups.map((group) => weekGroupHtml(group, group.weekKey === currentWeek.key)).join("");
          bindArticleList(root);
        }
      } else {
        root.innerHTML = "";
      }
    }
  }
  function bindStorybookEvents() {
    $("#btn-weekly-export-pdf").addEventListener("click", () => printNewspaper());
    $("#btn-weekly-export-word").addEventListener("click", () => downloadWordArticle());
    $("#btn-read-weekly-issue")?.addEventListener("click", () => {
      const currentWeek = dailyWeekInfo();
      if (!state.articles.some((article) => (article.weekKey || dailyWeekInfo(article.generatedAt).key) === currentWeek.key)) {
        return;
      }
      openIssue(currentWeek.key);
    });
    window.addEventListener("resize", () => document.querySelectorAll(".weekly-cover-button").forEach(fitWeeklyCover));
    document.querySelectorAll(".periodical-tab").forEach((button) => button.addEventListener("click", () => {
      state.periodicalView = ["week", "month"].includes(button.dataset.period) ? button.dataset.period : "daily";
      document.querySelectorAll(".periodical-tab").forEach((item) => item.classList.toggle("is-active", item === button));
      renderArticleBook();
    }));
  }

  // frontend/js/views/wordbook.js
  function normalizeWordEntry2(entry) {
    if (entry && entry.review) {
      try {
        delete entry.review;
      } catch (e) {
        entry.review = void 0;
      }
    }
    return entry;
  }
  function saveToWordbook(word) {
    const key = String(word.word || "").toLowerCase();
    if (state.wordbook.some((w) => String(w.word || "").toLowerCase() === key)) {
      toast(`「${word.word}」已经在单词本里`);
      return;
    }
    const entry = normalizeWordEntry2({ ...word, savedAt: nowIso() });
    state.wordbook.unshift(entry);
    persist();
    emit("wordbook");
    toast(`「${word.word}」已收藏进单词本`);
  }
  function removeFromWordbook(word) {
    const key = String(word || "").toLowerCase();
    state.wordbook = state.wordbook.filter((w) => String(w.word || "").toLowerCase() !== key);
    persist();
    emit("wordbook");
  }
  function bindWordbookMobileSearch() {
    const input = $("#wb-mobile-search");
    const box = $("#wb-mobile-lib");
    if (!input || !box) return;
    const wrap = input.closest(".wb-mobile-search");
    const renderRows = (words) => {
      if (wrap) wrap.classList.toggle("has-results", words.length > 0);
      box.classList.toggle("has-results", words.length > 0);
      box.innerHTML = words.map((w) => {
        const key = String(w.word || "").toLowerCase();
        const saved = state.wordbook.some((item) => String(item.word || "").toLowerCase() === key);
        const level = w.level || (Array.isArray(w.levels) ? w.levels.join(" / ") : "");
        return `<div class="lib-row"><span class="lib-row-main"><strong>${esc(w.word)}</strong><small>${esc(wordbookPos(w.pos))} · ${esc(wordbookMeaning(w))}</small></span>${level ? `<span class="lib-row-level">${esc(level)}</span>` : ""}${saved ? `<button class="btn-link lib-row-unsave wb-in-pool is-saved" type="button" data-word="${esc(w.word)}" title="点击取消收藏">已收藏</button>` : `<button class="btn-link lib-row-save" type="button" data-word="${esc(w.word)}">♡ 收藏</button>`}</div>`;
      }).join("");
      box.querySelectorAll(".lib-row-save").forEach((button) => button.addEventListener("click", () => {
        const word = words.find((item) => item.word === button.dataset.word);
        if (!word) return;
        saveToWordbook(word);
        renderRows(words);
      }));
      box.querySelectorAll(".lib-row-unsave").forEach((button) => button.addEventListener("click", () => {
        removeFromWordbook(button.dataset.word);
        toast(`「${button.dataset.word}」已取消收藏`);
        renderRows(words);
      }));
    };
    let timer;
    input.addEventListener("input", () => {
      const q = input.value.trim();
      clearTimeout(timer);
      if (!q) {
        box.hidden = true;
        box.classList.remove("has-results");
        box.innerHTML = "";
        if (wrap) wrap.classList.remove("has-results");
        return;
      }
      timer = setTimeout(async () => {
        try {
          const r = await Api.searchWords(q, "all", 30, "");
          const words = r.words || [];
          box.hidden = words.length === 0;
          renderRows(words);
        } catch (err) {
          toast("搜索失败：" + err.message);
        }
      }, 150);
    });
  }
  function sortedWordbook() {
    return state.wordbook.map((word, index) => ({ word, index })).sort((a, b) => {
      if (state.wordbookSort.startsWith("alpha")) {
        const result2 = String(a.word.word).localeCompare(String(b.word.word), "en", { sensitivity: "base" });
        return state.wordbookSort === "alpha-desc" ? -result2 : result2;
      }
      const at = parseStamp(a.word.savedAt)?.getTime() || 0;
      const bt = parseStamp(b.word.savedAt)?.getTime() || 0;
      const result = bt - at;
      return result || a.index - b.index;
    }).map(({ word }) => word);
  }
  function renderWordbook() {
    const list = $("#wordbook-list");
    if (!list) return;
    $("#wordbook-count").textContent = state.wordbook.length;
    document.querySelectorAll(".wordbook-sort").forEach((button) => button.classList.toggle("is-active", button.dataset.sort === state.wordbookSort));
    if (!state.wordbook.length) {
      list.innerHTML = `<div class="wordbook-empty"><span class="result-orb" aria-hidden="true">▱</span><strong>单词本还是空的</strong><span>在搜索词库翻开卡牌，点击“收藏到单词本”即可保存。</span><button class="btn-primary view-link" type="button" data-view="search-view">去挑选单词 <span class="btn-arrow">→</span></button></div>`;
      list.querySelector(".view-link").addEventListener("click", () => showView("search-view"));
    } else {
      const groups = [];
      sortedWordbook().forEach((word) => {
        const key = parseStamp(word.savedAt)?.toISOString().slice(0, 10) || "unknown";
        let group = groups.find((item) => item.key === key);
        if (!group) {
          group = { key, label: formatWordbookDate(word.savedAt), words: [] };
          groups.push(group);
        }
        group.words.push(word);
      });
      list.innerHTML = groups.map((group) => `
      <section class="wordbook-group">
        <div class="wordbook-date"><span>${group.label}</span><small>${group.words.length} 个单词</small></div>
        <div class="wordbook-group-list">${group.words.map((w) => {
        return `
          <article class="wordbook-row">
            <div class="wordbook-row-main"><div class="wordbook-word">${esc(w.word)}</div><div class="wordbook-row-meta"><span class="meaning-pos">${esc(wordbookPos(w.pos))}</span><time>${esc(formatWordbookTime(w.savedAt))}</time></div></div>
            <div class="wordbook-meaning">${esc(wordbookMeaning(w))}</div>
            <span class="wordbook-level">${esc(w.levels && w.levels[0] || w.level || "词库")}</span>
            <button class="wordbook-detail-link" type="button" data-word="${esc(w.word)}">详情 <span aria-hidden="true">›</span></button>
            <button class="wordbook-remove btn-link" type="button" data-word="${esc(w.word)}">移除</button>
          </article>`;
      }).join("")}</div>
      </section>`).join("");
      list.querySelectorAll(".wordbook-remove").forEach((button) => button.addEventListener("click", () => removeFromWordbook(button.dataset.word)));
      list.querySelectorAll(".wordbook-detail-link").forEach((button) => button.addEventListener("click", () => openWordDetail(button.dataset.word)));
    }
    renderArticleBook();
  }
  function bindWordbookEvents() {
    document.querySelectorAll(".wordbook-sort").forEach((button) => button.addEventListener("click", () => {
      state.wordbookSort = button.dataset.sort;
      renderWordbook();
    }));
    $("#btn-wordbook-export").addEventListener("click", () => window.print());
  }

  // frontend/js/views/library.js
  function renderLibrary() {
    const list = $("#lib-list");
    if (!list) return;
    const rows = state.libraryCards;
    $("#card-count").textContent = `${rows.length}`;
    $("#lib-empty").hidden = rows.length > 0;
    list.innerHTML = rows.map((w) => {
      const key = String(w.word || "").toLowerCase();
      const saved = state.wordbook.some((item) => String(item.word || "").toLowerCase() === key);
      const level = w.level || (Array.isArray(w.levels) ? w.levels.join(" / ") : "");
      return `<div class="lib-row"><span class="lib-row-main"><strong>${esc(w.word)}</strong><small>${esc(wordbookPos(w.pos))} · ${esc(wordbookMeaning(w))}</small></span>${level ? `<span class="lib-row-level">${esc(level)}</span>` : ""}${saved ? `<button class="btn-link lib-row-unsave wb-in-pool is-saved" type="button" data-word="${esc(w.word)}" title="点击取消收藏">已收藏</button>` : `<button class="btn-link lib-row-save" type="button" data-word="${esc(w.word)}">♡ 收藏</button>`}</div>`;
    }).join("");
    list.querySelectorAll(".lib-row-save").forEach((button) => button.addEventListener("click", () => {
      const word = state.libraryCards.find((item) => item.word === button.dataset.word);
      if (!word) return;
      saveToWordbook(word);
      renderLibrary();
    }));
    list.querySelectorAll(".lib-row-unsave").forEach((button) => button.addEventListener("click", () => {
      removeFromWordbook(button.dataset.word);
      toast(`「${button.dataset.word}」已取消收藏`);
      renderLibrary();
    }));
  }
  async function refreshLibrary(kind = "browse") {
    let words = [];
    try {
      const q = state.search.trim();
      if (q || state.pos) {
        const r = await Api.searchWords(q, state.level, 4e3, state.pos);
        words = r.words || [];
      } else if (kind === "random") {
        const r = await Api.randomWords(state.level, 12);
        words = r.words || [];
      } else if (kind === "daily") {
        const r = await Api.dailyWords(state.level, 12);
        words = r.words || [];
      } else {
        const r = await Api.searchWords("", state.level, 4e3, "");
        words = r.words || [];
      }
    } catch (err) {
      toast("加载词库失败：" + err.message);
    }
    state.libraryCards = words;
    renderLibrary();
  }
  function openWordDetail(word) {
    state.level = "all";
    state.pos = "";
    state.search = word;
    $("#word-level").value = "all";
    $("#pos-filter").value = "";
    $("#search").value = word;
    refreshLibrary("daily");
  }
  function openCustomWord() {
    $("#custom-word").value = "";
    $("#custom-pos").value = "";
    $("#custom-meaning").value = "";
    $("#custom-status").textContent = "最多填写三条释义，背面会自动压缩展示。";
    $("#custom-status").className = "cfg-detect";
    $("#custom-modal").hidden = false;
    $("#custom-word").focus();
  }
  function closeCustomWord() {
    $("#custom-modal").hidden = true;
  }
  async function saveCustomWord() {
    const word = $("#custom-word").value.trim();
    const pos = $("#custom-pos").value;
    const meaning = $("#custom-meaning").value.trim();
    const status = $("#custom-status");
    const button = $("#btn-save-custom");
    if (!word) {
      status.textContent = "请先填写英文单词。";
      status.className = "cfg-detect test-warn";
      $("#custom-word").focus();
      return;
    }
    button.disabled = true;
    status.textContent = "正在保存…";
    try {
      const res = await Api.addCustomWord(word, pos, meaning);
      closeCustomWord();
      state.level = "all";
      state.pos = "";
      state.search = word;
      $("#word-level").value = "all";
      $("#pos-filter").value = "";
      $("#search").value = word;
      await refreshLibrary("daily");
      toast(`「${res.word.word}」已加入词库`);
    } catch (err) {
      status.textContent = "保存失败：" + err.message;
      status.className = "cfg-detect test-warn";
    } finally {
      button.disabled = false;
    }
  }
  function bindLibraryEvents() {
    let t;
    $("#search").addEventListener("input", (e) => {
      state.search = e.target.value;
      clearTimeout(t);
      t = setTimeout(() => refreshLibrary("browse"), 150);
    });
    $("#word-level").addEventListener("change", (e) => {
      state.level = e.target.value;
      refreshLibrary("browse");
    });
    $("#pos-filter").addEventListener("change", (e) => {
      state.pos = e.target.value;
      refreshLibrary("browse");
    });
    $("#btn-reset-filter").addEventListener("click", () => {
      state.level = "all";
      state.pos = "";
      state.search = "";
      $("#word-level").value = "all";
      $("#pos-filter").value = "";
      $("#search").value = "";
      refreshLibrary("browse");
    });
    const clearSearchBox = () => {
      state.search = "";
      $("#search").value = "";
    };
    $("#btn-random").addEventListener("click", () => {
      clearSearchBox();
      refreshLibrary("random");
    });
    $("#btn-daily").addEventListener("click", () => {
      clearSearchBox();
      refreshLibrary("daily");
    });
    $("#btn-custom-word").addEventListener("click", openCustomWord);
    $("#btn-close-custom").addEventListener("click", closeCustomWord);
    $("#btn-cancel-custom").addEventListener("click", closeCustomWord);
    $("#btn-save-custom").addEventListener("click", saveCustomWord);
    $("#custom-modal").addEventListener("click", (e) => {
      if (e.target.id === "custom-modal") closeCustomWord();
    });
    $("#custom-word").addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveCustomWord();
    });
  }

  // frontend/js/views/source.js
  var pendingKey = "";
  var pendingSearch = null;
  function activeSourceCards() {
    if (state.memoryScope !== "recent_3d") return state.pool;
    const start = /* @__PURE__ */ new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 2);
    const candidates = state.wordbook.map((card) => ({ card, stamp: new Date(card.savedAt || card.addedAt || "").getTime() }));
    state.articles.forEach((article) => {
      const stamp = new Date(article.lastPracticedAt || article.generatedAt || article.savedAt || "").getTime();
      (article.targetCards || []).forEach((card) => candidates.push({ card, stamp }));
    });
    state.recentMistakes.forEach((item) => candidates.push({ card: item.card || { word: item.word }, stamp: new Date(item.wrongAt || "").getTime() }));
    const seen = /* @__PURE__ */ new Set();
    return candidates.filter((item) => Number.isFinite(item.stamp) && item.stamp >= start.getTime()).sort((a, b) => b.stamp - a.stamp).map((item) => item.card).filter((card) => {
      const key = String(card.word || "").toLowerCase();
      if (!key || seen.has(key) || state.masteredWords[key]) return false;
      seen.add(key);
      return true;
    });
  }
  function setSource(source) {
    state.source = source;
    state.sourceSelection = null;
    if (source !== "auto") {
      state.sourceRecommendations = [];
      state.sourceRecommendationKey = "";
    }
    document.querySelectorAll(".source-tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab.dataset.source === source || source === "zhihu_search" && tab.dataset.source === "auto");
    });
    const originalBox = $("#original-topic-box");
    if (originalBox) originalBox.hidden = source !== "original";
    window.dispatchEvent(new CustomEvent("bookwords:source-change", { detail: { source } }));
    renderSourcePicker();
  }
  function targetWords() {
    return (state.selectedGroup?.words || activeSourceCards().map((card) => card.word)).map((word) => String(word || "").toLowerCase()).filter(Boolean);
  }
  function candidateMetrics(item) {
    const summary = String(item.summary || item.description || item.excerpt || item.content_text || "");
    const text = `${item.title || ""} ${summary} ${(item.labels || []).join(" ")}`.toLowerCase();
    const words = targetWords();
    const cards = activeSourceCards();
    const matched = words.filter((word) => {
      if (text.includes(word)) return true;
      const card = cards.find((value) => String(value.word || "").toLowerCase() === word);
      const meaning = String(card?.meaning_cn || card?.meaning || card?.meaning_en || "").split(/[；;,，。]/)[0].trim().toLowerCase();
      return meaning.length >= 2 && text.includes(meaning);
    }).length;
    const density = words.length ? Math.round(matched / words.length * 100) : 0;
    const englishTerms = (summary.match(/[A-Za-z]{4,}/g) || []).length;
    const score = summary.length / 180 + englishTerms / 12 + Number(state.diff || 3) / 10;
    return { density, difficulty: score > 2.2 ? "进阶" : score > 1.15 ? "中等" : "简单" };
  }
  function sourceCard(item, index, kind, meta = "") {
    const metrics = candidateMetrics(item);
    const summary = item.summary || item.description || item.excerpt || item.content_text || "";
    const labels = (item.labels || []).slice(0, 4);
    const byline = item.author && !String(meta).includes(item.author) ? `${meta}${meta ? " · " : ""}作者 ${item.author}` : meta;
    return `<article class="source-item" data-index="${index}"><strong>${esc(item.title || "未命名")}</strong><small>${esc(summary)}</small><div class="source-card-tags">${labels.map((label) => `<span>${esc(label)}</span>`).join("")}</div><small class="source-labels">${esc(byline)}${byline ? " · " : ""}生词密度 ${metrics.density}% · ${metrics.difficulty}</small><div class="source-card-actions">${item.url ? `<a class="btn-link" href="${esc(item.url)}" target="_blank" rel="noreferrer">预览原文</a>` : ""}<button class="btn-ghost" type="button" data-pick-source="${index}" data-source-kind="${esc(kind)}">选择为题材</button></div></article>`;
  }
  function bindSourceCards(picker, items, kind) {
    picker.querySelectorAll("[data-pick-source]").forEach((button) => button.addEventListener("click", () => {
      const item = items[Number(button.dataset.pickSource)];
      if (!item) return;
      state.source = kind;
      state.sourceSelection = {
        content_id: item.content_id || "",
        work_id: item.work_id || "",
        title: item.title || "",
        author: item.author || "",
        summary: item.summary || item.description || item.excerpt || "",
        excerpt: item.excerpt || item.description || "",
        description: item.description || "",
        labels: item.labels || [],
        url: item.url || "",
        vote_up_count: item.vote_up_count || 0
      };
      document.querySelectorAll(".source-tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.source === kind || kind === "zhihu_search" && tab.dataset.source === "auto"));
      picker.querySelectorAll(".source-item").forEach((row) => row.classList.toggle("is-selected", row.dataset.index === button.dataset.pickSource));
      window.dispatchEvent(new CustomEvent("bookwords:source-selected", { detail: state.sourceSelection }));
    }));
  }
  function sourceQuery() {
    const cards = activeSourceCards();
    const meanings = cards.map((card) => String(card.meaning_cn || card.meaning || "").split(/[；;,，。]/)[0].trim()).filter(Boolean).slice(0, 5);
    const words = cards.map((card) => String(card.word || "").trim()).filter(Boolean).slice(0, 5);
    return (meanings.length ? meanings : words).join(" ").slice(0, 120);
  }
  async function searchOnce(query) {
    const key = query.toLowerCase();
    if (state.zhihuSearchCache.has(key)) return state.zhihuSearchCache.get(key);
    if (pendingSearch && pendingKey === key) return pendingSearch;
    pendingKey = key;
    pendingSearch = Api.zhihuSearch(query, 10).then((result) => {
      if (result.ok) state.zhihuSearchCache.set(key, result);
      return result;
    }).finally(() => {
      pendingKey = "";
      pendingSearch = null;
    });
    return pendingSearch;
  }
  async function renderSourcePicker() {
    const picker = $("#source-picker");
    if (!picker) return;
    const src = state.source;
    if (src === "original") {
      picker.hidden = true;
      picker.innerHTML = "";
      return;
    }
    const cards = activeSourceCards();
    if (cards.length < (state.minCards || 3) && src === "auto") {
      picker.hidden = false;
      picker.innerHTML = '<div class="source-guidance">先加入至少 3 个单词，再匹配知乎题材。</div>';
      return;
    }
    picker.hidden = false;
    if (src === "auto" || src === "zhihu_search") {
      const query = sourceQuery();
      picker.innerHTML = '<div class="source-loading">正在查找相关知乎回答与文章…</div>';
      try {
        const result = await searchOnce(query);
        if (!result.ok) throw new Error(result.error || "知乎搜索失败");
        const items = Array.isArray(result.items) ? result.items : [];
        state.sourceRecommendations = items;
        state.sourceRecommendationKey = cards.map((word) => String(word.word || "").toLowerCase()).sort().join("|");
        renderSourceList(picker, items, result);
      } catch (error) {
        picker.innerHTML = `<div class="source-guidance">知乎选材失败：${esc(error.message)}。可切换到原创，并由设置页配置的外部 AI 生成。</div>`;
      }
    } else if (src === "hot") {
      picker.innerHTML = '<div class="source-loading">正在加载知乎热榜…</div>';
      try {
        const result = await Api.zhihuHot(30);
        if (!result.ok) throw new Error(result.error || "加载热榜失败");
        const items = Array.isArray(result.items) ? result.items : [];
        state.sourceRecommendations = items;
        renderHotList(picker, items, result);
      } catch (error) {
        picker.innerHTML = `<div class="source-guidance">热榜加载失败：${esc(error.message)}</div>`;
      }
    } else if (src === "story") {
      picker.innerHTML = '<div class="source-loading">正在加载知乎故事…</div>';
      try {
        const result = await Api.zhihuStories();
        if (!result.ok) throw new Error(result.error || "加载故事失败");
        const items = Array.isArray(result.items) ? result.items : [];
        state.sourceRecommendations = items;
        renderContentList(picker, items, "story");
      } catch (error) {
        picker.innerHTML = `<div class="source-guidance">故事加载失败：${esc(error.message)}</div>`;
      }
    } else if (src === "knowledge") {
      picker.innerHTML = '<div class="source-loading">正在加载知乎知识…</div>';
      try {
        const result = await Api.zhihuKnowledge();
        if (!result.ok) throw new Error(result.error || "加载知识失败");
        const items = Array.isArray(result.items) ? result.items : [];
        state.sourceRecommendations = items;
        renderContentList(picker, items, "knowledge");
      } catch (error) {
        picker.innerHTML = `<div class="source-guidance">知识加载失败：${esc(error.message)}</div>`;
      }
    }
  }
  function renderSourceList(picker, items, result) {
    if (!items.length) {
      picker.innerHTML = '<div class="source-guidance">暂未找到相关知乎内容，可调整词汇后重试，或使用其他题材。</div>';
      return;
    }
    const remaining = result.quota?.remaining;
    picker.innerHTML = `
    <div class="source-note">按目标词相关度排序，赞同数仅作参考${Number.isFinite(remaining) ? ` · 今日接口剩余 ${remaining}/10 次` : ""}</div>
    <div class="source-items">${items.map((item, index) => sourceCard(item, index, "zhihu_search", `赞同 ${item.vote_up_count || 0}${item.author ? ` · ${item.author}` : ""}`)).join("")}</div>`;
    bindSourceCards(picker, items, "zhihu_search");
  }
  function renderHotList(picker, items, result) {
    if (!items.length) {
      picker.innerHTML = '<div class="source-guidance">热榜暂无内容。</div>';
      return;
    }
    const remaining = result.quota?.remaining;
    picker.innerHTML = `
    <div class="source-note">知乎热榜${Number.isFinite(remaining) ? ` · 今日接口剩余 ${remaining}/10 次` : ""}</div>
    <div class="source-items">${items.map((item, index) => sourceCard(item, index, "hot", item.hot_score !== void 0 ? `热度 ${item.hot_score}` : "知乎热榜")).join("")}</div>`;
    bindSourceCards(picker, items, "hot");
  }
  function renderContentList(picker, items, kind) {
    if (!items.length) {
      picker.innerHTML = '<div class="source-guidance">暂无内容。</div>';
      return;
    }
    const label = kind === "story" ? "故事" : "知识";
    picker.innerHTML = `
    <div class="source-note">知乎${label}</div>
    <div class="source-items">${items.map((item, index) => sourceCard(item, index, kind, `知乎${label}`)).join("")}</div>`;
    bindSourceCards(picker, items, kind);
  }
  function refreshSourcePicker() {
    return renderSourcePicker();
  }
  function bindSourceEvents() {
    document.querySelectorAll(".source-tab").forEach((tab) => {
      tab.addEventListener("click", () => setSource(tab.dataset.source));
    });
  }

  // frontend/js/views/pool.js
  function addToPool(word) {
    if (state.pool.length >= MAX_STORY_CARDS) {
      toast(`文章生成区最多放入 ${MAX_STORY_CARDS} 个单词`);
      return false;
    }
    const key = String(word.word || "").toLowerCase();
    if (state.pool.some((w) => String(w.word || "").toLowerCase() === key)) {
      toast(`「${word.word}」已在文章生成区中`);
      return false;
    }
    state.pool.push({ ...word, addedAt: nowIso() });
    state.targetSelection.add(key);
    state.poolUpdatedAt = nowIso();
    persist();
    window.dispatchEvent(new CustomEvent("bookwords:pool-change"));
    renderStoryPoolView();
    return true;
  }
  function removeFromPool(wordStr) {
    const key = String(wordStr || "").toLowerCase();
    state.pool = state.pool.filter((w) => String(w.word || "").toLowerCase() !== key);
    state.targetSelection.delete(key);
    state.poolUpdatedAt = nowIso();
    persist();
    window.dispatchEvent(new CustomEvent("bookwords:pool-change"));
    renderStoryPoolView();
  }
  function renderStoryPoolView() {
    renderPoolList();
    renderWbWordList();
    if (state.source === "auto") refreshSourcePicker();
  }
  function renderPoolList() {
    const list = $("#story-pool-list");
    if (!list) return;
    const count = $("#story-pool-count");
    const updated = $("#story-pool-updated");
    const selectedCount = state.pool.filter((word) => state.targetSelection.has(String(word.word || "").toLowerCase())).length;
    if (count) count.textContent = `${selectedCount} 已选 · ${state.pool.length} / ${MAX_STORY_CARDS}`;
    if (updated) updated.textContent = state.poolUpdatedAt ? `最近更新：${formatStamp(state.poolUpdatedAt, "") || "时间未知"}` : "尚未添加单词";
    list.innerHTML = state.pool.length ? state.pool.map((word) => `
      <div class="pool-word-row${state.targetSelection.has(String(word.word || "").toLowerCase()) ? " is-target" : ""}" data-word="${esc(word.word)}">
        <label class="pool-target-check" title="选择为本次目标词"><input type="checkbox" data-target-word="${esc(String(word.word || "").toLowerCase())}" ${state.targetSelection.has(String(word.word || "").toLowerCase()) ? "checked" : ""}><span>✓</span></label>
        <span class="pool-word-main"><strong>${esc(word.word)}</strong><small>${esc(wordbookPos(word.pos))} · ${esc(wordbookMeaning(word))}</small></span>
        <time>${esc(formatWordbookTime(word.addedAt))}</time>
        <button class="btn-link pool-word-remove" type="button" data-word="${esc(word.word)}" title="移出生成区">移除</button>
      </div>`).join("") : `<div class="import-empty">文章生成区还是空的。点击“选择生词”，或用上方搜索直接加入。</div>`;
    list.querySelectorAll(".pool-word-remove").forEach((button) => button.addEventListener("click", () => removeFromPool(button.dataset.word)));
    list.querySelectorAll("[data-target-word]").forEach((input) => input.addEventListener("change", () => {
      if (input.checked) state.targetSelection.add(input.dataset.targetWord);
      else state.targetSelection.delete(input.dataset.targetWord);
      window.dispatchEvent(new CustomEvent("bookwords:pool-change"));
      renderPoolList();
    }));
  }
  var wordPickerReturnFocus = null;
  function setWordPicker(open) {
    const backdrop = $("#word-picker-backdrop");
    const trigger = $("#btn-open-word-picker-inline");
    if (!backdrop || !trigger) return;
    if (open) {
      wordPickerReturnFocus = document.activeElement;
      backdrop.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      document.body.classList.add("word-picker-open");
      const dialog = document.querySelector(".word-picker-dialog");
      if (dialog) {
        dialog.style.transform = "translate(-50%, -50%)";
        dialog.classList.remove("is-dragging");
      }
      $("#wb-word-search")?.focus();
    } else {
      backdrop.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      document.body.classList.remove("word-picker-open");
      wordPickerReturnFocus?.focus?.();
      wordPickerReturnFocus = null;
    }
  }
  function renderWbWordList() {
    const list = $("#wb-word-list");
    if (!list) return;
    const count = $("#wb-word-count");
    if (count) count.textContent = state.wordbook.length;
    const query = ($("#wb-word-search")?.value || "").trim().toLowerCase();
    const posFilter = ($("#wb-pos-filter")?.value || "").trim().toLowerCase();
    const words = state.wordbook.filter((word) => {
      const haystack = `${word.word || ""} ${word.meaning_cn || ""} ${word.pos || ""}`.toLowerCase();
      if (query && !haystack.includes(query)) return false;
      if (posFilter && !String(word.pos || "").toLowerCase().startsWith(posFilter)) return false;
      return true;
    });
    if (!words.length) {
      list.innerHTML = `<div class="import-empty">${state.wordbook.length ? "没有匹配的单词" : "单词本还是空的，请先在搜索词库中收藏单词。"}</div>`;
      updateWbSelection();
      return;
    }
    list.innerHTML = words.map((word) => {
      const key = String(word.word || "").toLowerCase();
      const checked = state.wbSelection.has(key);
      const inPool = state.pool.some((w) => String(w.word || "").toLowerCase() === key);
      const disabled = !checked && state.wbSelection.size >= MAX_STORY_CARDS;
      return `<label class="import-word-row${checked ? " is-selected" : ""}${disabled ? " is-disabled" : ""}" data-word="${esc(key)}" draggable="${disabled ? "false" : "true"}"><input class="import-word-check" type="checkbox" data-word="${esc(key)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}><span class="import-checkmark" aria-hidden="true">✓</span><span class="import-word-main"><strong>${esc(word.word)}</strong><small>${esc(wordbookPos(word.pos))} · ${esc(wordbookMeaning(word))}</small></span>${inPool ? '<span class="wb-in-pool">已加入</span>' : ""}<time>${esc(formatWordbookTime(word.savedAt))}</time></label>`;
    }).join("");
    list.querySelectorAll(".import-word-check").forEach((input) => input.addEventListener("change", () => {
      if (input.checked) state.wbSelection.add(input.dataset.word);
      else state.wbSelection.delete(input.dataset.word);
      renderWbWordList();
    }));
    list.querySelectorAll(".import-word-row[draggable='true']").forEach((row) => row.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/plain", row.dataset.word || "");
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
      row.classList.add("is-dragging");
    }));
    list.querySelectorAll(".import-word-row").forEach((row) => row.addEventListener("dragend", () => row.classList.remove("is-dragging")));
    updateWbSelection();
  }
  function updateWbSelection() {
    const selected = $("#wb-selected-count");
    if (selected) selected.textContent = `已选 ${state.wbSelection.size} / ${MAX_STORY_CARDS}`;
    const btn = $("#btn-wb-add-selected");
    if (btn) btn.disabled = state.wbSelection.size < 1;
  }
  function addWbSelectionToPool() {
    if (!state.wbSelection.size) return;
    const now = nowIso();
    const oldTimes = new Map(state.pool.map((word) => [String(word.word || "").toLowerCase(), word.addedAt]));
    let added = 0;
    for (const word of state.wordbook) {
      const key = String(word.word || "").toLowerCase();
      if (!state.wbSelection.has(key)) continue;
      if (state.pool.some((w) => String(w.word || "").toLowerCase() === key)) continue;
      if (state.pool.length >= MAX_STORY_CARDS) {
        toast(`文章生成区最多放入 ${MAX_STORY_CARDS} 个单词`);
        break;
      }
      state.pool.push({ ...word, addedAt: oldTimes.get(key) || now });
      state.targetSelection.add(key);
      added++;
    }
    state.wbSelection.clear();
    if (added) {
      state.poolUpdatedAt = nowIso();
      persist();
      window.dispatchEvent(new CustomEvent("bookwords:pool-change"));
      emit("pool");
    }
    renderStoryPoolView();
    toast(added ? `已加入 ${added} 个单词到文章生成区` : "所选单词都已在文章生成区中");
    if (added) setWordPicker(false);
  }
  var poolSearchToken = 0;
  var poolSearchWords = [];
  async function renderPoolSearchResults() {
    const box = $("#pool-search-results");
    if (!box) return;
    const q = ($("#pool-search")?.value || "").trim();
    poolSearchToken += 1;
    const token = poolSearchToken;
    if (!q) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    let words = [];
    try {
      const r = await Api.searchWords(q, "all", 8, "");
      words = r.words || [];
    } catch (e) {
    }
    if (token !== poolSearchToken) return;
    poolSearchWords = words;
    box.hidden = false;
    if (!words.length) {
      box.innerHTML = `<div class="pool-search-empty">没有找到匹配的单词</div>`;
      return;
    }
    box.innerHTML = words.map((w) => {
      const inPool = state.pool.some((p) => String(p.word || "").toLowerCase() === String(w.word || "").toLowerCase());
      return `<div class="pool-search-row"><span class="pool-search-main"><strong>${esc(w.word)}</strong><small>${esc(wordbookPos(w.pos))} · ${esc(wordbookMeaning(w))}</small></span><button class="btn-link pool-search-add" type="button" data-word="${esc(w.word)}"${inPool ? " disabled" : ""}>${inPool ? "已在池" : "加入"}</button></div>`;
    }).join("");
    box.querySelectorAll(".pool-search-add").forEach((button) => button.addEventListener("click", () => {
      const word = poolSearchWords.find((item) => item.word === button.dataset.word);
      if (!word) return;
      if (addToPool(word)) {
        toast(`「${word.word}」已加入文章生成区`);
        renderPoolSearchResults();
      }
    }));
  }
  function bindPoolEvents() {
    $("#btn-open-word-picker-inline")?.addEventListener("click", () => setWordPicker(true));
    $("#btn-toggle-pool-words")?.addEventListener("click", () => {
      const dropdown = $("#pool-words-dropdown");
      const button = $("#btn-toggle-pool-words");
      if (!dropdown || !button) return;
      const opening = dropdown.hidden;
      dropdown.hidden = !opening;
      button.setAttribute("aria-expanded", opening ? "true" : "false");
      const title = button.querySelector("strong");
      const note = button.querySelector("small");
      if (title) title.textContent = opening ? "收起词汇" : "展开词汇";
      if (note) note.textContent = opening ? "隐藏池中单词，继续后续操作" : "查看、勾选或移除池中单词";
    });
    $("#btn-close-word-picker")?.addEventListener("click", () => setWordPicker(false));
    $("#word-picker-backdrop")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) setWordPicker(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("#word-picker-backdrop")?.hidden) setWordPicker(false);
    });
    $("#btn-clear-pool").addEventListener("click", () => {
      state.pool = [];
      state.targetSelection = /* @__PURE__ */ new Set();
      state.poolUpdatedAt = nowIso();
      persist();
      window.dispatchEvent(new CustomEvent("bookwords:pool-change"));
      state.lastStory = null;
      state.lastArticleId = "";
      state.practiceCompleted = false;
      renderStoryPoolView();
      renderPractice();
      toast("文章生成区已清空");
    });
    const dropzoneHost = $("#story-pool-list");
    dropzoneHost.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      dropzoneHost.classList.add("is-dragover");
    });
    dropzoneHost.addEventListener("dragleave", (event) => {
      if (!dropzoneHost.contains(event.relatedTarget)) dropzoneHost.classList.remove("is-dragover");
    });
    dropzoneHost.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzoneHost.classList.remove("is-dragover");
      const key = String(event.dataTransfer?.getData("text/plain") || "").toLowerCase();
      const word = state.wordbook.find((item) => String(item.word || "").toLowerCase() === key);
      if (word && addToPool(word)) toast(`「${word.word}」已加入文章生成区`);
    });
    $("#wb-word-search").addEventListener("input", renderWbWordList);
    $("#wb-pos-filter").addEventListener("change", renderWbWordList);
    $("#btn-wb-select-all").addEventListener("click", () => {
      const visible = [...document.querySelectorAll("#wb-word-list .import-word-check:not(:disabled)")];
      const allSelected = visible.length > 0 && visible.every((input) => input.checked);
      visible.forEach((input) => {
        if (allSelected) state.wbSelection.delete(input.dataset.word);
        else if (state.wbSelection.size < MAX_STORY_CARDS || state.wbSelection.has(input.dataset.word)) state.wbSelection.add(input.dataset.word);
      });
      renderWbWordList();
    });
    $("#btn-wb-add-selected").addEventListener("click", addWbSelectionToPool);
    $("#pool-search-form").addEventListener("submit", (event) => {
      event.preventDefault();
      renderPoolSearchResults();
    });
    let poolSearchTimer;
    $("#pool-search").addEventListener("input", () => {
      clearTimeout(poolSearchTimer);
      poolSearchTimer = setTimeout(renderPoolSearchResults, 180);
    });
  }

  // frontend/js/views/ai-debug.js
  var panel = null;
  var bodyEl = null;
  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "ai-debug";
    panel.setAttribute("role", "log");
    panel.setAttribute("aria-label", "AI 调试台");
    panel.innerHTML = `
    <div class="ai-debug-titlebar">
      <span class="ai-debug-icon" aria-hidden="true">C:\\&gt;</span>
      <span class="ai-debug-title">ai-debug — 模型交互轨迹</span>
      <span class="ai-debug-btns">
        <button type="button" class="ai-debug-btn" data-act="min" aria-label="最小化">—</button>
        <button type="button" class="ai-debug-btn" data-act="close" aria-label="关闭">×</button>
      </span>
    </div>
    <div class="ai-debug-body"></div>`;
    document.body.appendChild(panel);
    bodyEl = panel.querySelector(".ai-debug-body");
    panel.querySelector('[data-act="min"]').addEventListener("click", () => {
      panel.classList.toggle("is-min");
    });
    panel.querySelector('[data-act="close"]').addEventListener("click", () => {
      panel.classList.add("is-hidden");
    });
    return panel;
  }
  function line(text, cls = "") {
    const div = document.createElement("div");
    div.className = `ai-line ${cls}`.trim();
    div.textContent = text;
    bodyEl.appendChild(div);
    return div;
  }
  function block(label, text) {
    const det = document.createElement("details");
    det.className = "ai-block";
    det.innerHTML = `<summary><span class="ai-mark" aria-hidden="true">▸</span> ${esc(label)}</summary><pre>${esc(text)}</pre>`;
    det.addEventListener("toggle", () => {
      det.querySelector(".ai-mark").textContent = det.open ? "▾" : "▸";
    });
    bodyEl.appendChild(det);
  }
  function aiDebugBegin(url) {
    const p = ensurePanel();
    p.classList.remove("is-hidden", "is-min");
    bodyEl.innerHTML = "";
    line(`$ POST ${url}`, "cmd");
    line("… 请求已发出，等待模型响应（长文生成通常 10–60s）", "pending");
  }
  function aiDebugEnd(debug, ok2, errMsg) {
    ensurePanel();
    bodyEl.innerHTML = "";
    if (!debug) {
      line("$ 未返回调试轨迹", "dim");
      if (errMsg) line(`✗ ${errMsg}`, "err");
      return;
    }
    line(`$ provider : ${debug.provider_name || "?"} (${debug.provider || "?"})`);
    line(`$ model    : ${debug.model || "?"}`);
    line(`$ base_url : ${debug.base_url || "?"}`);
    line(`$ level    : ${debug.level || "?"} · 来源 ${debug.source || "original"}`);
    line(`$ params   : ${JSON.stringify(debug.params || {})}`);
    line(`$ words    : ${(debug.words || []).join(", ") || "(无)"}`);
    if (debug.fail) {
      line(`✗ ${debug.fail}`, "err");
      return;
    }
    const attempts = debug.attempts || [];
    attempts.forEach((a) => {
      line("", "dim");
      line(`── 第 ${a.n} 次请求 ${a.elapsed_ms != null ? `· ${(a.elapsed_ms / 1e3).toFixed(1)}s` : ""} ──`, "dim");
      (a.messages || []).forEach((m) => {
        const c = String(m.content || "");
        block(`[${m.role}] ${c.length} 字符`, c);
      });
      if (a.error) {
        line(`✗ ${a.error}`, "err");
      } else if (a.raw != null) {
        block(`模型响应 · ${String(a.raw).length} 字符（点击展开原始输出）`, String(a.raw));
        line("✓ 结构校验通过", "ok");
      }
    });
    if (ok2) line("✓ 生成成功，结果已交付", "ok");
    else if (errMsg && !attempts.some((a) => a.error)) line(`✗ ${errMsg}`, "err");
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // frontend/js/views/generate.js
  function localDateStart(daysAgo = 0) {
    const date = /* @__PURE__ */ new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - daysAgo);
    return date;
  }
  function recentMemoryCards(days = 3) {
    const start = localDateStart(days - 1).getTime();
    const seen = /* @__PURE__ */ new Set();
    const candidates = state.wordbook.map((card) => ({ card, stamp: new Date(card.savedAt || card.addedAt || "").getTime() }));
    state.articles.forEach((article) => {
      const stamp = new Date(article.lastPracticedAt || article.generatedAt || article.savedAt || "").getTime();
      (article.targetCards || []).forEach((card) => candidates.push({ card, stamp }));
    });
    state.recentMistakes.forEach((item) => {
      candidates.push({ card: item.card || { word: item.word }, stamp: new Date(item.wrongAt || "").getTime() });
    });
    return candidates.filter((item) => Number.isFinite(item.stamp) && item.stamp >= start).sort((a, b) => b.stamp - a.stamp).map((item) => item.card).filter((card) => {
      const key = String(card.word || "").toLowerCase();
      if (!key || seen.has(key) || state.masteredWords[key]) return false;
      seen.add(key);
      return true;
    });
  }
  function generationCards() {
    return state.memoryScope === "recent_3d" ? recentMemoryCards(state.coverageDays || 3) : state.pool.filter((card) => state.targetSelection.has(String(card.word || "").toLowerCase()));
  }
  function diffLevel(v) {
    if (v <= 3) return "junior";
    if (v <= 6) return "senior";
    return "cet";
  }
  function diffLabel(v) {
    const lbl = { junior: "初中 · 简单", senior: "高中 · 中等", cet: "四六级 · 进阶" };
    return lbl[diffLevel(v)];
  }
  function updateDiffVal() {
    const v = Number($("#diff-slider").value || 3);
    state.diff = v;
    $("#diff-val").textContent = diffLabel(v);
  }
  function updateLengthVal() {
    const input = $("#length-slider");
    if (!input) return;
    state.sliders.length = Math.max(180, Math.min(600, Number(input.value || 220)));
    $("#length-val").textContent = `约 ${state.sliders.length} 词`;
  }
  var PARAM_META = {
    density: { bucket: (v) => v <= 4 ? "低" : v <= 7 ? "中" : "高" },
    richness: { bucket: (v) => v <= 4 ? "低" : v <= 7 ? "中" : "高" },
    reasoning: { bucket: (v) => v <= 4 ? "低" : v <= 7 ? "中" : "高" },
    abstraction: { bucket: (v) => v <= 4 ? "低" : v <= 7 ? "中" : "高" }
  };
  function closeTuneDropdowns() {
    document.querySelectorAll(".tune-field.is-open").forEach((field) => {
      field.classList.remove("is-open");
      field.querySelector(".tune-trigger")?.setAttribute("aria-expanded", "false");
    });
  }
  function wireParamSelect(key) {
    const input = document.getElementById(`param-${key}`);
    if (!input) return;
    const meta = PARAM_META[key];
    const field = input.closest(".tune-field");
    const trigger = field?.querySelector(".tune-trigger");
    const options = field?.querySelector(".tune-options");
    const upd = () => {
      const v = Number(input.value);
      state.sliders[key] = v;
      if (trigger) {
        const selected = options?.querySelector(`.tune-option[data-value="${v}"]`);
        trigger.querySelector(".tune-value").textContent = selected?.textContent.trim() || `${meta.bucket(v)} · ${v}`;
        options?.querySelectorAll(".tune-option").forEach((option) => {
          const active = option === selected;
          option.classList.toggle("is-selected", active);
          option.setAttribute("aria-selected", active ? "true" : "false");
        });
      }
    };
    input.addEventListener("change", upd);
    trigger?.addEventListener("click", (event) => {
      event.stopPropagation();
      const opening = !field.classList.contains("is-open");
      closeTuneDropdowns();
      field.classList.toggle("is-open", opening);
      trigger.setAttribute("aria-expanded", opening ? "true" : "false");
    });
    options?.querySelectorAll(".tune-option").forEach((option) => {
      option.addEventListener("click", () => {
        input.value = option.dataset.value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        closeTuneDropdowns();
      });
    });
    upd();
  }
  function setLoading(on2) {
    state.generating = on2;
    const btn = $("#btn-generate");
    btn.disabled = on2;
    const label = btn.querySelector("span:first-child");
    if (label) label.textContent = on2 ? "正在排版…" : "生成知乎英语日报";
  }
  var curtainRunId = 0;
  var curtainCleanup = null;
  var curtainClamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
  var curtainLerp = (a, b, t) => a + (b - a) * t;
  var curtainRand = (a, b) => a + Math.random() * (b - a);
  var curtainInt = (a, b) => Math.floor(curtainRand(a, b + 1));
  function playCurtainAnimation(words, onComplete) {
    const overlay = $("#generation-overlay");
    const orbit = overlay?.querySelector(".generation-orbit");
    if (!overlay || !orbit) return;
    curtainCleanup?.();
    curtainCleanup = null;
    const runId = ++curtainRunId;
    const canvas = document.createElement("canvas");
    canvas.className = "generation-curtain-canvas";
    canvas.setAttribute("aria-label", "英文字母窗帘：划过拨开，点击加速");
    orbit.prepend(canvas);
    const note = document.createElement("span");
    note.className = "generation-curtain-note";
    note.textContent = "划过拨开字母帘 · 点击加速吸入";
    orbit.append(note);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sourceWords = words.map((word) => String(word.word || "").trim().toUpperCase()).filter(Boolean);
    const groups = [];
    for (let index = 0; index < sourceWords.length; index += 3) groups.push(sourceWords.slice(index, index + 3).join(" "));
    if (!groups.length) groups.push("DREAM BIG NOW");
    let groupIndex = 0;
    let chars = [...groups[groupIndex]];
    const COLS = 18, ROWS = 18, ROW_SPACING = 24;
    const GRAVITY = reduced ? 0.4 : 0.22;
    const DRAG = 0.03;
    const SOLVER_PASSES = 4;
    const HOME_PULL = 0.35;
    const MOUSE_RADIUS = 84;
    const MOUSE_FORCE = 4.6;
    const MOUSE_Y_BIAS = 0.35;
    const SPEED_FOR_FULL_FADE = 8;
    const nodes = [];
    const links = [];
    const at = (c, r) => nodes[c * ROWS + r];
    const S = { w: 0, h: 0, dpr: 1, cardW: 420, x0: 0, y0: 0, font: 16, phase: "idle", since: performance.now(), nextPick: 0, raf: 0 };
    function layout() {
      S.cardW = Math.min(S.w * 0.86, 430);
      S.x0 = (S.w - S.cardW) / 2;
      S.y0 = Math.max(16, (S.h - ROWS * ROW_SPACING) / 2);
      S.font = Math.max(11, Math.min(20, ROW_SPACING * 0.72));
    }
    function build() {
      nodes.length = 0;
      links.length = 0;
      layout();
      const colSpacing = S.cardW / (COLS - 1);
      let i = 0;
      for (let c = 0; c < COLS; c += 1) {
        for (let r = 0; r < ROWS; r += 1) {
          const x = S.x0 + c * colSpacing;
          const y = S.y0 + r * ROW_SPACING;
          nodes.push({ x, y, oldX: x, oldY: y, initX: x, initY: y, char: chars[i++ % chars.length], isAnchor: r === 0, status: "pending", started: 0, duration: 0 });
        }
      }
      for (let c = 0; c < COLS; c += 1) for (let r = 1; r < ROWS; r += 1) links.push({ a: at(c, r - 1), b: at(c, r), len: ROW_SPACING });
    }
    function resize() {
      const rect = orbit.getBoundingClientRect();
      if (!rect.width) return;
      S.w = rect.width;
      S.h = rect.height;
      S.dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(S.w * S.dpr);
      canvas.height = Math.round(S.h * S.dpr);
      canvas.style.width = `${S.w}px`;
      canvas.style.height = `${S.h}px`;
      ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      layout();
      const colSpacing = S.cardW / (COLS - 1);
      for (let c = 0; c < COLS; c += 1) {
        const head = at(c, 0);
        if (!head) continue;
        const nx = S.x0 + c * colSpacing;
        head.x = nx;
        head.oldX = nx;
        head.initX = nx;
        head.initY = S.y0;
      }
    }
    function setPhase(phase, now) {
      S.phase = phase;
      S.since = now;
      if (phase === "sucking") S.nextPick = now;
      const label = $("#generation-status-text");
      if (label && overlay.dataset.phase !== "choice") {
        label.textContent = overlay.dataset.phase === "compose" ? "正在编排文章" : phase === "idle" ? "等待识别" : phase === "waiting" ? "识别完成" : "正在吸入词汇";
      }
    }
    function startNode(node, now, boosted = false) {
      node.status = "sucking";
      node.started = now;
      node.duration = boosted ? curtainRand(600, 900) : curtainRand(1400, 2100);
    }
    function boost(now) {
      if (S.phase === "waiting") {
        startNext();
        return;
      }
      if (S.phase === "idle") setPhase("sucking", now);
      nodes.filter((n) => n.status === "pending" && !n.isAnchor).forEach((n, index) => startNode(n, now + index * 6, true));
      nodes.filter((n) => n.status === "sucking").forEach((n) => {
        n.duration = Math.min(n.duration, 800);
      });
      S.nextPick = Number.POSITIVE_INFINITY;
    }
    function startNext() {
      if (runId !== curtainRunId) return;
      groupIndex = (groupIndex + 1) % groups.length;
      chars = [...groups[groupIndex]];
      build();
      setPhase("idle", performance.now());
    }
    let mouseX = 0, mouseY = 0, mouseActive = false;
    function onMove(event) {
      const rect = canvas.getBoundingClientRect();
      mouseX = event.clientX - rect.left;
      mouseY = event.clientY - rect.top;
      mouseActive = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    }
    overlay.addEventListener("pointermove", onMove, { passive: true });
    overlay.addEventListener("pointerleave", () => {
      mouseActive = false;
    });
    function step() {
      for (const n of nodes) {
        const vx = (n.x - n.oldX) * (1 - DRAG);
        const vy = (n.y - n.oldY) * (1 - DRAG);
        n.oldX = n.x;
        n.oldY = n.y;
        n.x += vx;
        n.y += vy + (n.isAnchor ? 0 : GRAVITY);
      }
      for (const n of nodes) {
        if (!n.isAnchor) continue;
        n.x += (n.initX - n.x) * HOME_PULL;
        n.y += (n.initY - n.y) * HOME_PULL;
      }
      if (mouseActive && !reduced) {
        for (const n of nodes) {
          const dx = n.x - mouseX, dy = n.y - mouseY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist >= MOUSE_RADIUS || dist === 0) continue;
          const pct = 1 - dist / MOUSE_RADIUS;
          const force = pct * pct * MOUSE_FORCE;
          const grip = n.isAnchor ? 0.75 : 1;
          n.x += dx / dist * force * grip;
          n.y += dy / dist * force * MOUSE_Y_BIAS * grip;
        }
      }
      for (let pass = 0; pass < SOLVER_PASSES; pass += 1) {
        for (const l of links) {
          const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist === 0) continue;
          const pct = (l.len - dist) / dist * 0.5;
          const ox = dx * pct, oy = dy * pct;
          l.a.x -= ox;
          l.a.y -= oy;
          l.b.x += ox;
          l.b.y += oy;
        }
      }
    }
    function draw(now) {
      ctx.clearRect(0, 0, S.w, S.h);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `500 ${S.font}px "Space Grotesk", "PingFang SC", "Microsoft YaHei", sans-serif`;
      for (const n of nodes) {
        if (n.isAnchor || n.status === "done") continue;
        let alpha, rgb;
        if (n.status === "sucking") {
          const p = curtainClamp((now - n.started) / n.duration);
          const warm = curtainClamp(p / 0.8);
          rgb = `${Math.round(curtainLerp(23, 242, warm))},${Math.round(curtainLerp(114, 145, warm))},${Math.round(curtainLerp(246, 83, warm))}`;
          alpha = p < 0.55 ? 0.95 : curtainLerp(0.95, 0, (p - 0.55) / 0.45);
        } else {
          const speed = Math.hypot(n.x - n.oldX, n.y - n.oldY);
          const fade = curtainClamp(speed / SPEED_FOR_FULL_FADE);
          rgb = `${Math.round(curtainLerp(23, 122, fade))},${Math.round(curtainLerp(114, 168, fade))},${Math.round(curtainLerp(246, 250, fade))}`;
          alpha = curtainLerp(0.78, 0.3, fade);
        }
        ctx.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
        ctx.fillText(n.char, n.x, n.y);
      }
    }
    function tick(now) {
      if (runId !== curtainRunId || overlay.hidden) return;
      if (S.phase === "idle" && now - S.since >= 1200) setPhase("sucking", now);
      if (S.phase === "sucking") {
        const pending = () => nodes.filter((n) => n.status === "pending" && !n.isAnchor);
        while (now >= S.nextPick && pending().length) {
          const list = pending();
          startNode(list[curtainInt(0, list.length - 1)], now);
          S.nextPick = now + curtainLerp(320, 110, 1 - list.length / Math.max(1, nodes.length));
        }
        for (const n of nodes) if (n.status === "sucking" && now - n.started >= n.duration) n.status = "done";
        if (!pending().length && !nodes.some((n) => n.status === "sucking")) setPhase("waiting", now);
      } else if (S.phase === "waiting" && now - S.since >= 600) {
        startNext();
      }
      step();
      draw(now);
      const body = nodes.filter((n) => !n.isAnchor);
      const done = body.reduce((acc, n) => acc + (n.status === "done" ? 1 : n.status === "sucking" ? curtainClamp((now - n.started) / n.duration) : 0), 0);
      const progressValue = S.phase === "waiting" ? 1 : done / Math.max(1, body.length);
      const progressBar = overlay.querySelector(".generation-progress");
      if (progressBar) progressBar.style.setProperty("--vortex-progress", `${Math.round(progressValue * 100)}%`);
      S.raf = requestAnimationFrame(tick);
    }
    resize();
    build();
    const activate = () => boost(performance.now());
    const onPointer = (event) => {
      if (event.target === overlay || event.target === orbit || event.target === canvas) activate();
    };
    const onKey = (event) => {
      if (event.code === "Space" && !event.repeat) {
        event.preventDefault();
        activate();
      }
    };
    overlay.addEventListener("pointerdown", onPointer, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", resize, { passive: true });
    S.raf = requestAnimationFrame(tick);
    const cleanup = () => {
      cancelAnimationFrame(S.raf);
      overlay.removeEventListener("pointerdown", onPointer);
      overlay.removeEventListener("pointermove", onMove);
      overlay.removeEventListener("pointerleave", () => {
        mouseActive = false;
      });
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", resize);
      canvas.remove();
      note.remove();
      if (runId === curtainRunId) onComplete?.();
    };
    curtainCleanup = cleanup;
    return cleanup;
  }
  function generationOverlay(on2, phase = "wait") {
    const overlay = $("#generation-overlay");
    const stage = $("#generation-stage");
    const pool = $("#story-pool-view");
    if (!overlay) return;
    if (on2) {
      const wasHidden = overlay.hidden;
      overlay.hidden = false;
      overlay.dataset.phase = phase;
      overlay.classList.toggle("has-generation-choice", phase === "choice");
      document.body.classList.add("is-generating");
      if (pool) pool.classList.add("is-generating");
      if (stage) stage.hidden = false;
      if (wasHidden) {
        const words = generationCards().slice(0, 80);
        playCurtainAnimation(words);
      }
      const wordHost = stage?.querySelector(".generation-stage-words");
      if (wordHost) {
        wordHost.innerHTML = generationCards().slice(0, 20).map((word, index) => `<span style="--i:${index}">${esc(word.word || "")}</span>`).join("");
      }
    } else {
      curtainCleanup?.();
      curtainCleanup = null;
      curtainRunId += 1;
      overlay.hidden = true;
      overlay.classList.remove("has-generation-choice");
      document.body.classList.remove("is-generating");
      if (pool) pool.classList.remove("is-generating");
      if (stage) stage.hidden = true;
    }
    const label = $("#generation-status-text");
    if (label) label.textContent = phase === "compose" ? "正在编排文章" : phase === "choice" ? "识别完成，选择编排方式" : "等待识别";
    const choices = overlay.querySelector(".generation-choice");
    if (choices) choices.hidden = phase !== "choice";
    const original = overlay.querySelector('[data-generation-choice="original"] strong');
    if (original) original.textContent = state.source === "original" ? "原创" : "建议原创";
  }
  async function generateConfirmedArticle(signal = null) {
    if (state.generating) return;
    const need = state.minCards || 3;
    const candidateCards = generationCards();
    if (candidateCards.length < need) {
      throw new Error(`故事需要至少 ${need} 张卡牌`);
    }
    setLoading(true);
    generationOverlay(true, "wait");
    aiDebugBegin("/api/generate/story");
    let debugShown = false;
    try {
      const words = state.pool.slice(0, MAX_STORY_CARDS).map(({ addedAt, ...word }) => word);
      const recentCards = recentMemoryCards(state.coverageDays || 3).slice(0, 80).map(({ addedAt, ...word }) => word);
      const options = {
        memoryScope: state.memoryScope,
        language: state.articleLanguage,
        recentCards,
        confirmedGroup: state.selectedGroup,
        lockedWords: Array.from(state.lockedWords),
        excludedWords: Array.from(state.excludedWords),
        originalTopic: state.originalTopic,
        signal
      };
      let data = await Api.generate("story", words, diffLevel(state.diff), state.sliders, state.source, state.sourceSelection, options);
      aiDebugEnd(data.debug || null, !data.error, data.error);
      debugShown = true;
      if (data.error) throw new Error(data.error);
      generationOverlay(true, "compose");
      renderResult(data);
      return data;
    } catch (err) {
      if (!debugShown) aiDebugEnd(err.data?.debug || null, false, err.data?.error || err.message);
      if (err.name !== "AbortError") toast("生成失败：" + err.message);
      throw err;
    } finally {
      setLoading(false);
      setTimeout(() => generationOverlay(false), 520);
    }
  }
  function renderResult(data) {
    const box = $("#result");
    if (data.story) {
      const s = data.story;
      state.lastGeneration = data;
      state.lastStory = s;
      const selectedCards = (data.sorting?.selected_group?.words || []).map((word) => candidateCardByWord(word)).filter(Boolean);
      const issue = saveArticle(s, {
        cards: selectedCards,
        language: data.language?.selected || state.articleLanguage,
        memoryScope: data.memory_scope || state.memoryScope,
        sorting: data.sorting || {}
      });
      renderArticleBook();
      state.practiceCompleted = false;
      const week = dailyWeekInfo(issue.generatedAt);
      box.innerHTML = `
      <div class="result-card">
        <div class="result-mode-tabs" role="tablist"><button class="is-active" type="button" data-result-mode="reading">阅读</button><button type="button" data-result-mode="practice">练习</button></div>
        <div data-result-pane="reading">
        <div class="result-publication"><span>ZHIHU ENGLISH DAILY</span><span>${esc(week.label)} · ${esc(genreLabelEn(issue.genre))}</span></div>
        <h3 class="result-title">${esc(s.title || "知乎英语日报")}</h3>
        <p class="result-dateline">${esc(s.dateline || "Zhihu Daily")} · 知乎英语日报编辑台</p>
        <div class="result-language-block"><span>${state.articleLanguage === "zh" ? "中文呈现" : "ENGLISH"}</span><p class="result-en">${interactiveWords(state.articleLanguage === "zh" ? s.zh : s.en)}</p></div>
        ${s.takeaway ? `<p class="result-takeaway"><span>Takeaway</span>${esc(s.takeaway)}</p>` : ""}
        <div class="result-language-block result-translation"><span>${state.articleLanguage === "zh" ? "ENGLISH REFERENCE" : "中文翻译"}</span><p class="result-cn">${interactiveWords(state.articleLanguage === "zh" ? s.en : s.zh || withStoryGlosses(s.cn, s))}</p></div>
        <p class="newspaper-source-note">${esc(s.source_note || "来源：AI 原创生成｜Bookwords 英语学习材料")}${s.source_url ? ` · <a href="${esc(s.source_url)}" target="_blank" rel="noreferrer">查看原链接</a>` : ""}</p>
        ${s.validation_warnings?.length ? `<div class="article-quality-warning"><strong>校对提醒</strong><span>${esc(s.validation_warnings.join("；"))}。可返回文章方案调整，或重新生成。</span></div>` : ""}
        </div><div data-result-pane="practice" hidden><div id="inline-practice"></div></div>
      </div>`;
      box.querySelectorAll("[data-result-mode]").forEach((button) => button.addEventListener("click", () => setResultMode(button.dataset.resultMode)));
      box.querySelectorAll("[data-read-word]").forEach((button) => button.addEventListener("click", () => openWordPopup(button.dataset.readWord, button.closest("p")?.textContent || "")));
      renderPractice();
      renderInlinePractice();
    }
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function bindGenerateEvents() {
    $("#diff-slider").addEventListener("input", updateDiffVal);
    $("#length-slider").addEventListener("input", updateLengthVal);
    Object.keys(PARAM_META).forEach(wireParamSelect);
    document.addEventListener("click", closeTuneDropdowns);
    document.querySelectorAll('input[name="memory-scope"]').forEach((input) => input.addEventListener("change", (event) => {
      state.memoryScope = event.target.value === "recent_3d" ? "recent_3d" : "pool";
      const count = recentMemoryCards(3).length;
      const note = $("#recent-memory-note");
      if (note) note.textContent = `包含今天、昨天和前天收藏的 ${count} 个单词`;
      if (state.source === "auto") document.querySelector('.source-tab[data-source="auto"]')?.click();
    }));
    document.querySelectorAll('input[name="article-language"]').forEach((input) => input.addEventListener("change", (event) => {
      state.articleLanguage = event.target.value === "zh" ? "zh" : "en";
    }));
  }
  function interactiveWords(text) {
    return esc(text).replace(/\*\*([^*]+)\*\*/g, (_, word) => {
      const key = String(word).trim().toLowerCase();
      return `<button class="reading-word${state.masteredWords[key] ? " is-mastered" : ""}" type="button" data-read-word="${esc(key)}">${esc(word)}</button>`;
    }).replace(/\n/g, "<br>");
  }
  function activeTargetCard(key) {
    const article = state.articles.find((item) => item.id === state.lastArticleId);
    return (article?.targetCards || []).find((card) => String(card.word || "").toLowerCase() === key) || state.wordbook.find((card) => String(card.word || "").toLowerCase() === key) || generationCards().find((card) => String(card.word || "").toLowerCase() === key);
  }
  function openWordPopup(key, context) {
    const card = activeTargetCard(key) || { word: key };
    const saved = state.wordbook.some((item) => String(item.word || "").toLowerCase() === key);
    const mastered = Boolean(state.masteredWords[key]);
    const modal = $("#reading-word-modal");
    $("#reading-word-title").textContent = card.word || key;
    $("#reading-word-phonetic").textContent = card.phonetic || "暂无音标";
    $("#reading-word-meaning").textContent = `${card.pos || "词汇"} · ${card.meaning_cn || card.meaning || card.meaning_en || "暂无释义"}`;
    const sentence = String(context || "").split(/(?<=[.!?。！？])\s*/).find((part) => part.toLowerCase().includes(key)) || context;
    $("#reading-word-context").textContent = sentence;
    const save = $("#btn-reading-save-word");
    save.disabled = saved;
    save.textContent = saved ? "已在单词本" : "加入单词本";
    save.dataset.word = key;
    const master = $("#btn-reading-master-word");
    master.textContent = mastered ? "取消已掌握" : "标记已掌握";
    master.dataset.word = key;
    modal.hidden = false;
  }
  function setResultMode(mode) {
    state.resultMode = mode === "practice" ? "practice" : "reading";
    document.querySelectorAll("[data-result-mode]").forEach((button) => button.classList.toggle("is-active", button.dataset.resultMode === state.resultMode));
    document.querySelectorAll("[data-result-pane]").forEach((pane) => pane.hidden = pane.dataset.resultPane !== state.resultMode);
    if (state.resultMode === "practice") renderInlinePractice();
  }
  function bindReadingWordEvents() {
    $("#btn-close-reading-word")?.addEventListener("click", () => $("#reading-word-modal").hidden = true);
    $("#reading-word-modal")?.addEventListener("click", (event) => {
      if (event.target.id === "reading-word-modal") event.currentTarget.hidden = true;
    });
    $("#btn-reading-save-word")?.addEventListener("click", (event) => {
      const card = activeTargetCard(event.currentTarget.dataset.word);
      if (!card) return;
      if (!state.wordbook.some((item) => String(item.word || "").toLowerCase() === String(card.word || "").toLowerCase())) {
        state.wordbook.unshift({ ...card, savedAt: (/* @__PURE__ */ new Date()).toISOString() });
        persist();
        emit("wordbook");
        toast(`「${card.word}」已加入单词本`);
      }
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = "已在单词本";
    });
    $("#btn-reading-master-word")?.addEventListener("click", (event) => {
      const key = event.currentTarget.dataset.word;
      if (state.masteredWords[key]) delete state.masteredWords[key];
      else state.masteredWords[key] = (/* @__PURE__ */ new Date()).toISOString();
      persist();
      event.currentTarget.textContent = state.masteredWords[key] ? "取消已掌握" : "标记已掌握";
      document.querySelectorAll(`[data-read-word="${CSS.escape(key)}"]`).forEach((word) => word.classList.toggle("is-mastered", Boolean(state.masteredWords[key])));
    });
  }
  function candidateCardByWord(word) {
    const key = String(word || "").toLowerCase();
    return generationCards().find((card) => String(card.word || "").toLowerCase() === key) || null;
  }

  // frontend/js/views/daily.js
  function renderDaily() {
    const week = $("#daily-week");
    const button = $("#btn-daily-checkin");
    const today = dateKey();
    const recordMap = new Map(state.dailyRecords.map((item) => [item.date, item]));
    const checkedToday = recordMap.has(today);
    if (button) {
      button.disabled = checkedToday;
      button.querySelector(".btn-arrow")?.remove();
      if (checkedToday) button.childNodes[0].textContent = "今日已完成 ";
      else if (!button.querySelector(".btn-arrow")) button.insertAdjacentHTML("beforeend", '<span class="btn-arrow">→</span>');
    }
    let streak = 0;
    const cursor = /* @__PURE__ */ new Date();
    while (recordMap.has(dateKey(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    if ($("#daily-streak-count")) $("#daily-streak-count").textContent = streak;
    if ($("#daily-status-title")) $("#daily-status-title").textContent = checkedToday ? "今天已完成打卡" : "今天还没有打卡";
    if ($("#daily-status-copy")) $("#daily-status-copy").textContent = checkedToday ? "很好，保持这个节奏，明天继续遇见新单词。" : "完成一次打卡，记录你的学习节奏。";
    if (week) {
      const labels = ["一", "二", "三", "四", "五", "六", "日"];
      const items = [];
      for (let i = 6; i >= 0; i -= 1) {
        const date = /* @__PURE__ */ new Date();
        date.setDate(date.getDate() - i);
        const key = dateKey(date);
        items.push(`<div class="daily-day ${recordMap.has(key) ? "is-done" : ""} ${key === today ? "is-today" : ""}"><span>周${labels[(date.getDay() + 6) % 7]}</span><strong>${date.getDate()}</strong><small>${recordMap.has(key) ? "已完成" : "—"}</small></div>`);
      }
      week.innerHTML = items.join("");
    }
    const latest = state.dailyRecords.slice().sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))[0];
    if ($("#daily-last-time")) $("#daily-last-time").textContent = latest ? `最近打卡：${dateLabel(latest.date)} · ${formatWordbookTime(latest.checkedAt)}` : "最近打卡：—";
  }
  function checkInToday() {
    const today = dateKey();
    if (state.dailyRecords.some((item) => item.date === today)) {
      toast("今天已经打卡完成");
      return;
    }
    const now = nowIso();
    state.dailyRecords.push({ date: today, checkedAt: now, createdAt: now });
    state.dailyRecords.sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt));
    persist();
    renderDaily();
    toast("今日打卡完成，继续保持");
  }
  function bindDailyEvents() {
    $("#btn-daily-checkin").addEventListener("click", checkInToday);
  }

  // frontend/js/views/profile.js
  function renderProfile() {
    if ($("#profile-signature")) $("#profile-signature").value = state.profile.signature || "";
    if ($("#profile-avatar-button")) $("#profile-avatar-button").innerHTML = avatarMarkup(state.profile.avatar);
    if ($(".sidebar-avatar")) $(".sidebar-avatar").innerHTML = avatarMarkup(state.profile.avatar);
    if ($("#mobile-profile-avatar")) $("#mobile-profile-avatar").innerHTML = avatarMarkup(state.profile.avatar);
    if ($("#profile-account-status")) $("#profile-account-status").textContent = state.auth.user ? `本地账户：${state.auth.user.username} · 数据已加密同步` : "未登录 · 登录后同步加密数据";
    document.querySelectorAll(".avatar-option").forEach((button) => button.classList.toggle("is-selected", button.dataset.avatar === (state.profile.avatar || "学")));
    if ($("#profile-stat-words")) $("#profile-stat-words").textContent = state.wordbook.length;
    if ($("#profile-stat-issues")) $("#profile-stat-issues").textContent = state.articles.length;
    if ($("#profile-stat-completed")) $("#profile-stat-completed").textContent = state.articles.filter((article) => article.completedAt).length;
    if ($("#profile-stat-checkins")) $("#profile-stat-checkins").textContent = state.dailyRecords.length;
    if ($("#btn-logout-profile")) $("#btn-logout-profile").hidden = !state.auth.user;
    if ($("#btn-auth-profile")) $("#btn-auth-profile").hidden = Boolean(state.auth.user);
    if ($("#profile-name")) $("#profile-name").value = state.profile.name || "";
    if ($("#profile-goal")) $("#profile-goal").value = state.profile.goal || "";
    if ($("#sidebar-profile-name")) $("#sidebar-profile-name").textContent = state.profile.name || "刊见学习者";
    if ($("#profile-updated")) $("#profile-updated").textContent = state.profile.updatedAt ? `最近更新：${formatStamp(state.profile.updatedAt) || "时间未知"}` : "信息尚未更新";
  }
  function saveProfile() {
    const now = nowIso();
    state.profile = {
      name: ($("#profile-name")?.value || "").trim() || "刊见学习者",
      goal: ($("#profile-goal")?.value || "").trim() || "每天记住 10 个词",
      signature: ($("#profile-signature")?.value || "").trim(),
      avatar: state.profile.avatar || "学",
      updatedAt: now
    };
    persist();
    renderProfile();
    toast(state.auth.user ? "个人信息已保存并加密同步" : "个人信息已保存（本地）；登录后才会加密备份到账户");
  }
  function bindProfileEvents() {
    $("#btn-save-profile").addEventListener("click", saveProfile);
    document.querySelectorAll(".avatar-option").forEach((button) => button.addEventListener("click", () => {
      state.profile.avatar = button.dataset.avatar || "学";
      renderProfile();
    }));
    if ($("#btn-avatar-upload")) $("#btn-avatar-upload").addEventListener("click", () => $("#avatar-file")?.click());
    if ($("#avatar-file")) $("#avatar-file").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (!file) return;
      if (!/^image\//.test(file.type)) {
        toast("请选择图片文件");
        return;
      }
      if (file.size > 1.5 * 1024 * 1024) {
        toast("图片请小于 1.5MB");
        return;
      }
      try {
        state.profile.avatar = await fileToAvatar(file, 256);
        renderProfile();
        toast("头像已更换，记得保存");
      } catch (err) {
        toast("头像处理失败：" + err.message);
      }
    });
  }

  // frontend/js/views/settings.js
  function syncThemeButtons() {
    document.querySelectorAll(".theme-btn").forEach((b) => b.classList.toggle("active", b.dataset.theme === state.theme));
  }
  function mask(value, head = 4, tail = 4) {
    const text = String(value || "");
    if (!text) return "";
    if (text.length <= head + tail) return "已填写";
    return `${text.slice(0, head)}…${text.slice(-tail)}`;
  }
  function credentialStatus() {
    const cred = state.credentials || {};
    const parts = [];
    parts.push(cred.api_key ? `API Key ${mask(cred.api_key)}` : "未填 API Key");
    parts.push(cred.access_secret ? `知乎 Secret ${mask(cred.access_secret, 4, 4)}` : "未填知乎 Secret");
    if (cred.base_url) parts.push(`Base URL ${cred.base_url}`);
    if (cred.model) parts.push(`模型 ${cred.model}`);
    return parts.join(" · ");
  }
  function renderCredentialForm() {
    const cred = state.credentials || {};
    if ($("#cfg-api-base")) $("#cfg-api-base").value = cred.base_url || "";
    if ($("#cfg-api-key")) $("#cfg-api-key").value = cred.api_key || "";
    if ($("#cfg-api-model")) $("#cfg-api-model").value = cred.model || "";
    if ($("#cfg-zhihu-secret")) $("#cfg-zhihu-secret").value = cred.access_secret || "";
    if ($("#cfg-credential-status")) {
      $("#cfg-credential-status").textContent = cred.api_key || cred.access_secret ? `已保存到本机：${credentialStatus()}` : "尚未配置：填写后点「保存到本机」";
    }
  }
  function readCredentialForm() {
    return {
      base_url: $("#cfg-api-base") ? $("#cfg-api-base").value.trim() : "",
      api_key: $("#cfg-api-key") ? $("#cfg-api-key").value.trim() : "",
      model: $("#cfg-api-model") ? $("#cfg-api-model").value.trim() : "",
      access_secret: $("#cfg-zhihu-secret") ? $("#cfg-zhihu-secret").value.trim() : ""
    };
  }
  function saveCredentialsFromForm() {
    const next = saveCredentials(readCredentialForm());
    renderCredentialForm();
    emit("credentials");
    toast(next.api_key || next.access_secret ? "已保存到本机浏览器" : "已清空本机凭证");
    return next;
  }
  async function testCredentials() {
    const status = $("#cfg-credential-status");
    if (status) status.textContent = "正在测试…";
    try {
      const result = await Api.testAiConfig({});
      if (status) status.textContent = `连接正常：${result.provider_name || result.provider || ""} ${result.model || ""}`.trim();
      toast("模型连接正常");
    } catch (err) {
      if (status) status.textContent = `连接失败：${err.message}`;
      toast("连接失败：" + err.message);
    }
  }
  function applySettings(res) {
    state.settings = res;
    state.theme = res.theme || "paper";
    document.body.dataset.theme = state.theme;
    syncThemeButtons();
  }
  async function saveTheme(theme) {
    state.theme = theme;
    document.body.dataset.theme = theme;
    syncThemeButtons();
    try {
      const res = await Api.saveConfig({ theme });
      applySettings(res);
      persistSettingsStamp();
      if ($("#settings-updated-at")) $("#settings-updated-at").textContent = state.settingsUpdatedAt ? `最近更新：${formatStamp(state.settingsUpdatedAt) || "时间未知"}` : "尚未保存过设置";
      toast("风格已保存");
    } catch (err) {
      toast("风格已本地生效，保存失败：" + err.message);
    }
  }
  function openSettings() {
    if ($("#settings-updated-at")) $("#settings-updated-at").textContent = state.settingsUpdatedAt ? `最近更新：${formatStamp(state.settingsUpdatedAt) || "时间未知"}` : "尚未保存过设置";
    loadCredentials();
    renderCredentialForm();
    syncThemeButtons();
    $("#settings-modal").hidden = false;
  }
  function bindSettingsEvents() {
    $("#btn-settings").addEventListener("click", openSettings);
    $("#sidebar-settings").addEventListener("click", openSettings);
    $("#btn-close-settings").addEventListener("click", () => $("#settings-modal").hidden = true);
    $("#settings-modal").addEventListener("click", (e) => {
      if (e.target.id === "settings-modal") $("#settings-modal").hidden = true;
    });
    document.querySelectorAll(".theme-btn").forEach(
      (b) => b.addEventListener("click", () => {
        if (b.dataset.theme !== state.theme) saveTheme(b.dataset.theme);
      })
    );
    $("#btn-save-credentials")?.addEventListener("click", () => saveCredentialsFromForm());
    $("#btn-test-credentials")?.addEventListener("click", () => {
      saveCredentialsFromForm();
      testCredentials();
    });
    $("#btn-clear-credentials")?.addEventListener("click", () => {
      saveCredentials({ base_url: "", api_key: "", model: "", access_secret: "" });
      renderCredentialForm();
      emit("credentials");
      toast("已清除本机凭证");
    });
    renderCredentialForm();
  }

  // frontend/js/views/diagnose.js
  var PROBE_TIMEOUT_MS = 4e4;
  var DELAYS_MS = [3e3, 6e3, 9e3, 12e3, 18e3];
  function write(text, cls = "") {
    const box = $("#diagnose-output");
    if (!box) return;
    const row = document.createElement("div");
    row.className = `diag-line ${cls}`.trim();
    row.textContent = text;
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }
  function blank() {
    const box = $("#diagnose-output");
    if (box) box.appendChild(document.createElement("div"));
  }
  async function plainProbe(url, opts = {}) {
    const started = performance.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), ...opts });
      const body = await res.text();
      return { status: res.status, ms: Math.round(performance.now() - started), body };
    } catch (err) {
      return { status: 0, ms: Math.round(performance.now() - started), error: err.name === "TimeoutError" ? "客户端等待超时" : err.message };
    }
  }
  async function streamProbe(url) {
    const started = performance.now();
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });
      if (!res.ok || !res.body) {
        return { status: res.status, ms: Math.round(performance.now() - started), chunks: 0, firstMs: null, done: false };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let chunks = 0;
      let firstMs = null;
      let text = "";
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstMs === null) firstMs = Math.round(performance.now() - started);
        chunks += 1;
        text += decoder.decode(value, { stream: true });
      }
      return { status: res.status, ms: Math.round(performance.now() - started), chunks, firstMs, done: text.includes("event: done") };
    } catch (err) {
      return { status: 0, ms: Math.round(performance.now() - started), chunks: 0, firstMs: null, done: false, error: err.name === "TimeoutError" ? "客户端等待超时" : err.message };
    }
  }
  var ok = (r) => r.status === 200;
  var fmtStatus = (r) => r.status ? String(r.status) : r.error || "无响应";
  async function runNetworkDiagnosis() {
    const button = $("#btn-diagnose");
    const box = $("#diagnose-output");
    if (!box) return;
    box.hidden = false;
    box.innerHTML = "";
    if (button) {
      button.disabled = true;
      button.textContent = "诊断中…";
    }
    write("开始诊断（约 1 分钟，请勿关闭页面）");
    try {
      blank();
      write("① 短请求（线上一直是好的）");
      const short = await plainProbe("/api/health");
      write(`   GET /api/health  →  ${fmtStatus(short)}  ${short.ms}ms  ${ok(short) ? "✅" : "❌"}`, ok(short) ? "ok" : "bad");
      blank();
      write("② 模型连通性（一次极短的 LLM 调用）");
      const llm = await plainProbe("/api/health", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      write(`   POST /api/health →  ${fmtStatus(llm)}  ${llm.ms}ms  ${ok(llm) ? "✅ 凭证可用" : "❌"}`, ok(llm) ? "ok" : "bad");
      blank();
      write("③ 请求时长上限（服务端故意等 N 秒再回答）");
      let maxOkMs = 0;
      let firstFailMs = 0;
      for (const delay of DELAYS_MS) {
        const probe = await plainProbe(`/api/health?delay=${delay}`);
        const pass = ok(probe) && probe.ms >= delay - 500;
        if (pass) maxOkMs = delay;
        else if (!firstFailMs) firstFailMs = delay;
        write(`   等待 ${delay / 1e3}s →  ${fmtStatus(probe)}  ${probe.ms}ms  ${pass ? "✅ 通过" : "❌ 被掐断"}`, pass ? "ok" : "bad");
        if (!pass) break;
      }
      blank();
      if (firstFailMs) {
        write(`   ➜ 结论：只要一个请求超过约 ${maxOkMs / 1e3}–${firstFailMs / 1e3} 秒就会被拒绝（HTTP 554）。`, "conclusion");
      } else {
        write(`   ➜ 结论：至少 ${maxOkMs / 1e3} 秒以内的请求都能正常返回。`, "conclusion");
      }
      blank();
      write("④ 流式（SSE）是否被网关透传");
      const streamDelay = firstFailMs ? Math.max(3e3, firstFailMs - 3e3) : DELAYS_MS[DELAYS_MS.length - 1];
      const streamed = await streamProbe(`/api/health?delay=${streamDelay}&stream=1`);
      const streamOk = streamed.status === 200 && streamed.done;
      write(`   等待 ${streamDelay / 1e3}s + 心跳 →  ${fmtStatus(streamed)}  ${streamed.ms}ms  首个数据 ${streamed.firstMs == null ? "无" : streamed.firstMs + "ms"}  分片 ${streamed.chunks} 个  ${streamOk ? "✅ 流式可用" : "❌ 未透传"}`, streamOk ? "ok" : "bad");
      blank();
      write("⑤ 进程内存是否跨请求保留（登录态、自选词、任务状态都靠它）");
      const saved = await plainProbe("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: "ink" }) });
      const readBack = await plainProbe("/api/config");
      let themeAfter = "";
      try {
        themeAfter = JSON.parse(readBack.body).theme || "";
      } catch (err) {
        themeAfter = "";
      }
      const memoryKept = themeAfter === "ink";
      write(`   写入 ink → 再读回：${themeAfter || "读取失败"}  ${memoryKept ? "✅ 保留" : "❌ 丢失"}`, memoryKept ? "ok" : "bad");
      if (!memoryKept) write("   ➜ 说明每个请求都是独立实例，服务端内存不能用来保存任何跨请求状态。", "conclusion");
      await plainProbe("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: "paper" }) });
      void saved;
      blank();
      write("诊断完成。请把以上内容截图发给助手。", "conclusion");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "重新诊断";
      }
    }
  }
  function bindDiagnoseEvents() {
    const button = $("#btn-diagnose");
    if (button) button.addEventListener("click", () => {
      runNetworkDiagnosis();
    });
  }

  // frontend/js/views/workflow.js
  var generationController = null;
  function todayCards() {
    return state.pool.filter((card) => state.targetSelection.has(String(card.word || "").toLowerCase()));
  }
  function routeCards() {
    return state.generationRoute === "zhihu" ? recentMemoryCards(state.coverageDays) : todayCards();
  }
  function cleanCards(cards) {
    return cards.slice(0, 60).map(({ addedAt, savedAt, ...card }) => card);
  }
  function setStage(stage) {
    state.workflowStage = stage;
    renderWorkflow();
  }
  function resetWorkflow() {
    if (state.generating) return;
    state.workflowStage = "words";
    state.coveragePlans = [];
    state.coverageStatus = null;
    state.selectedGroup = null;
    state.sourceSelection = null;
    state.originalTopic = "";
    state.workflowError = null;
    renderWorkflow();
  }
  function stepIndex() {
    return { words: 0, plan: 1, compose: 2, generating: 2, result: 3 }[state.workflowStage] ?? 0;
  }
  function renderSteps() {
    const current = stepIndex();
    document.querySelectorAll("[data-workflow-step]").forEach((step, index) => {
      step.classList.toggle("is-active", index === current);
      step.classList.toggle("is-done", index < current);
    });
  }
  function setRoute(route) {
    state.generationRoute = route === "custom" ? "custom" : "zhihu";
    state.memoryScope = state.generationRoute === "zhihu" ? "recent_3d" : "pool";
    state.coveragePlans = [];
    state.selectedGroup = null;
    state.sourceSelection = null;
    state.workflowStage = "words";
    document.querySelectorAll("[data-generation-route]").forEach((button) => button.classList.toggle("is-active", button.dataset.generationRoute === state.generationRoute));
    const recent = document.querySelector('input[name="memory-scope"][value="recent_3d"]');
    const pool = document.querySelector('input[name="memory-scope"][value="pool"]');
    if (recent) recent.checked = state.generationRoute === "zhihu";
    if (pool) pool.checked = state.generationRoute === "custom";
    renderWorkflow();
  }
  function renderRouteOptions() {
    const zhihu = $("#zhihu-route-options");
    const custom = $("#custom-route-options");
    if (zhihu) zhihu.hidden = state.generationRoute !== "zhihu";
    if (custom) custom.hidden = state.generationRoute !== "custom";
    document.querySelectorAll("[data-coverage-days]").forEach((button) => button.classList.toggle("is-active", Number(button.dataset.coverageDays) === state.coverageDays));
    const cards = routeCards();
    const summary = $("#coverage-word-summary");
    if (summary) summary.innerHTML = state.generationRoute === "zhihu" ? `<strong>近 ${state.coverageDays} 天共 ${cards.length} 个待强化词</strong><span>${esc(cards.slice(0, 16).map((card) => card.word).join(" · "))}${cards.length > 16 ? " …" : ""}</span>` : `<strong>今天已勾选 ${cards.length} 个目标词</strong><span>${esc(cards.map((card) => card.word).join(" · "))}</span>`;
  }
  function renderPlans() {
    const root = $("#coverage-plans");
    if (!root) return;
    if (state.workflowError) {
      root.innerHTML = `<div class="workflow-error"><strong>${esc(state.workflowError.error || "知乎文章匹配失败")}</strong><div><button class="btn-ghost" data-plan-action="back" type="button">返回</button><button class="btn-primary" data-plan-action="retry" type="button">重新匹配</button></div></div>`;
    } else if (!state.coveragePlans.length) {
      root.innerHTML = '<div class="group-loading">正在筛选核心关键词、搜索高收藏知乎文章并进行 AI 审核…</div>';
    } else {
      root.innerHTML = `<div class="coverage-overview"><strong>覆盖 ${state.coverageStatus?.covered_words?.length || 0} / ${state.coverageStatus?.total_words || 0} 个单词</strong><span>${state.coverageStatus?.complete ? "已完整覆盖，可选择任意一篇生成" : "覆盖尚未完成，请重新匹配"}</span></div>${state.coveragePlans.map((plan) => `<article class="coverage-plan-card"><header><span>${esc({ zhihu_search: "知乎文章", hot: "知乎热榜", story: "知乎故事", knowledge: "知乎知识" }[plan.source] || "知乎题材")}${plan.vote_up_count ? ` · ${plan.vote_up_count} 赞` : ""} · 审核 ${plan.review?.score || 0} 分</span><strong>${esc(plan.title || "未命名")}</strong></header><p>${esc(plan.summary || "")}</p>${planWordMarkup(plan)}<small class="coverage-review-note">${esc(plan.review?.reason || plan.reason || "已通过题材审核")}</small><footer><small>${plan.word_count} 个词 · 预计 ${plan.estimated_length} 词${plan.author ? ` · 作者 ${esc(plan.author)}` : ""}</small><div>${plan.url ? `<a class="btn-link" href="${esc(plan.url)}" target="_blank" rel="noreferrer">预览原文</a>` : ""}<button class="btn-primary" type="button" data-use-plan="${esc(plan.id)}">使用这篇生成</button></div></footer></article>`).join("")}`;
    }
    root.querySelector('[data-plan-action="back"]')?.addEventListener("click", () => {
      state.workflowError = null;
      setStage("words");
    });
    root.querySelector('[data-plan-action="retry"]')?.addEventListener("click", matchZhihuCoverage);
    root.querySelectorAll("[data-use-plan]").forEach((button) => button.addEventListener("click", () => useCoveragePlan(button.dataset.usePlan)));
  }
  function planWordMarkup(plan) {
    const core = Array.isArray(plan.core_words) ? plan.core_words : [];
    const coreKeys = new Set(core.map((word) => String(word).toLowerCase()));
    const supporting = Array.isArray(plan.supporting_words) && plan.supporting_words.length ? plan.supporting_words : (plan.words || []).filter((word) => !coreKeys.has(String(word).toLowerCase()));
    return `<div class="coverage-plan-words"><div class="coverage-word-row"><b>搜索关键词</b>${core.map((word) => `<span class="coverage-core-word">${esc(word)}</span>`).join("")}</div><div class="coverage-word-row"><b>文章覆盖词</b>${supporting.map((word) => `<span>${esc(word)}</span>`).join("")}</div></div>`;
  }
  async function matchZhihuCoverage() {
    const cards = cleanCards(recentMemoryCards(state.coverageDays));
    if (cards.length < 3) return toast(`近 ${state.coverageDays} 天至少需要 3 个学习单词`);
    state.workflowStage = "plan";
    state.coveragePlans = [];
    state.workflowError = null;
    renderWorkflow();
    try {
      const result = await Api.zhihuCoverage(cards, state.coverageDays);
      state.coveragePlans = result.plans || [];
      state.coverageStatus = result.coverage || null;
    } catch (error) {
      state.workflowError = error.data || { error: error.message, stage: "topic_planning" };
    }
    renderWorkflow();
  }
  function useCoveragePlan(id) {
    const plan = state.coveragePlans.find((item) => item.id === id);
    if (!plan) return;
    state.source = plan.source || "zhihu_search";
    state.sourceSelection = { content_id: plan.content_id, work_id: plan.work_id, title: plan.title, author: plan.author, summary: plan.summary, description: plan.summary, excerpt: plan.summary, digest: plan.digest || "", labels: plan.labels, url: plan.url, vote_up_count: plan.vote_up_count };
    state.selectedGroup = { id: plan.id, theme: plan.title, reason: plan.reason, coherence: 0.85, words: plan.words, core_words: plan.core_words || [], supporting_words: plan.supporting_words || [], estimated_length: plan.estimated_length, estimated_genre: "daily-science" };
    state.sliders.length = plan.estimated_length || 220;
    state.sliders.genre = "daily-science";
    state.sliders.tone = "clear";
    state.sliders.structure = "scene-explain";
    const length = $("#length-slider");
    if (length) length.value = state.sliders.length;
    const lengthLabel = $("#length-val");
    if (lengthLabel) lengthLabel.textContent = `约 ${state.sliders.length} 词`;
    setStage("compose");
  }
  function prepareCustom() {
    const cards = todayCards();
    if (cards.length < 3) return toast("今日自由创作至少勾选 3 个单词");
    state.source = "original";
    state.sourceSelection = null;
    state.selectedGroup = { id: "custom-today", theme: "用户自定义文章", reason: "使用今天勾选的目标词自由生成", coherence: 1, words: cards.slice(0, 20).map((card) => card.word), estimated_length: state.sliders.length, estimated_genre: state.customStyle.genre };
    state.originalTopic = $("#custom-article-topic")?.value.trim() || state.originalTopic;
    setStage("plan");
  }
  function renderCustomForm() {
    $("#custom-article-topic").value = state.originalTopic;
    $("#custom-article-genre").value = state.customStyle.genre;
    $("#custom-article-tone").value = state.customStyle.tone;
    $("#custom-article-structure").value = state.customStyle.structure;
    renderButton();
  }
  function customReady() {
    return state.originalTopic.trim().length >= 2 && todayCards().length >= 3;
  }
  function saveCustomForm() {
    state.originalTopic = $("#custom-article-topic").value.trim();
    state.customStyle.genre = $("#custom-article-genre").value;
    state.customStyle.tone = $("#custom-article-tone").value;
    state.customStyle.structure = $("#custom-article-structure").value;
    state.sliders.genre = state.customStyle.genre;
    state.sliders.tone = state.customStyle.tone;
    state.sliders.structure = state.customStyle.structure;
    if (state.selectedGroup) state.selectedGroup.estimated_genre = state.customStyle.genre;
  }
  function renderSummary() {
    const root = $("#generation-summary");
    if (!root || state.workflowStage !== "compose" || !state.selectedGroup) return;
    const source = state.generationRoute === "zhihu" ? `知乎文章《${state.sourceSelection?.title || ""}》` : `原创主题：${state.originalTopic || "尚未填写"}`;
    root.innerHTML = `<strong>生成确认</strong><span>${state.selectedGroup.words.length} 个目标词 · 约 ${state.sliders.length} 词 · ${state.customStyle.genre === "daily-curiosity" ? "冷知识" : state.customStyle.genre === "light-entertainment" ? "轻娱乐观察" : "生活科普"}</span><small>${esc(source)}</small>`;
    root.classList.toggle("is-ready", state.generationRoute === "zhihu" || customReady());
  }
  async function generateArticle() {
    saveCustomForm();
    if (state.generationRoute === "custom" && !customReady()) return toast("请先填写文章主题（至少 2 个字符），并勾选 3 个以上单词");
    state.workflowStage = "generating";
    state.workflowError = null;
    generationController?.abort();
    generationController = new AbortController();
    renderWorkflow();
    try {
      await generateConfirmedArticle(generationController.signal);
      state.workflowStage = "result";
      state.resultMode = "reading";
    } catch (error) {
      if (error.name === "AbortError") return;
      state.workflowError = error.data || { error: error.message, stage: "generation", suggestions: [] };
    } finally {
      generationController = null;
    }
    renderWorkflow();
  }
  function backToPlan() {
    generationController?.abort();
    generationController = null;
    state.workflowError = null;
    state.workflowStage = state.generationRoute === "zhihu" ? "plan" : "plan";
    renderWorkflow();
  }
  function renderError() {
    const root = $("#workflow-error");
    if (!root) return;
    root.hidden = !state.workflowError;
    if (!state.workflowError) return;
    root.innerHTML = `<strong>${esc(state.workflowError.error || "文章生成失败")}</strong><div><button class="btn-ghost" type="button" data-generation-error="back">← 返回文章方案</button><button class="btn-primary" type="button" data-generation-error="retry">重试</button></div>`;
    root.querySelector('[data-generation-error="back"]')?.addEventListener("click", backToPlan);
    root.querySelector('[data-generation-error="retry"]')?.addEventListener("click", generateArticle);
  }
  function renderButton() {
    const button = $("#btn-generate");
    if (!button) return;
    const label = button.querySelector("span:first-child");
    let text = state.generationRoute === "zhihu" ? "匹配知乎文章" : "下一步：自定义文章";
    let disabled = false;
    if (state.workflowStage === "plan") {
      if (state.generationRoute === "zhihu") {
        text = "请选择一篇知乎文章";
        disabled = true;
      } else {
        text = "下一步：确认生成设置";
        disabled = !customReady();
      }
    } else if (state.workflowStage === "compose") {
      text = "生成文章";
      disabled = state.generationRoute === "custom" && !customReady();
    } else if (state.workflowStage === "generating") {
      text = "正在生成文章…";
      disabled = true;
    } else if (state.workflowStage === "result") text = "开始练习";
    if (label) label.textContent = text;
    button.disabled = disabled || state.generating;
  }
  function primaryAction() {
    if (state.workflowStage === "words") {
      if (state.generationRoute === "zhihu") matchZhihuCoverage();
      else prepareCustom();
    } else if (state.workflowStage === "plan" && state.generationRoute === "custom") {
      saveCustomForm();
      setStage("compose");
    } else if (state.workflowStage === "compose") generateArticle();
    else if (state.workflowStage === "result") setResultMode("practice");
  }
  function renderWorkflow() {
    renderSteps();
    renderRouteOptions();
    document.querySelectorAll("[data-generation-route]").forEach((button) => button.disabled = state.workflowStage === "generating");
    document.querySelectorAll("[data-workflow-panel]").forEach((panel2) => panel2.hidden = panel2.dataset.workflowPanel !== state.workflowStage);
    $("#coverage-plan-panel").hidden = !(state.workflowStage === "plan" && state.generationRoute === "zhihu");
    $("#custom-plan-panel").hidden = !(state.workflowStage === "plan" && state.generationRoute === "custom");
    if (state.workflowStage === "plan" && state.generationRoute === "zhihu") renderPlans();
    if (state.workflowStage === "plan" && state.generationRoute === "custom") renderCustomForm();
    if (state.workflowStage === "compose") renderSummary();
    if (state.workflowStage === "generating") renderError();
    if (state.workflowStage === "result") setResultMode(state.resultMode);
    renderButton();
  }
  function bindWorkflowEvents() {
    $("#btn-generate")?.addEventListener("click", primaryAction);
    document.querySelectorAll("[data-generation-route]").forEach((button) => button.addEventListener("click", () => setRoute(button.dataset.generationRoute)));
    document.querySelectorAll("[data-coverage-days]").forEach((button) => button.addEventListener("click", () => {
      state.coverageDays = Number(button.dataset.coverageDays) === 7 ? 7 : 3;
      state.memoryScope = "recent_3d";
      renderWorkflow();
    }));
    $("#btn-refresh-coverage")?.addEventListener("click", matchZhihuCoverage);
    $("#btn-back-route")?.addEventListener("click", () => setStage("words"));
    $("#btn-back-custom-route")?.addEventListener("click", () => setStage("words"));
    $("#btn-back-compose")?.addEventListener("click", backToPlan);
    $("#btn-back-generating")?.addEventListener("click", backToPlan);
    ["custom-article-topic", "custom-article-genre", "custom-article-tone", "custom-article-structure"].forEach((id) => $("#" + id)?.addEventListener("input", () => {
      saveCustomForm();
      renderSummary();
      renderButton();
    }));
    document.querySelectorAll("[data-result-action]").forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.resultAction === "back") backToPlan();
      else generateArticle();
    }));
    window.addEventListener("bookwords:pool-change", resetWorkflow);
    renderWorkflow();
  }

  // frontend/js/views/home.js
  var clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  var WEEK_GOALS = { words: 15, articles: 3, checkins: 5 };
  function weekStart() {
    const d = /* @__PURE__ */ new Date();
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function inWeek(iso, from) {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= from;
  }
  function renderHomeProgress() {
    const box = document.querySelector(".highlight-progress");
    if (!box) return;
    const from = weekStart().getTime();
    const words = state.wordbook.filter((w) => inWeek(w.savedAt, from)).length;
    const articles = state.articles.filter((a) => inWeek(a.savedAt || a.createdAt || a.generatedAt, from)).length;
    const checkins = state.dailyRecords.filter((r) => inWeek(r.checkedAt, from)).length;
    const score = 0.5 * Math.min(1, words / WEEK_GOALS.words) + 0.3 * Math.min(1, articles / WEEK_GOALS.articles) + 0.2 * Math.min(1, checkins / WEEK_GOALS.checkins);
    const pct = Math.round(score * 100);
    const num = box.querySelector("strong");
    const bar = box.querySelector("i");
    if (num) num.textContent = pct + "%";
    if (bar) bar.style.width = pct + "%";
  }
  function bindButtonPop() {
    if (document.documentElement.dataset.popBound) return;
    document.documentElement.dataset.popBound = "1";
    document.addEventListener("click", (e) => {
      const btn = e.target.closest?.(".btn-primary, #btn-generate, .btn-ghost");
      if (!btn || btn.disabled) return;
      btn.classList.remove("is-pop");
      void btn.offsetWidth;
      btn.classList.add("is-pop");
      setTimeout(() => btn.classList.remove("is-pop"), 380);
    });
  }
  function bindHomeHero() {
    const hero = document.querySelector(".home-hero-v4");
    if (!hero || hero.dataset.bound) return;
    hero.dataset.bound = "1";
    const book = hero.querySelector("#home-flipbook");
    const frames = book ? [...book.querySelectorAll("img")] : [];
    const hint = hero.querySelector(".home-book-hint");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DRAG_RANGE = 300;
    const FLING_MS = 260;
    const FLING_PX = 48;
    let target = 0, pos = 0, vel = 0;
    let dragging = false, startX = 0, startPos = 0, startAt = 0, moved = false;
    let openTimer = 0;
    const CUE = hero.querySelector(".home-actions");
    function cueOpen(on2) {
      if (CUE) CUE.classList.toggle("is-book-open", on2);
    }
    if (book) {
      book.addEventListener("pointerdown", (e) => {
        clearTimeout(openTimer);
        cueOpen(false);
        dragging = true;
        moved = false;
        startX = e.clientX;
        startPos = target;
        startAt = performance.now();
        try {
          book.setPointerCapture?.(e.pointerId);
        } catch {
        }
      });
      book.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        if (Math.abs(dx) > 4) moved = true;
        target = clamp(startPos - dx / DRAG_RANGE, 0, 1);
      });
      ["pointerup", "pointercancel"].forEach((t) => book.addEventListener(t, (e) => {
        if (!dragging) return;
        dragging = false;
        const dx = e.clientX - startX;
        const quick = performance.now() - startAt < FLING_MS && Math.abs(dx) > FLING_PX;
        target = clamp(Math.round(target + (quick ? -Math.sign(dx) * 0.5 : 0)), 0, 1);
        if (hint && moved) hint.classList.add("is-done");
        clearTimeout(openTimer);
        cueOpen(false);
        if (target === 1) {
          cueOpen(true);
          openTimer = setTimeout(() => {
            cueOpen(false);
            showView("story-pool-view");
          }, 620);
        }
      }));
    }
    const floats = [...hero.querySelectorAll(".home-float")].map((el) => ({
      el,
      gain: parseFloat(el.dataset.gain) || 12,
      mx: 0,
      my: 0,
      tx: 0,
      ty: 0
    }));
    if (floats.length && !reduced) {
      window.addEventListener("pointermove", (e) => {
        const nx = e.clientX / innerWidth * 2 - 1;
        const ny = e.clientY / innerHeight * 2 - 1;
        floats.forEach((f) => {
          f.tx = nx * f.gain;
          f.ty = ny * f.gain * 0.7;
        });
      }, { passive: true });
      document.addEventListener("pointerleave", () => {
        floats.forEach((f) => {
          f.tx = 0;
          f.ty = 0;
        });
      });
    }
    let last = 0, lastIdx = -1, settled = true;
    const homeView = document.getElementById("home-view");
    if (homeView) {
      let wasActive = true;
      new MutationObserver(() => {
        const active = homeView.classList.contains("active");
        if (active && !wasActive) homeView.classList.remove("is-egg");
        wasActive = active;
        if (!active) {
          clearTimeout(openTimer);
          cueOpen(false);
          target = 0;
          pos = 0;
          vel = 0;
          settled = true;
          dragging = false;
          if (lastIdx !== 0) {
            lastIdx = 0;
            frames.forEach((f, i) => f.classList.toggle("is-on", i === 0));
          }
        }
      }).observe(homeView, { attributes: true, attributeFilter: ["class"] });
    }
    function tick(now) {
      if (!last) last = now;
      const dt = Math.min(0.05, (now - last) / 1e3);
      last = now;
      if (hero.offsetParent) {
        for (const f of floats) {
          if (Math.abs(f.tx - f.mx) > 0.05 || Math.abs(f.ty - f.my) > 0.05) {
            f.mx += (f.tx - f.mx) * 0.06;
            f.my += (f.ty - f.my) * 0.06;
            f.el.style.setProperty("--mx", f.mx.toFixed(2) + "px");
            f.el.style.setProperty("--my", f.my.toFixed(2) + "px");
          }
        }
        const needsStep = !settled || dragging || Math.abs(target - pos) > 4e-4 || Math.abs(vel) > 4e-4;
        if (needsStep) {
          const k = 130, c = 13;
          vel += (k * (target - pos) - c * vel) * dt;
          pos += vel * dt;
          if (!dragging && Math.abs(target - pos) < 4e-4 && Math.abs(vel) < 4e-4) {
            pos = target;
            vel = 0;
            settled = true;
          } else {
            settled = false;
          }
          const idx = clamp(Math.round(pos * (frames.length - 1)), 0, frames.length - 1);
          if (idx !== lastIdx) {
            lastIdx = idx;
            frames.forEach((f, i) => f.classList.toggle("is-on", i === idx));
          }
        }
      }
      requestAnimationFrame(tick);
    }
    if (!reduced || frames.length) requestAnimationFrame(tick);
  }
  function bindDeskStack() {
    const stack = document.querySelector(".desk-stack");
    if (!stack || stack.dataset.bound) return;
    stack.dataset.bound = "1";
    let veil = document.querySelector(".stack-veil");
    if (!veil) {
      veil = document.createElement("div");
      veil.className = "stack-veil";
      veil.setAttribute("aria-hidden", "true");
      veil.innerHTML = '<span class="veil-mark">BOOKWORDS</span>';
      document.body.appendChild(veil);
    }
    let sweeping = false;
    const zone = document.querySelector(".home-view");
    zone.addEventListener("click", (e) => {
      const card = e.target.closest(".stack-card, .scatter-tile, .view-link");
      if (!card || sweeping) return;
      if (card.dataset.action === "settings") {
        document.getElementById("btn-settings")?.click();
        return;
      }
      const view = card.dataset.view;
      if (!view) return;
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        showView(view);
        scrollToTop();
        return;
      }
      sweeping = true;
      veil.classList.remove("is-sweeping");
      void veil.offsetWidth;
      veil.classList.add("is-sweeping");
      setTimeout(() => {
        showView(view);
        scrollToTop();
      }, 270);
      setTimeout(() => {
        veil.classList.remove("is-sweeping");
        sweeping = false;
      }, 640);
    });
    function scrollToTop() {
      const shell = document.querySelector(".app-shell");
      if (shell && shell.scrollHeight > shell.clientHeight) shell.scrollTo(0, 0);
      window.scrollTo(0, 0);
    }
    if (matchMedia("(min-width: 981px)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      veil.classList.add("is-boot");
      const open = () => {
        veil.classList.remove("is-boot");
        veil.classList.add("is-booting");
        setTimeout(() => veil.classList.remove("is-booting"), 850);
      };
      if (document.readyState === "complete") setTimeout(open, 400);
      else window.addEventListener("load", () => setTimeout(open, 400), { once: true });
    }
    const secs = [...stack.querySelectorAll(".sec")];
    const mani = document.getElementById("stack-mani");
    if (secs.length && mani) {
      const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const LINES = [["把生词，", "读成"], ["你真正", "关心的事。"]];
      const ITAL = /* @__PURE__ */ new Set(["读成", "关心的事。"]);
      mani.setAttribute("aria-label", LINES.map((l) => l.join("")).join(""));
      const WORDS = [];
      LINES.forEach((line2, li) => {
        line2.forEach((w, wi) => {
          const s = document.createElement("span");
          s.className = "w" + (ITAL.has(w) ? " i" : "");
          s.textContent = w;
          s.setAttribute("aria-hidden", "true");
          mani.appendChild(s);
          WORDS.push({ el: s, key: li / LINES.length + wi / line2.length * 0.17 / LINES.length });
        });
        if (li < LINES.length - 1) mani.appendChild(document.createElement("br"));
      });
      const RISE = secs.map((sec) => [...sec.querySelectorAll(".sec-title, .lab, .foot span, .grid4 .stack-card, .end, .big")].filter((el) => !el.closest(".manifesto")));
      const maniIdx = secs.findIndex((s) => s.querySelector(".manifesto"));
      const progBar = stack.querySelector(".stack-prog");
      const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
      const ease = (q) => q * q * (3 - 2 * q);
      let vh = innerHeight, stickyTop = 68, secMargin = 0;
      const tops = [];
      const docTop = (el) => {
        let t = 0;
        while (el) {
          t += el.offsetTop;
          el = el.offsetParent;
        }
        return t;
      };
      const measure = () => {
        vh = innerHeight;
        const cs = getComputedStyle(secs[0]);
        stickyTop = parseFloat(cs.top) || 0;
        secMargin = parseFloat(cs.marginBottom) || 0;
        const base = docTop(stack);
        let acc = 0;
        tops.length = 0;
        for (const sec of secs) {
          tops.push(base + acc);
          acc += sec.offsetHeight + secMargin;
        }
      };
      const progress = new Array(secs.length).fill(0);
      const paint = () => {
        if (!stack.offsetParent) return;
        const y = window.scrollY || document.documentElement.scrollTop;
        for (let i = 0; i < secs.length; i++) progress[i] = clamp01((y - (tops[i] - stickyTop)) / vh);
        if (progBar) progBar.style.width = clamp01(y / Math.max(1, document.documentElement.scrollHeight - vh)) * 100 + "%";
        for (let i = 1; i < RISE.length; i++) {
          const list = RISE[i], n = list.length, d = 0.42 / Math.max(1, n);
          for (let k = 0; k < n; k++) {
            const q = ease(clamp01((progress[i] * 1.5 - k * d) / 0.34));
            const el = list[k];
            el.style.opacity = (0.06 + 0.94 * q).toFixed(3);
            el.style.transform = `translate3d(0,${((1 - q) * 22).toFixed(1)}px,0)`;
          }
        }
        const sw = progress[maniIdx] * 1.24;
        for (const w of WORDS) w.el.style.opacity = (0.22 + 0.78 * ease(clamp01((sw - w.key) / 0.2))).toFixed(3);
      };
      if (RM) {
        WORDS.forEach((w) => {
          w.el.style.opacity = "1";
        });
      } else {
        measure();
        paint();
        window.addEventListener("scroll", paint, { passive: true });
        window.addEventListener("resize", () => {
          measure();
          paint();
        });
        window.addEventListener("load", () => {
          measure();
          paint();
        }, { once: true });
      }
    }
    const scatter = document.querySelector(".desk-scatter");
    const tiles = [...document.querySelectorAll(".scatter-tile")].map((el) => ({
      el,
      gain: parseFloat(el.style.getPropertyValue("--g")) || 12,
      mx: 0,
      my: 0,
      tx: 0,
      ty: 0,
      /* 指针视差 */
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      /* 撞飞位移与速度 */
      rot: 0,
      /* 撞击旋转扰动 */
      sc: 1,
      scT: 1,
      /* proximity scale */
      state: "home"
      /* home | fly | return */
    }));
    if (tiles.length && scatter && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      let lastPt = null, ptVX = 0, ptVY = 0;
      window.addEventListener("pointermove", (e) => {
        if (lastPt) {
          ptVX = e.clientX - lastPt.x;
          ptVY = e.clientY - lastPt.y;
        }
        lastPt = { x: e.clientX, y: e.clientY };
        const nx = e.clientX / innerWidth * 2 - 1;
        const ny = e.clientY / innerHeight * 2 - 1;
        tiles.forEach((f) => {
          f.tx = nx * f.gain;
          f.ty = ny * f.gain * 0.7;
        });
      }, { passive: true });
      document.addEventListener("pointerleave", () => {
        lastPt = null;
        tiles.forEach((f) => {
          f.tx = 0;
          f.ty = 0;
        });
      });
      let ptLast = 0;
      requestAnimationFrame(function ptTick(now) {
        if (!ptLast) ptLast = now;
        if (now - ptLast >= 1e3 / 60) {
          ptLast = now;
          if (scatter.offsetParent) {
            const boxRect = scatter.getBoundingClientRect();
            const rects = tiles.map((f) => f.el.getBoundingClientRect());
            const pSpd = Math.hypot(ptVX, ptVY);
            for (let i = 0; i < tiles.length; i++) {
              const f = tiles[i], r = rects[i];
              const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
              if (lastPt) {
                const dx = lastPt.x - cx, dy = lastPt.y - cy;
                const d = Math.hypot(dx, dy);
                const hitR = Math.max(r.width, r.height) * 0.55;
                if (f.state === "home" && d < hitR && pSpd > 9) {
                  const power = Math.min(46, pSpd * 0.9);
                  const ux = d > 0 ? -dx / d : 0, uy = d > 0 ? -dy / d : 1;
                  f.vx = ptVX * 0.75 + ux * power * 0.6;
                  f.vy = ptVY * 0.75 + uy * power * 0.6;
                  f.rot = (Math.random() - 0.5) * 14;
                  f.state = "fly";
                  f.scT = 1;
                } else if (d < 150) {
                  const k = 1 - d / 150;
                  f.scT = 1 + 0.14 * k * k;
                } else f.scT = 1;
              } else f.scT = 1;
            }
            for (let i = 0; i < tiles.length; i++) {
              const a = tiles[i];
              if (a.state !== "fly") continue;
              for (let j = 0; j < tiles.length; j++) {
                if (i === j) continue;
                const b = tiles[j], rb = rects[j];
                const acx = rects[i].left + rects[i].width / 2, acy = rects[i].top + rects[i].height / 2;
                const bcx = rb.left + rb.width / 2, bcy = rb.top + rb.height / 2;
                const minD = (rects[i].width + rb.width) * 0.54;
                const dx = acx - bcx, dy = acy - bcy;
                const d = Math.hypot(dx, dy);
                if (d > 0 && d < minD) {
                  const ux = dx / d, uy = dy / d, push = (minD - d) * 0.5;
                  a.x += ux * push;
                  a.y += uy * push;
                  if (b.state === "home") {
                    b.state = "fly";
                    b.vx = a.vx * 0.6 + ux * 2.2;
                    b.vy = a.vy * 0.6 + uy * 2.2;
                    b.rot = (Math.random() - 0.5) * 10;
                  }
                  a.vx *= 0.55;
                  a.vy *= 0.55;
                }
              }
            }
            for (const f of tiles) {
              if (f.state === "fly") {
                f.x += f.vx;
                f.y += f.vy;
                f.vx *= 0.93;
                f.vy *= 0.93;
                f.rot *= 0.94;
                const w = f.el.offsetWidth, h = f.el.offsetHeight;
                const basePx = (parseFloat(f.el.style.getPropertyValue("--x")) || 0) / 100 * boxRect.width;
                const basePy = (parseFloat(f.el.style.getPropertyValue("--y")) || 0) / 100 * boxRect.height;
                const minX = 10 + w / 2 - basePx, maxX = boxRect.width - 10 - w / 2 - basePx;
                const minY = 10 + h / 2 - basePy, maxY = boxRect.height - 10 - h / 2 - basePy;
                if (f.x < minX) {
                  f.x = minX;
                  f.vx = Math.abs(f.vx) * 0.75;
                  f.rot = -f.rot * 0.6;
                }
                if (f.x > maxX) {
                  f.x = maxX;
                  f.vx = -Math.abs(f.vx) * 0.75;
                  f.rot = -f.rot * 0.6;
                }
                if (f.y < minY) {
                  f.y = minY;
                  f.vy = Math.abs(f.vy) * 0.75;
                  f.rot = -f.rot * 0.6;
                }
                if (f.y > maxY) {
                  f.y = maxY;
                  f.vy = -Math.abs(f.vy) * 0.75;
                  f.rot = -f.rot * 0.6;
                }
                if (Math.hypot(f.vx, f.vy) < 0.45) f.state = "return";
              } else if (f.state === "return") {
                f.x *= 0.86;
                f.y *= 0.86;
                f.rot *= 0.86;
                if (Math.hypot(f.x, f.y) < 0.5) {
                  f.x = 0;
                  f.y = 0;
                  f.rot = 0;
                  f.state = "home";
                }
              }
              f.sc += (f.scT - f.sc) * 0.13;
              f.mx += (f.tx - f.mx) * 0.06;
              f.my += (f.ty - f.my) * 0.06;
              const px = f.x + f.mx, py = f.y + f.my;
              if (f.state !== "home" || Math.abs(px) > 0.05 || Math.abs(py) > 0.05 || Math.abs(f.sc - 1) > 1e-3) {
                const rotCss = f.rot ? ` + ${f.rot.toFixed(2)}deg` : "";
                f.el.style.transform = `translate3d(${px.toFixed(2)}px, ${py.toFixed(2)}px, 0) rotate(calc(var(--r)${rotCss})) scale(${f.sc.toFixed(3)})`;
              } else if (f.el.style.transform) {
                f.el.style.transform = "";
              }
            }
            ptVX *= 0.8;
            ptVY *= 0.8;
          } else {
            for (const f of tiles) {
              f.x = 0;
              f.y = 0;
              f.vx = 0;
              f.vy = 0;
              f.rot = 0;
              f.state = "home";
              if (f.el.style.transform) f.el.style.transform = "";
            }
          }
        }
        requestAnimationFrame(ptTick);
      });
    }
    const homeView = document.querySelector(".home-view");
    const isDesktop = () => matchMedia("(min-width: 981px)").matches;
    let eggVeiling = false;
    const toggleEgg = () => {
      if (!isDesktop() || eggVeiling) return;
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
        homeView.classList.toggle("is-egg");
        return;
      }
      eggVeiling = true;
      veil.classList.remove("is-sweeping");
      void veil.offsetWidth;
      veil.classList.add("is-sweeping");
      setTimeout(() => {
        if (!homeView.classList.contains("active")) showView("home-view");
        homeView.classList.toggle("is-egg");
      }, 270);
      setTimeout(() => {
        veil.classList.remove("is-sweeping");
        eggVeiling = false;
      }, 640);
    };
    let lastBrandClick = 0;
    const brandEggClick = () => {
      const now = performance.now();
      if (now - lastBrandClick < 400) {
        lastBrandClick = 0;
        toggleEgg();
      } else lastBrandClick = now;
    };
    document.querySelector(".topbar .brand-home")?.addEventListener("click", brandEggClick);
    document.querySelector(".sidebar-brand.brand-home")?.addEventListener("click", brandEggClick);
    document.querySelector(".scatter-brand")?.addEventListener("click", brandEggClick);
    const story = document.querySelector(".home-story");
    if (story && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const io = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            en.target.classList.add("is-in");
            io.unobserve(en.target);
          }
        }
      }, { root: document.querySelector(".app-shell") || null, threshold: 0.22 });
      story.querySelectorAll(".story-sec").forEach((sec) => io.observe(sec));
    }
  }

  // frontend/js/main.js
  window.__BOOKWORDS_BOOTED__ = true;
  async function init() {
    registerArticleMigrator(migrateArticles);
    migrateLegacyStorage();
    loadLocal();
    loadSettingsStamp();
    bindNavigation();
    bindLibraryEvents();
    bindWordbookEvents();
    bindWordbookMobileSearch();
    bindPoolEvents();
    bindGenerateEvents();
    bindReadingWordEvents();
    bindPracticeEvents();
    bindStorybookEvents();
    bindDailyEvents();
    bindProfileEvents();
    bindSettingsEvents();
    bindAuthEvents();
    bindSourceEvents();
    bindDiagnoseEvents();
    bindWorkflowEvents();
    bindHomeHero();
    bindDeskStack();
    renderHomeProgress();
    bindButtonPop();
    bindReaderEvents();
    document.querySelector("#btn-newspaper-pdf")?.addEventListener("click", () => printNewspaper(currentOpenArticles()));
    document.querySelector("#btn-newspaper-word")?.addEventListener("click", () => downloadWordArticle(currentOpenArticles()));
    on("wordbook", () => {
      renderWordbook();
      renderLibrary();
      renderHomeProgress();
    });
    on("pool", () => {
      renderStoryPoolView();
      resetWorkflow();
    });
    on("articles", () => {
      renderArticleBook();
      renderHomeProgress();
    });
    on("daily", () => {
      renderDaily();
      renderHomeProgress();
    });
    on("profile", () => renderProfile());
    on("auth", () => renderProfile());
    await restoreAuth();
    async function loadBootstrap() {
      const levelsRes = await Api.levels();
      const cfg = await Api.getConfig();
      const meta = await Api.meta();
      state.levels = (levelsRes.levels || []).map((l) => ({ id: l.id, label: l.label || l.id }));
      state.minCards = meta?.min_cards?.story || 3;
      if (!state.level && state.levels.length) state.level = "all";
      const sel = document.querySelector("#word-level");
      if (sel) {
        sel.innerHTML = '<option value="all">全部词库</option>' + state.levels.map((l) => `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join("") + '<option value="custom">自设单词</option>';
        sel.value = state.level;
      }
      applySettings(cfg);
    }
    try {
      await loadBootstrap();
    } catch (err) {
      console.warn("bootstrap deferred:", err.message);
      toast("网络限流中，词库稍后自动加载…");
      let tries = 0;
      const heal = setInterval(async () => {
        tries++;
        try {
          await loadBootstrap();
          clearInterval(heal);
          refreshLibrary("browse");
          renderWordbook();
          toast("词库已加载");
        } catch (e) {
          console.warn(`bootstrap retry #${tries}:`, e.message);
        }
      }, 8e3);
    }
    registerView("wordbook-view", renderWordbook);
    registerView("story-pool-view", renderStoryPoolView);
    registerView("story-book-view", renderArticleBook);
    registerView("daily-view", renderDaily);
    registerView("profile-view", renderProfile);
    renderStoryPoolView();
    renderWordbook();
    renderDaily();
    renderProfile();
    renderPractice();
    renderWorkflow();
    refreshLibrary("browse");
    showView("home-view");
  }
  init().catch((err) => {
    console.error("init failed:", err);
    toast("应用初始化失败：" + (err?.message || err));
  });
})();
