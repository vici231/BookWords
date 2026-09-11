/* views/practice.js — 故事选词填空练习 + 练习后解锁的原文（含中文注释）
   修复：往期刊物的中文注释改用该期自带的 targetCards，而非当前词汇池。 */

import { state } from "../state.js";
import { markArticleCompleted } from "../articles.js";
import { $, esc, formatBold, formatStamp } from "../utils.js";
import { showView } from "../router.js";

function practiceInput(word, index) {
  const serial = String(index).padStart(2, "0");
  return `<span class="practice-blank"><span class="practice-blank-index" aria-hidden="true">${serial}</span><input class="practice-input" type="text" autocomplete="off" spellcheck="false" data-answer="${esc(word)}" data-index="${index}" aria-label="填写第 ${index} 个单词"></span>`;
}

function updatePracticeProgress() {
  const inputs = [...document.querySelectorAll("#practice-story .practice-input")];
  const filled = inputs.filter((input) => input.value.trim()).length;
  const correct = inputs.filter((input) => String(input.dataset.answer || "").trim().toLowerCase() === input.value.trim().toLowerCase()).length;
  const total = inputs.length;
  const label = $("#practice-progress-label");
  const fill = $("#practice-progress-fill");
  if (label) label.textContent = `${filled} / ${total}`;
  if (fill) fill.style.width = `${total ? (filled / total) * 100 : 0}%`;
  return { inputs, total, filled, correct };
}

function setPracticeFeedback(kind, title, copy) {
  const feedback = $("#practice-feedback");
  if (!feedback) return;
  feedback.className = `practice-feedback is-${kind}`;
  feedback.innerHTML = `<span class="practice-feedback-icon" aria-hidden="true">${kind === "success" ? "✓" : kind === "warning" ? "!" : "•"}</span><span><strong>${esc(title)}</strong><small>${esc(copy)}</small></span>`;
  feedback.hidden = false;
}

function clearPracticeFeedback() {
  const feedback = $("#practice-feedback");
  if (!feedback) return;
  feedback.hidden = true;
  feedback.textContent = "";
  feedback.className = "practice-feedback";
}

/* ---------------- 中文注释（gloss） ---------------- */

/* storyGlosses(story, article)：优先该期刊物自带的 targetCards（往期练习注释对得上当期词），
   没有时退回当前词汇池；最后用 hooks 兜底。 */
