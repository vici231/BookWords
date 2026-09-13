/* store.js — 持久化层：localStorage 为主，登录后防抖同步服务端（AES-GCM 加密）。

修复旧版「未登录零持久化」缺陷：本地 wj-* 键永远实时写入，刷新不丢数据；
登录时服务端快照覆盖本地（账户为准），之后所有变更防抖 800ms 增量排队同步。
首次启动会把旧版 ciyu-* 数据只读迁移过来（不删旧键，旧应用不受影响）。
*/

import { Api } from "./api.js";
import { emit, state, MAX_STORY_CARDS } from "./state.js";
import { nowIso, toast } from "./utils.js";

const KEYS = {
  wordbook: "wj-wordbook",
  pool: "wj-pool",
  articles: "wj-articles",
  daily: "wj-daily-checkins",
  profile: "wj-profile",
  token: "wj-auth-token",
  settingsAt: "wj-settings-updated-at",
  learning: "wj-learning-state",
  credentials: "wj-credentials",
};

/* 旧版（vocab-memory-poker）的 localStorage 键；只读迁移，不删除 */
const LEGACY = {
  [KEYS.wordbook]: "ciyu-wordbook",
  [KEYS.pool]: "ciyu-story-pool",
  [KEYS.articles]: "ciyu-articles",
  [KEYS.daily]: "ciyu-daily-checkins",
  [KEYS.profile]: "ciyu-profile",
  [KEYS.settingsAt]: "ciyu-settings-updated-at",
};

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 存储满等本地异常忽略 */ }
}

/* 首次启动：wj-* 缺失而旧版 ciyu-* 存在时，把旧数据复制过来。
   AI Works 预览等 sandbox iframe（opaque origin）中 localStorage 直接抛
   SecurityError——这里整体保护，绝不让迁移中断应用初始化。 */
export function migrateLegacyStorage() {
  try {
    if (localStorage.getItem(KEYS.wordbook) !== null) return;
    for (const [key, legacy] of Object.entries(LEGACY)) {
      if (localStorage.getItem(key) === null) {
        const raw = localStorage.getItem(legacy);
        if (raw !== null) {
          try { localStorage.setItem(key, JSON.parse(raw) ?? null); } catch (e) { /* 忽略损坏数据 */ }
        }
      }
    }
  } catch (e) { /* 存储不可用：内存态运行，刷新后数据不保留 */ }
}

/* ---------------- 快照（与服务端 users.json 加密格式兼容） ---------------- */

export function userDataSnapshot() {
  return {
    profile: state.profile,
    wordbook: state.wordbook,
    pool: state.pool,
    articles: state.articles,
    dailyRecords: state.dailyRecords,
    masteredWords: state.masteredWords,
    recentMistakes: state.recentMistakes,
    practiceResults: state.practiceResults,
    periodicalSelections: state.periodicalSelections,
  };
}

/* ---------------- 服务端同步（登录后） ---------------- */

let syncTimer = null;
let syncChain = Promise.resolve();

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 800);
}

function runSync() {
  const token = state.auth.token;
  if (!token) return;
  const snapshot = JSON.parse(JSON.stringify(userDataSnapshot()));
  syncChain = syncChain
    .catch(() => undefined)
    .then(() => Api.authSaveData(token, snapshot))
    .catch((err) => {
      if (state.auth.token === token) toast("加密数据同步失败：" + err.message);
    });
}

/* ---------------- 写入入口 ---------------- */

/* 域数据变化后调用：本地立即可见，服务端（若登录）防抖合并同步 */
export function persist() {
  writeJson(KEYS.wordbook, state.wordbook);
  writeJson(KEYS.pool, state.pool);
  writeJson(KEYS.articles, state.articles);
  writeJson("wj-periodical-selections", state.periodicalSelections);
  writeJson(KEYS.daily, state.dailyRecords);
  writeJson(KEYS.profile, state.profile);
  writeJson(KEYS.learning, { masteredWords: state.masteredWords, recentMistakes: state.recentMistakes, practiceResults: state.practiceResults });
  if (state.auth.token) scheduleSync();
}

/* 只写本地、不同步（用于服务端数据刚覆盖本地的场景，避免无谓回传） */
function writeLocalOnly() {
  writeJson(KEYS.wordbook, state.wordbook);
  writeJson(KEYS.pool, state.pool);
  writeJson(KEYS.articles, state.articles);
  writeJson("wj-periodical-selections", state.periodicalSelections);
  writeJson(KEYS.daily, state.dailyRecords);
  writeJson(KEYS.profile, state.profile);
  writeJson(KEYS.learning, { masteredWords: state.masteredWords, recentMistakes: state.recentMistakes, practiceResults: state.practiceResults });
}

export function persistSettingsStamp() {
  state.settingsUpdatedAt = nowIso();
  try { localStorage.setItem(KEYS.settingsAt, state.settingsUpdatedAt); } catch (e) { /* 忽略 */ }
}

export function loadSettingsStamp() {
  try { state.settingsUpdatedAt = localStorage.getItem(KEYS.settingsAt) || ""; } catch (e) { state.settingsUpdatedAt = ""; }
}

/* ---------------- 启动加载 ---------------- */

/* 单词本条目规范化：清理已废弃的艾宾浩斯复习残留字段 */
function normalizeWordEntry(entry) {
  if (entry && entry.review) { try { delete entry.review; } catch (e) { entry.review = undefined; } }
  return entry;
}

