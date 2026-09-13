/* articles.js — 刊物数据域：周信息 / 保存 / 完成标记 / 活跃期查询 */

import { state, emit } from "./state.js";
import { persist } from "./store.js";
import { nowIso, pad2, parseStamp } from "./utils.js";
import { MAX_STORY_CARDS } from "./state.js";

/* 知乎英语日报的「自然周」：周一为一周之始 */
export function dailyWeekInfo(value = nowIso()) {
  const date = parseStamp(value) || new Date();
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const day = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - day);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (d) => `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
  return { key: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`, label: `${fmt(start)}–${fmt(end)}` };
}

/* 旧数据迁移：补齐生成时间与目标单词字段 */
export function migrateArticles() {
  state.articles.forEach((article) => {
    if (!article.generatedAt) article.generatedAt = article.savedAt || article.createdAt || "";
    const week = dailyWeekInfo(article.generatedAt);
    if (!article.weekKey) article.weekKey = week.key;
    if (!article.weekLabel) article.weekLabel = week.label;
    if (!article.publication) article.publication = "Zhihu English Daily";
    if (!article.genre) article.genre = "gossip";
    if (!Array.isArray(article.targetWords)) {
      article.targetWords = Array.isArray(article.story?.hooks) && article.story.hooks.length
        ? article.story.hooks.map((hook) => String(hook).trim()).filter(Boolean)
        : [];
    }
    if (article.story && !article.story.zh && article.story.cn) article.story.zh = article.story.cn;
    if (!article.language) article.language = article.story?.language === "zh" ? "zh" : "en";
    if (!article.memoryScope) article.memoryScope = article.story?.memory_scope === "recent_3d" ? "recent_3d" : "pool";
    if (!article.sorting || typeof article.sorting !== "object") article.sorting = {};
  });
}

/* 保存一期刊物。除原有字段外，同时快照 targetCards（词 + 释义），
   供往期练习时生成与当期一致的中文注释（修复旧版用「当前池子」导致注释错位）。 */
export function saveArticle(story, options = {}) {
  const now = nowIso();
  const week = dailyWeekInfo(now);
  const sourceCards = Array.isArray(options.cards) && options.cards.length ? options.cards : state.pool.slice(0, MAX_STORY_CARDS);
  const targetWords = sourceCards.slice(0, MAX_STORY_CARDS).map((word) => word.word).filter(Boolean);
  const targetCards = sourceCards.slice(0, MAX_STORY_CARDS).map((word) => ({
    word: word.word,
    pos: word.pos || "",
    meaning_cn: word.meaning_cn || word.meaning || "",
    meaning_en: word.meaning_en || "",
    phonetic: word.phonetic || "",
  }));
  const article = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: story.title || "知乎英语日报",
    publication: story.publication || "Zhihu English Daily",
    genre: story.genre || "gossip",
    dateline: story.dateline || "Zhihu Daily",
    weekKey: week.key,
    weekLabel: week.label,
    memoryReserve: targetWords.length,
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
      disclaimer: story.disclaimer || "",
    },
    targetWords,
    targetCards,
    createdAt: now,
    generatedAt: now,
    updatedAt: now,
    savedAt: now,
    completedAt: "",
  };
  /* 每次生成都是独立的一期：全部保留在存档里，不替换、不设上限，可随时单独练习。 */
  state.articles.unshift(article);
  state.lastArticleId = article.id;
  persist();
  emit("articles");
  return article;
}

export function markArticleCompleted() {
  const article = state.articles.find((item) => item.id === state.lastArticleId);
  if (!article) return;
  const now = nowIso();
  if (!article.completedAt) article.completedAt = now;
  article.lastPracticedAt = now;
  article.updatedAt = now;
  persist();
  emit("articles");
}