function storyGlosses(story, article = null) {
  const chinese = new Map();
  const hookGlosses = [];
  const add = (map, word, gloss) => {
    const key = String(word || "").trim().toLowerCase();
    /* 中文辅助阅读只保留当前语境的一个义项，避免把词库的整串释义带进文章。 */
    const value = String(gloss || "").split(/[；;，,、/|]/)[0].split(/[（(]/)[0].trim();
    if (key && value && !map.has(key)) map.set(key, value);
  };

  /* hooks 只作为缺少词卡中文释义时的兜底，不再注入英文原文。 */
  (story?.hooks || []).forEach((hook) => {
    const match = String(hook).match(/^\s*\**([^*:]+?)\**\s*[:：]\s*(.+?)\s*$/);
    if (!match) return;
    hookGlosses.push(match);
  });

  const targetCards = Array.isArray(article?.targetCards) && article.targetCards.length
    ? article.targetCards
    : state.pool;
  [...targetCards, ...state.wordbook].forEach((card) => {
    add(chinese, card.word, card.meaning_cn || card.meaning || card.meaning_en);
  });
  /* 没有中文卡片释义时，才用 hooks 的内容兜底，并同样只取一个义项。 */
  hookGlosses.forEach((match) => add(chinese, match[1], match[2]));
  return { chinese };
}

export function withStoryGlosses(text, story, article = null) {
  const glosses = storyGlosses(story, article).chinese;
  const used = new Set();
  return String(text || "").replace(/\*\*([^*]+)\*\*/g, (full, rawWord) => {
    const word = rawWord.trim();
    const key = word.toLowerCase();
    const gloss = glosses.get(key);
    if (!gloss || used.has(key)) return full;
    used.add(key);
    return `**${rawWord}**（${gloss}）`;
  });
}

/* ---------------- 渲染与判分 ---------------- */

function renderPracticeSource() {
  const source = $("#practice-source");
  if (!source) return;
  source.hidden = !state.practiceCompleted || !state.lastStory;
  if (source.hidden || !state.lastStory) return;
  const article = state.articles.find((item) => item.id === state.lastArticleId) || null;
  $("#practice-source-en").innerHTML = formatBold(state.lastStory.en || "");
  $("#practice-source-cn").innerHTML = state.lastStory.zh
    ? formatBold(state.lastStory.zh)
    : formatBold(withStoryGlosses(state.lastStory.cn, state.lastStory, article));
  const stamp = article?.completedAt ? formatStamp(article.completedAt, "完成于 ") : null;
  const timeEl = $("#practice-completed-at");
  if (timeEl) timeEl.textContent = stamp || "";
}

export function renderPractice() {
  const empty = $("#practice-empty");
  const card = $("#practice-card");
  const storyBox = $("#practice-story");
  if (!empty || !card || !storyBox) return;
  if (!state.lastStory || !state.lastStory.en) {
    empty.hidden = false;
    card.hidden = true;
    renderPracticeSource();
    return;
  }
  empty.hidden = true;
  card.hidden = false;
  let found = 0;
  const makeBlank = (word) => {
    found += 1;
    return practiceInput(word.trim(), found);
  };
  let html = esc(state.lastStory.en).replace(/\*\*([^*]+)\*\*/g, (_, word) => {
    return makeBlank(word);
  });
  if (!found) {
    html = esc(state.lastStory.en);
    state.pool.slice(0, 6).forEach((word) => {
      const re = new RegExp(`\\b${String(word.word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(html)) {
        html = html.replace(re, makeBlank(word.word));
      }
    });
  }
  storyBox.innerHTML = `<h3>${esc(state.lastStory.title || "记忆故事")}</h3><p>${html.replace(/\n/g, "<br>")}</p>`;
  $("#practice-score").textContent = `${found} 个空 · 全对后解锁原文`;
  clearPracticeFeedback();
  const inputs = [...storyBox.querySelectorAll(".practice-input")];
  inputs.forEach((input, index) => {
    input.addEventListener("input", () => {
      input.classList.remove("is-correct", "is-wrong");
      input.removeAttribute("aria-invalid");
      if (!state.practiceCompleted) clearPracticeFeedback();
      updatePracticeProgress();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const next = inputs[index + 1];
      if (next) next.focus();
      else checkPractice();
    });
  });
  updatePracticeProgress();
  renderPracticeSource();
  storyBox.querySelector(".practice-input")?.focus();
}

function checkPractice() {
  const { inputs, total, filled } = updatePracticeProgress();
  if (!inputs.length) return;
  if (!filled) {
    state.practiceCompleted = false;
    setPracticeFeedback("info", "先试着填一填", "填写任意一个空后再提交，按 Enter 可以跳到下一题。");
    return;
  }
  let correct = 0;
  let incorrect = 0;
  inputs.forEach((input) => {
    const answer = String(input.dataset.answer || "").trim().toLowerCase();
    const value = input.value.trim().toLowerCase();
    const isCorrect = value === answer;
    input.classList.toggle("is-correct", isCorrect);
    input.classList.toggle("is-wrong", !isCorrect);
    input.setAttribute("aria-invalid", isCorrect ? "false" : "true");
    if (isCorrect) correct += 1;
    else incorrect += 1;
  });
  state.practiceCompleted = correct === total;
  if (state.practiceCompleted) {
    markArticleCompleted();
    $("#practice-score").textContent = `答对 ${correct} / ${total} · 源文本已解锁`;
    setPracticeFeedback("success", "全部正确，做得很好", "已解锁英文源文本和中文辅助记忆。");
  } else {
    $("#practice-score").textContent = `答对 ${correct} / ${total} · 再订正 ${incorrect} 个`;
    setPracticeFeedback("warning", `还有 ${incorrect} 个词需要订正`, "红色输入框需要再想一想；修改后可以再次提交。");
  }
  renderPracticeSource();
}

/* 从存档墙点「去练习」：把练习目标切到往期刊物 */
export function openPracticeArticle(id) {
  const article = state.articles.find((item) => item.id === id);
  if (!article) return;
  state.lastArticleId = article.id;
  state.lastStory = article.story;
  state.practiceCompleted = false;
  showView("story-pool-view");
  requestAnimationFrame(() => {
    renderPractice();
    $("#practice-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

export function bindPracticeEvents() {
  $("#btn-check-practice").addEventListener("click", checkPractice);
  $("#btn-reset-practice").addEventListener("click", () => {
    state.practiceCompleted = false;
    renderPractice();
  });
}
