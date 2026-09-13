/* views/wordbook.js — 单词本视图：按日期分组列表 + 排序 + 移除 + 报纸存档墙（随视图渲染） */

import { state, emit } from "../state.js";
import { persist } from "../store.js";
import { Api } from "../api.js";
import { $, esc, formatWordbookTime, nowIso, parseStamp, toast, wordbookMeaning, wordbookPos, formatWordbookDate } from "../utils.js";
import { openWordDetail } from "./library.js";
import { renderArticleBook } from "./storybook.js";
import { showView } from "../router.js";

function normalizeWordEntry(entry) {
  if (entry && entry.review) { try { delete entry.review; } catch (e) { entry.review = undefined; } }
  return entry;
}

export function saveToWordbook(word) {
  const key = String(word.word || "").toLowerCase();
  if (state.wordbook.some((w) => String(w.word || "").toLowerCase() === key)) {
    toast(`「${word.word}」已经在单词本里`);
    return;
  }
  const entry = normalizeWordEntry({ ...word, savedAt: nowIso() });
  state.wordbook.unshift(entry);
  persist();
  emit("wordbook");
  toast(`「${word.word}」已收藏进单词本`);
}

export function removeFromWordbook(word) {
  const key = String(word || "").toLowerCase();
  state.wordbook = state.wordbook.filter((w) => String(w.word || "").toLowerCase() !== key);
  persist();
  emit("wordbook");
}

/* —— 手机端：单词本顶部搜索栏（≤980px 显示）——
   与搜索词库同款交互：搜全词库 → 结果行可直接收藏；清空即收起，露出单词本列表。 */
export function bindWordbookMobileSearch() {
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
      box.hidden = true; box.classList.remove("has-results"); box.innerHTML = "";
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
      const result = String(a.word.word).localeCompare(String(b.word.word), "en", { sensitivity: "base" });
      return state.wordbookSort === "alpha-desc" ? -result : result;
    }
    const at = parseStamp(a.word.savedAt)?.getTime() || 0;
    const bt = parseStamp(b.word.savedAt)?.getTime() || 0;
    const result = bt - at;
    return result || a.index - b.index;
  }).map(({ word }) => word);
}

export function renderWordbook() {
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
            <span class="wordbook-level">${esc((w.levels && w.levels[0]) || w.level || "词库")}</span>
            <button class="wordbook-detail-link" type="button" data-word="${esc(w.word)}">详情 <span aria-hidden="true">›</span></button>
            <button class="wordbook-remove btn-link" type="button" data-word="${esc(w.word)}">移除</button>
          </article>`;
        }).join("")}</div>
      </section>`).join("");
    list.querySelectorAll(".wordbook-remove").forEach((button) => button.addEventListener("click", () => removeFromWordbook(button.dataset.word)));
    list.querySelectorAll(".wordbook-detail-link").forEach((button) => button.addEventListener("click", () => openWordDetail(button.dataset.word)));
  }
  /* 单词本视图内的报纸存档墙随视图一起渲染（只渲染当前可见容器） */
  renderArticleBook();
}

export function bindWordbookEvents() {
  document.querySelectorAll(".wordbook-sort").forEach((button) => button.addEventListener("click", () => {
    state.wordbookSort = button.dataset.sort;
    renderWordbook();
  }));
  $("#btn-wordbook-export").addEventListener("click", () => window.print());
}
