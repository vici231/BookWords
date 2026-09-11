/* views/pool.js — 词汇池视图：左栏单词本多选（搜索/筛选/全选/拖拽）+ 右栏本周池（搜索导入/移除/清空） */

import { Api } from "../api.js";
import { emit, MAX_STORY_CARDS, state } from "../state.js";
import { persist } from "../store.js";
import { $, esc, formatWordbookTime, formatStamp, nowIso, toast, wordbookMeaning, wordbookPos } from "../utils.js";
import { renderPractice } from "./practice.js";
import { refreshSourcePicker } from "./source.js";

/* ---------------- 池子增删 ---------------- */

export function addToPool(word) {
  if (state.pool.length >= MAX_STORY_CARDS) {
    toast(`本周词汇池最多放入 ${MAX_STORY_CARDS} 个单词`);
    return false;
  }
  const key = String(word.word || "").toLowerCase();
  if (state.pool.some((w) => String(w.word || "").toLowerCase() === key)) {
    toast(`「${word.word}」已在本周词汇池中`);
    return false;
  }
  state.pool.push({ ...word, addedAt: nowIso() });
  state.poolUpdatedAt = nowIso();
  persist();
  renderStoryPoolView();
  return true;
}

export function removeFromPool(wordStr) {
  const key = String(wordStr || "").toLowerCase();
  state.pool = state.pool.filter((w) => String(w.word || "").toLowerCase() !== key);
  state.poolUpdatedAt = nowIso();
  persist();
  renderStoryPoolView();
}

/* ---------------- 渲染 ---------------- */

export function renderStoryPoolView() {
  renderPoolList();
  renderWbWordList();
  if (state.source === "auto") refreshSourcePicker();
}

/* 右栏：池子列表（与单词本一致的行式布局） */
function renderPoolList() {
  const list = $("#story-pool-list");
  if (!list) return;
  const count = $("#story-pool-count");
  const updated = $("#story-pool-updated");
  if (count) count.textContent = `${state.pool.length} / ${MAX_STORY_CARDS}`;
  if ($("#word-picker-fab-count")) $("#word-picker-fab-count").textContent = state.pool.length;
  if (updated) updated.textContent = state.poolUpdatedAt ? `最近更新：${formatStamp(state.poolUpdatedAt, "") || "时间未知"}` : "尚未添加单词";
  list.innerHTML = state.pool.length
    ? state.pool.map((word) => `
      <div class="pool-word-row" data-word="${esc(word.word)}">
        <span class="pool-word-main"><strong>${esc(word.word)}</strong><small>${esc(wordbookPos(word.pos))} · ${esc(wordbookMeaning(word))}</small></span>
        <time>${esc(formatWordbookTime(word.addedAt))}</time>
        <button class="btn-link pool-word-remove" type="button" data-word="${esc(word.word)}" title="移出词汇池">移除</button>
      </div>`).join("")
    : `<div class="import-empty">词汇池还是空的。点击“选择生词”，或用上方搜索直接加入。</div>`;
  list.querySelectorAll(".pool-word-remove").forEach((button) => button.addEventListener("click", () => removeFromPool(button.dataset.word)));
}

let wordPickerReturnFocus = null;
let wordPickerDragState = null;

function setWordPicker(open) {
  const backdrop = $("#word-picker-backdrop");
  const trigger = $("#btn-open-word-picker");
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

/* 左栏：单词本多选列表 */
export function renderWbWordList() {
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
      toast(`本周词汇池最多放入 ${MAX_STORY_CARDS} 个单词`);
      break;
    }
    state.pool.push({ ...word, addedAt: oldTimes.get(key) || now });
    added++;
  }
  state.wbSelection.clear();
  if (added) {
    state.poolUpdatedAt = nowIso();
    persist();
    emit("pool");
  }
  renderStoryPoolView();
  toast(added ? `已加入 ${added} 个单词到本周词汇池` : "所选单词都已在本周词汇池中");
  if (added) setWordPicker(false);
}

/* 右栏：搜索全部词库，直接导入池子 */
let poolSearchToken = 0;
let poolSearchWords = [];

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
  } catch (e) { /* 搜索失败时静默，输入继续 */ }
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
      toast(`「${word.word}」已加入本周词汇池`);
      renderPoolSearchResults();
    }
  }));
}

/* ---------------- 事件绑定 ---------------- */

export function bindPoolEvents() {
  $("#btn-open-word-picker")?.addEventListener("click", () => setWordPicker(true));
  $("#btn-close-word-picker")?.addEventListener("click", () => setWordPicker(false));
  $("#word-picker-backdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) setWordPicker(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#word-picker-backdrop")?.hidden) setWordPicker(false);
  });
  /* 右下角 FAB 按钮拖动 */
  const fabBtn = document.querySelector("#btn-open-word-picker");
  document.addEventListener("mousedown", (e) => {
    if (e.target !== fabBtn && !fabBtn?.contains(e.target)) return;
    if (e.target.closest(".word-picker-fab-icon") || e.target.tagName === "IMG") return;
    e.preventDefault();
    const style = window.getComputedStyle(fabBtn);
    const curLeft = parseFloat(style.left) || (window.innerWidth - parseFloat(style.right) - fabBtn.offsetWidth);
    const curTop = parseFloat(style.top) || (window.innerHeight - parseFloat(style.bottom) - fabBtn.offsetHeight);
    wordPickerDragState = { startX: e.clientX, startY: e.clientY, curLeft, curTop, el: fabBtn };
    fabBtn.classList.add("is-dragging");
    document.body.style.cursor = "grabbing";
  });
  document.addEventListener("mousemove", (e) => {
    if (!wordPickerDragState) return;
    const l = e.clientX - wordPickerDragState.startX + wordPickerDragState.curLeft;
    const t = e.clientY - wordPickerDragState.startY + wordPickerDragState.curTop;
    wordPickerDragState.el.style.left = l + "px";
    wordPickerDragState.el.style.top = t + "px";
    wordPickerDragState.el.style.right = "auto";
    wordPickerDragState.el.style.bottom = "auto";
  });
  document.addEventListener("mouseup", () => {
    if (wordPickerDragState) {
      wordPickerDragState.el.classList.remove("is-dragging");
      document.body.style.cursor = "";
      wordPickerDragState = null;
    }
  });
  $("#btn-clear-pool").addEventListener("click", () => {
    state.pool = [];
    state.poolUpdatedAt = nowIso();
    persist();
    state.lastStory = null;
    state.lastArticleId = "";
    state.practiceCompleted = false;
    renderStoryPoolView();
    renderPractice();
    toast("本周词汇池已清空");
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
    if (word && addToPool(word)) toast(`「${word.word}」已加入本周词汇池`);
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
