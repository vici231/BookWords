/* Four-mode practice engine plus recent-mistake reinforcement. */

import { emit, state } from "../state.js";
import { markArticleCompleted } from "../articles.js";
import { persist } from "../store.js";
import { $, esc } from "../utils.js";
import { showView } from "../router.js";

const MODES = [["target", "目标词填空"], ["choice", "选词填空"], ["spelling", "拼写"], ["sentence", "句子排序"]];

const activeArticle = () => state.articles.find((item) => item.id === state.lastArticleId) || null;
const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function targetCards() {
  const article = activeArticle();
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
  const shuffled = sentences.map((sentence, index) => ({ sentence, index })).sort((a, b) => ((a.index * 7 + 3) % 11) - ((b.index * 7 + 3) % 11));
  return `<div class="sentence-sort">${shuffled.map((item) => `<div class="sentence-sort-row" data-answer-index="${item.index}"><span>${esc(item.sentence)}</span><button type="button" data-move="up">↑</button><button type="button" data-move="down">↓</button></div>`).join("")}</div>`;
}

const renderModeBody = () => state.practiceMode === "choice" ? choiceExercise() : state.practiceMode === "spelling" ? spellingExercise() : state.practiceMode === "sentence" ? sentenceExercise() : targetExercise();

export function renderInlinePractice() {
  const root = $("#inline-practice");
  if (!root || !state.lastStory?.en) return;
  const result = state.practiceResults[state.lastArticleId]?.[state.practiceMode];
  root.innerHTML = `<div class="practice-mode-tabs">${MODES.map(([id, label]) => `<button class="${state.practiceMode === id ? "is-active" : ""}" type="button" data-practice-mode="${id}">${label}</button>`).join("")}</div><div class="inline-practice-head"><strong>${MODES.find(([id]) => id === state.practiceMode)?.[1]}</strong><span>${result ? `上次 ${result.score}/${result.total}` : "完成后记录错词"}</span></div><div id="inline-practice-body">${renderModeBody()}</div><div id="inline-practice-feedback" class="practice-feedback" hidden></div><div class="practice-actions"><button id="btn-check-inline-practice" class="btn-primary" type="button">提交并检查</button><button id="btn-reset-inline-practice" class="btn-ghost" type="button">重新练习</button></div>`;
  root.querySelectorAll("[data-practice-mode]").forEach((button) => button.addEventListener("click", () => { state.practiceMode = button.dataset.practiceMode; renderInlinePractice(); }));
  root.querySelectorAll("[data-move]").forEach((button) => button.addEventListener("click", () => {
    const row = button.closest(".sentence-sort-row"); const sibling = button.dataset.move === "up" ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return;
    if (button.dataset.move === "up") row.parentElement.insertBefore(row, sibling); else row.parentElement.insertBefore(sibling, row);
  }));
  $("#btn-check-inline-practice")?.addEventListener("click", checkInlinePractice);
  $("#btn-reset-inline-practice")?.addEventListener("click", renderInlinePractice);
}

function recordMistakes(words) {
  const now = new Date().toISOString(); const cards = targetCards(); const keys = new Set(words.map((word) => String(word).toLowerCase()));
  state.recentMistakes = state.recentMistakes.filter((item) => !keys.has(String(item.word).toLowerCase()));
  words.forEach((word) => { const key = String(word).toLowerCase(); delete state.masteredWords[key]; state.recentMistakes.unshift({ word, card: cards.find((card) => String(card.word).toLowerCase() === key) || { word }, wrongAt: now, articleId: state.lastArticleId, practiceMode: state.practiceMode }); });
  const cutoffDate = new Date(); cutoffDate.setHours(0, 0, 0, 0); cutoffDate.setDate(cutoffDate.getDate() - 2);
  const cutoff = cutoffDate.getTime();
  state.recentMistakes = state.recentMistakes.filter((item) => new Date(item.wrongAt).getTime() >= cutoff);
}

function checkInlinePractice() {
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
  state.practiceResults[state.lastArticleId] ||= {};
  state.practiceResults[state.lastArticleId][state.practiceMode] = { score, total: results.length, wrongWords, completedAt: new Date().toISOString() };
  recordMistakes(wrongWords);
  if (wrongWords.length) { const article = activeArticle(); if (article) article.completedAt = ""; }
  const allPerfect = MODES.every(([mode]) => { const value = state.practiceResults[state.lastArticleId]?.[mode]; return value && value.total > 0 && value.score === value.total; });
  state.practiceCompleted = allPerfect;
  if (allPerfect) markArticleCompleted();
  persist(); emit("articles");
  const feedback = $("#inline-practice-feedback"); feedback.hidden = false; feedback.className = `practice-feedback is-${wrongWords.length ? "warning" : "success"}`;
  feedback.innerHTML = `<span class="practice-feedback-icon">${wrongWords.length ? "!" : "✓"}</span><span><strong>得分 ${score} / ${results.length}</strong><small>${wrongWords.length ? `错词已回流近三日：${esc(wrongWords.join("、"))}` : allPerfect ? "四种练习全部满分，本期已完成。" : "本模式满分，继续完成其他练习。"}</small></span>`;
}

export function withStoryGlosses(text, story, article = null) {
  const cards = article?.targetCards?.length ? article.targetCards : [...state.pool, ...state.wordbook];
  const meanings = new Map(cards.map((card) => [String(card.word).toLowerCase(), String(card.meaning_cn || card.meaning || card.meaning_en || "").split(/[；;，,、/|]/)[0]]));
  const used = new Set();
  return String(text || "").replace(/\*\*([^*]+)\*\*/g, (full, raw) => { const key = raw.trim().toLowerCase(); if (!meanings.get(key) || used.has(key)) return full; used.add(key); return `**${raw}**（${meanings.get(key)}）`; });
}

export function renderPractice() {
  const empty = $("#practice-empty"); const card = $("#practice-card"); const story = $("#practice-story");
  if (!empty || !card || !story) return;
  empty.hidden = Boolean(state.lastStory?.en); card.hidden = !state.lastStory?.en;
  if (!state.lastStory?.en) return;
  let index = 0;
  story.innerHTML = `<h3>${esc(state.lastStory.title || "记忆故事")}</h3><p>${esc(state.lastStory.en).replace(/\*\*([^*]+)\*\*/g, (_, word) => practiceInput(word, ++index)).replace(/\n/g, "<br>")}</p>`;
  $("#practice-score").textContent = `${index} 个空 · 完整练习请使用文章上方“练习”标签`;
}

export function openPracticeArticle(id) {
  const article = state.articles.find((item) => item.id === id); if (!article) return;
  state.lastArticleId = article.id; state.lastStory = article.story; state.practiceCompleted = false; state.workflowStage = "result"; state.resultMode = "practice";
  showView("story-pool-view"); requestAnimationFrame(() => { renderPractice(); $("#practice-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" }); });
}

export function bindPracticeEvents() {
  $("#btn-check-practice")?.addEventListener("click", () => { document.querySelectorAll("#practice-story input[data-answer]").forEach((input) => input.classList.toggle("is-wrong", input.value.trim().toLowerCase() !== input.dataset.answer.trim().toLowerCase())); });
  $("#btn-reset-practice")?.addEventListener("click", renderPractice);
}
