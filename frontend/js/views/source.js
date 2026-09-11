/* Zhihu source picker: verified 5000+ upvote answers/articles + hot/story/knowledge feeds. */

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
  const seen = new Set();
  return candidates.filter((item) => Number.isFinite(item.stamp) && item.stamp >= start.getTime())
    .sort((a, b) => b.stamp - a.stamp).map((item) => item.card).filter((card) => {
      const key = String(card.word || "").toLowerCase();
      if (!key || seen.has(key)) return false;
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
    tab.classList.toggle("is-active", tab.dataset.source === source);
  });
  renderSourcePicker();
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
    picker.innerHTML = '<div class="source-loading">正在查找 5000+ 赞的知乎回答与文章…</div>';
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
    picker.innerHTML = '<div class="source-guidance">本次搜索没有符合 5000 赞门槛的回答或文章，可调整词汇后重试，或使用原创。</div>';
    return;
  }
  const remaining = result.quota?.remaining;
  picker.innerHTML = `
    <div class="source-note">仅展示 5000+ 赞内容${Number.isFinite(remaining) ? ` · 今日接口剩余 ${remaining}/10 次` : ""}</div>
    <div class="source-items">${items.map((item, index) => `
      <button class="source-item" type="button" data-index="${index}">
        <strong>${esc(item.title || "未命名")}</strong>
        <small>${esc(item.summary || "")}</small>
        <small class="source-labels">赞同 ${esc(item.vote_up_count)}${item.author ? ` · 作者 ${esc(item.author)}` : ""}</small>
      </button>`).join("")}</div>`;
  picker.querySelectorAll(".source-item").forEach((button) => {
    button.addEventListener("click", () => {
      const item = items[Number(button.dataset.index)];
      state.source = "zhihu_search";
      state.sourceSelection = { content_id: item.content_id };
      document.querySelectorAll(".source-tab").forEach((tab) => {
        tab.classList.toggle("is-active", tab.dataset.source === "zhihu_search");
      });
      picker.querySelectorAll(".source-item").forEach((row) => row.classList.remove("is-selected"));
      button.classList.add("is-selected");
    });
  });
}

function renderHotList(picker, items, result) {
  if (!items.length) {
    picker.innerHTML = '<div class="source-guidance">热榜暂无内容。</div>';
    return;
  }
  const remaining = result.quota?.remaining;
  picker.innerHTML = `
    <div class="source-note">知乎热榜${Number.isFinite(remaining) ? ` · 今日接口剩余 ${remaining}/10 次` : ""}</div>
    <div class="source-items">${items.map((item, index) => `
      <button class="source-item" type="button" data-index="${index}">
        <strong>${esc(item.title || "未命名")}</strong>
        <small>${esc(item.description || item.excerpt || item.content_text || "")}</small>
        <small class="source-labels">热榜 ${esc(item.hot_score !== undefined ? "热度 " + item.hot_score : "")}</small>
      </button>`).join("")}</div>`;
  picker.querySelectorAll(".source-item").forEach((button) => {
    button.addEventListener("click", () => {
      const item = items[Number(button.dataset.index)];
      state.source = "hot";
      state.sourceSelection = {
        content_id: item.content_id || "",
        title: item.title,
        excerpt: item.excerpt || item.description || "",
        summary: item.summary || item.excerpt || item.description || "",
        url: item.url || "",
        labels: item.labels || [],
      };
      picker.querySelectorAll(".source-item").forEach((row) => row.classList.remove("is-selected"));
      button.classList.add("is-selected");
    });
  });
}

function renderContentList(picker, items, kind) {
  if (!items.length) {
    picker.innerHTML = '<div class="source-guidance">暂无内容。</div>';
    return;
  }
  const label = kind === "story" ? "故事" : "知识";
  picker.innerHTML = `
    <div class="source-note">知乎${label}</div>
    <div class="source-items">${items.map((item, index) => `
      <button class="source-item" type="button" data-index="${index}">
        <strong>${esc(item.title || "未命名")}</strong>
        <small>${esc(item.description || "")}</small>
        <small class="source-labels">${item.labels?.length ? item.labels.join(" · ") : ""}</small>
      </button>`).join("")}</div>`;
  picker.querySelectorAll(".source-item").forEach((button) => {
    button.addEventListener("click", () => {
      const item = items[Number(button.dataset.index)];
      state.source = kind;
       state.sourceSelection = {
         work_id: item.work_id,
         title: item.title,
         description: item.description,
         summary: item.description,
         labels: item.labels || [],
       };
      picker.querySelectorAll(".source-item").forEach((row) => row.classList.remove("is-selected"));
      button.classList.add("is-selected");
    });
  });
}

export function refreshSourcePicker() {
  return renderSourcePicker();
}

export function bindSourceEvents() {
  document.querySelectorAll(".source-tab").forEach((tab) => {
    tab.addEventListener("click", () => setSource(tab.dataset.source));
  });
}