export function deleteArticle(articleId) {
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

/* 当前练习/阅读指向的刊物：优先 lastArticleId，其次本周，最后最新一期 */
export function activeArticle() {
  return state.articles.find((item) => item.id === state.lastArticleId)
    || state.articles.find((item) => (item.weekKey || dailyWeekInfo(item.generatedAt).key) === dailyWeekInfo().key)
    || state.articles[0]
    || null;
}

/* 某一周的所有文章（生成时间正序 = 阅读顺序）。日报 = 一周文章的整合。 */
export function articlesOfWeek(weekKey) {
  return state.articles
    .filter((item) => (item.weekKey || dailyWeekInfo(item.generatedAt).key) === weekKey)
    .sort((a, b) => String(a.generatedAt || "").localeCompare(String(b.generatedAt || "")));
}

/* 本周文章合集 */
export function currentWeekArticles() {
  return articlesOfWeek(dailyWeekInfo().key);
}

/* 存档按周分组（新周在前），每周 = 一期刊物 */
export function weekGroups() {
  const groups = new Map();
  state.articles.forEach((item) => {
    const key = item.weekKey || dailyWeekInfo(item.generatedAt).key;
    if (!groups.has(key)) groups.set(key, { weekKey: key, weekLabel: item.weekLabel || dailyWeekInfo(item.generatedAt).label, articles: [] });
    groups.get(key).articles.push(item);
  });
  return Array.from(groups.values())
    .map((g) => ({ ...g, articles: g.articles.sort((a, b) => String(a.generatedAt || "").localeCompare(String(b.generatedAt || ""))) }))
    .sort((a, b) => b.weekKey.localeCompare(a.weekKey));
}

/* 一日报物内的目标词总数（去重，用于本周统计） */
export function weekWordCount(weekKey) {
  const set = new Set();
  articlesOfWeek(weekKey).forEach((a) => (a.targetWords || []).forEach((w) => w && set.add(String(w).toLowerCase())));
  return set.size;
}

export function monthGroups() {
  const groups = new Map();
  state.articles.forEach((article) => {
    const date = parseStamp(article.generatedAt || article.savedAt);
    if (!date) return;
    const key = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
    if (!groups.has(key)) groups.set(key, { key, label: `${date.getFullYear()}年${date.getMonth() + 1}月`, articles: [] });
    groups.get(key).articles.push(article);
  });
  return Array.from(groups.values()).sort((a, b) => b.key.localeCompare(a.key));
}

export function localPeriodicalGroups(period) {
  const raw = period === "month"
    ? monthGroups()
    : weekGroups().map((group) => ({ key: group.weekKey, label: group.weekLabel, articles: group.articles }));
  return raw.map((group) => {
    const words = new Set();
    const themes = new Map();
    const sources = new Map();
    group.articles.forEach((article) => {
      (article.targetWords || []).forEach((word) => word && words.add(String(word).toLowerCase()));
      const selected = article.sorting?.selected_group || {};
      const theme = selected.theme || genreLabel(article.genre);
      if (!themes.has(theme)) themes.set(theme, new Set());
      (selected.words || article.targetWords || []).forEach((word) => word && themes.get(theme).add(word));
      const source = article.story?.source_type || "original";
      sources.set(source, (sources.get(source) || 0) + 1);
    });
    return {
      ...group,
      articleCount: group.articles.length,
      wordCount: words.size,
      themes: Array.from(themes, ([name, values]) => ({ name, words: Array.from(values) })),
      sources: Object.fromEntries(sources),
    };
  });
}

export function genreLabel(genre) {
  return { "daily-science": "知乎日常科普", "daily-curiosity": "知乎冷知识", "light-entertainment": "轻娱乐观察", gossip: "知乎日常科普", "odd-fact": "知乎冷知识", "fictional-breaking": "轻娱乐观察" }[genre] || "本期选题";
}

/* 刊物（全英文）使用的栏目名。 */
export function genreLabelEn(genre) {
  return { "daily-science": "DAILY SCIENCE", "daily-curiosity": "DAILY CURIOSITY", "light-entertainment": "LIGHT ENTERTAINMENT", gossip: "DAILY SCIENCE", "odd-fact": "DAILY CURIOSITY", "fictional-breaking": "LIGHT ENTERTAINMENT" }[genre] || "TODAY'S TOPIC";
}