/* 文章数组规范化（在 articles.js 中迁移补齐字段） */
let migrateArticlesFn = null;
export function registerArticleMigrator(fn) {
  migrateArticlesFn = fn;
}

export function loadLocal() {
  state.wordbook = readJson(KEYS.wordbook, []).filter((w) => w && w.word).map((w) => normalizeWordEntry({ ...w, savedAt: w.savedAt || nowIso() }));
  state.pool = readJson(KEYS.pool, []).filter((w) => w && w.word).slice(0, MAX_STORY_CARDS).map((w) => ({ ...w, addedAt: w.addedAt || nowIso() }));
  state.targetSelection = new Set(state.pool.map((word) => String(word.word || "").toLowerCase()));
  state.poolUpdatedAt = state.pool.reduce((latest, word) => (word.addedAt > latest ? word.addedAt : latest), "");
  state.articles = readJson(KEYS.articles, []).filter((article) => article && article.story && article.story.en);
  const periodicalSelections = readJson("wj-periodical-selections", { week: {}, month: {} });
  state.periodicalSelections = periodicalSelections && typeof periodicalSelections === "object"
    ? { week: periodicalSelections.week || {}, month: periodicalSelections.month || {} }
    : { week: {}, month: {} };
  state.dailyRecords = readJson(KEYS.daily, []).filter((item) => item && item.date && item.checkedAt);
  state.profile = { ...state.profile, ...readJson(KEYS.profile, {}) };
  const learning = readJson(KEYS.learning, {});
  state.masteredWords = learning.masteredWords && typeof learning.masteredWords === "object" ? learning.masteredWords : {};
  state.recentMistakes = Array.isArray(learning.recentMistakes) ? learning.recentMistakes : [];
  state.practiceResults = learning.practiceResults && typeof learning.practiceResults === "object" ? learning.practiceResults : {};
  loadCredentials();
  migrateArticlesFn?.();
}

/* ---------------- 本机凭证（只存本地，绝不进仓库/部署包） ---------------- */

export function loadCredentials() {
  const saved = readJson(KEYS.credentials, null);
  if (!saved || typeof saved !== "object") return state.credentials;
  state.credentials = {
    base_url: String(saved.base_url || ""),
    api_key: String(saved.api_key || ""),
    model: String(saved.model || ""),
    access_secret: String(saved.access_secret || ""),
  };
  return state.credentials;
}

export function saveCredentials(next) {
  const current = state.credentials || {};
  const merged = {
    base_url: String(next && next.base_url !== undefined ? next.base_url : current.base_url || "").trim(),
    api_key: String(next && next.api_key !== undefined ? next.api_key : current.api_key || "").trim(),
    model: String(next && next.model !== undefined ? next.model : current.model || "").trim(),
    access_secret: String(next && next.access_secret !== undefined ? next.access_secret : current.access_secret || "").trim(),
  };
  state.credentials = merged;
  writeJson(KEYS.credentials, merged);
  return merged;
}

export function hasCredentials() {
  const cred = state.credentials || {};
  return Boolean(cred.api_key || cred.access_secret);
}

/* ---------------- 会话数据 ---------------- */

export function setToken(token) {
  try { localStorage.setItem(KEYS.token, token); } catch (e) { /* 忽略 */ }
}

export function getToken() {
  try { return localStorage.getItem(KEYS.token) || ""; } catch (e) { return ""; }
}

export function clearToken() {
  try { localStorage.removeItem(KEYS.token); } catch (e) { /* 忽略 */ }
}

/* 登录 / 恢复会话：服务端数据覆盖本地，并回写本地键 */
export function applyUserData(data) {
  const source = data && typeof data === "object" ? data : {};
  state.wordbook = Array.isArray(source.wordbook) ? source.wordbook.filter((w) => w && w.word).map((w) => normalizeWordEntry({ ...w, savedAt: w.savedAt || nowIso() })) : [];
  state.pool = Array.isArray(source.pool) ? source.pool.filter((w) => w && w.word).slice(0, MAX_STORY_CARDS).map((w) => ({ ...w, addedAt: w.addedAt || nowIso() })) : [];
  state.targetSelection = new Set(state.pool.map((word) => String(word.word || "").toLowerCase()));
  state.poolUpdatedAt = state.pool.reduce((latest, word) => (word.addedAt > latest ? word.addedAt : latest), "");
  state.articles = Array.isArray(source.articles) ? source.articles.filter((article) => article && article.story && article.story.en) : [];
  state.periodicalSelections = source.periodicalSelections && typeof source.periodicalSelections === "object"
    ? { week: source.periodicalSelections.week || {}, month: source.periodicalSelections.month || {} }
    : { week: {}, month: {} };
  state.dailyRecords = Array.isArray(source.dailyRecords) ? source.dailyRecords.filter((item) => item && item.date && item.checkedAt) : [];
  state.profile = { ...state.profile, ...(source.profile && typeof source.profile === "object" ? source.profile : {}) };
  state.masteredWords = source.masteredWords && typeof source.masteredWords === "object" ? source.masteredWords : {};
  state.recentMistakes = Array.isArray(source.recentMistakes) ? source.recentMistakes : [];
  state.practiceResults = source.practiceResults && typeof source.practiceResults === "object" ? source.practiceResults : {};
  migrateArticlesFn?.();
  writeLocalOnly();
}

/* 全量重渲染事件（登录/登出/恢复会话后由 auth 模块触发） */
export function emitDataChanged() {
  emit("pool");
  emit("wordbook");
  emit("articles");
  emit("daily");
  emit("profile");
  emit("auth");
}
