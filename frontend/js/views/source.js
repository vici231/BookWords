/* Zhihu source picker: related answers/articles plus hot/story/knowledge feeds. */

import { Api } from "../api.js";
import { state } from "../state.js";
import { $, esc } from "../utils.js";

let pendingKey = "";
let pendingSearch = null;

function activeSourceCards() {
  if (state.memoryScope !== "recent_3d") return state.pool;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 2);
  const candidates = state.wordbook.map((card) => ({ card, stamp: new Date(card.savedAt || card.addedAt || "").getTime() }));
  state.articles.forEach((article) => {
    const stamp = new Date(article.lastPracticedAt || article.generatedAt || article.savedAt || "").getTime();
    (article.targetCards || []).forEach((card) => candidates.push({ card, stamp }));
  });
  state.recentMistakes.forEach((item) => candidates.push({ card: item.card || { word: item.word }, stamp: new Date(item.wrongAt || "").getTime() }));
  const seen = new Set();
  return candidates.filter((item) => Number.isFinite(item.stamp) && item.stamp >= start.getTime())
    .sort((a, b) => b.stamp - a.stamp).map((item) => item.card).filter((card) => {
      const key = String(card.word || "").toLowerCase();
      if (!key || seen.has(key) || state.masteredWords[key]) return false;
      seen.add(key);
      return true;
    });
}

export function setSource(source) {
  state.source = source;
  state.sourceSelection = null;
  if (source !== "auto") {
    state.sourceRecommendations = [];
    state.sourceRecommendationKey = "";
  }
  document.querySelectorAll(".source-tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.source === source || (source === "zhihu_search" && tab.dataset.source === "auto"));
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
      content_id: item.content_id || "", work_id: item.work_id || "", title: item.title || "",
      author: item.author || "", summary: item.summary || item.description || item.excerpt || "",
      excerpt: item.excerpt || item.description || "", description: item.description || "",
      labels: item.labels || [], url: item.url || "", vote_up_count: item.vote_up_count || 0,
    };
    document.querySelectorAll(".source-tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.source === kind || (kind === "zhihu_search" && tab.dataset.source === "auto")));
    picker.querySelectorAll(".source-item").forEach((row) => row.classList.toggle("is-selected", row.dataset.index === button.dataset.pickSource));
    window.dispatchEvent(new CustomEvent("bookwords:source-selected", { detail: state.sourceSelection }));
  }));
}

function sourceQuery() {
  const cards = activeSourceCards();
  const meanings = cards
    .map((card) => String(card.meaning_cn || card.meaning || "").split(/[；;,，。]/)[0].trim())
    .filter(Boolean)
    .slice(0, 5);
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
    <div class="source-items">${items.map((item, index) => sourceCard(item, index, "hot", item.hot_score !== undefined ? `热度 ${item.hot_score}` : "知乎热榜")).join("")}</div>`;
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

export function refreshSourcePicker() {
  return renderSourcePicker();
}

export function bindSourceEvents() {
  document.querySelectorAll(".source-tab").forEach((tab) => {
    tab.addEventListener("click", () => setSource(tab.dataset.source));
  });
}
