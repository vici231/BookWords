/* views/library.js — 搜索词库视图：传统列表行，收藏带标识 + 自设单词弹窗 */

import { Api } from "../api.js";
import { state } from "../state.js";
import { $, esc, toast, wordbookMeaning, wordbookPos } from "../utils.js";
import { saveToWordbook } from "./wordbook.js";

export function renderLibrary() {
  const list = $("#lib-list");
  if (!list) return;
  const rows = state.libraryCards;
  $("#card-count").textContent = `${rows.length}`;
  $("#lib-empty").hidden = rows.length > 0;
  list.innerHTML = rows.map((w) => {
    const key = String(w.word || "").toLowerCase();
    const saved = state.wordbook.some((item) => String(item.word || "").toLowerCase() === key);
    const level = w.level || (Array.isArray(w.levels) ? w.levels.join(" / ") : "");
    return `<div class="lib-row"><span class="lib-row-main"><strong>${esc(w.word)}</strong><small>${esc(wordbookPos(w.pos))} · ${esc(wordbookMeaning(w))}</small></span>${level ? `<span class="lib-row-level">${esc(level)}</span>` : ""}${saved ? '<span class="wb-in-pool is-saved">已收藏</span>' : `<button class="btn-link lib-row-save" type="button" data-word="${esc(w.word)}">♡ 收藏</button>`}</div>`;
  }).join("");
  list.querySelectorAll(".lib-row-save").forEach((button) => button.addEventListener("click", () => {
    const word = state.libraryCards.find((item) => item.word === button.dataset.word);
    if (!word) return;
    saveToWordbook(word);
    renderLibrary();
  }));
}

/* 刷新库展示：有搜索词→搜索；否则按 kind（daily/random）取一组。 */
export async function refreshLibrary(kind = "daily") {
  let words = [];
  try {
    const q = state.search.trim();
    if (q || state.pos) {
      const r = await Api.searchWords(q, state.level, 60, state.pos);
      words = r.words || [];
    } else if (kind === "random") {
      const r = await Api.randomWords(state.level, 12);
      words = r.words || [];
    } else {
      const r = await Api.dailyWords(state.level, 12);
      words = r.words || [];
    }
  } catch (err) {
    toast("加载词库失败：" + err.message);
  }
  state.libraryCards = words;
  renderLibrary();
}

/* 从单词本详情跳转：带词直达搜索 */
export function openWordDetail(word) {
  state.level = "all";
  state.pos = "";
  state.search = word;
  $("#word-level").value = "all";
  $("#pos-filter").value = "";
  $("#search").value = word;
  refreshLibrary("daily");
}

/* ---------------- 自设单词弹窗 ---------------- */

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

export function bindLibraryEvents() {
  let t;
  $("#search").addEventListener("input", (e) => {
    state.search = e.target.value;
    clearTimeout(t);
    t = setTimeout(() => refreshLibrary("daily"), 150);
  });
  $("#word-level").addEventListener("change", (e) => {
    state.level = e.target.value;
    refreshLibrary("daily");
  });
  $("#pos-filter").addEventListener("change", (e) => {
    state.pos = e.target.value;
    refreshLibrary("daily");
  });
  $("#btn-reset-filter").addEventListener("click", () => {
    state.level = "all";
    state.pos = "";
    state.search = "";
    $("#word-level").value = "all";
    $("#pos-filter").value = "";
    $("#search").value = "";
    refreshLibrary("daily");
  });
  /* 随机 / 今日：清空残留搜索词（例如从单词本详情跳转而来），确保列表不会卡在上一个词。 */
  const clearSearchBox = () => { state.search = ""; $("#search").value = ""; };
  $("#btn-random").addEventListener("click", () => { clearSearchBox(); refreshLibrary("random"); });
  $("#btn-daily").addEventListener("click", () => { clearSearchBox(); refreshLibrary("daily"); });

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
