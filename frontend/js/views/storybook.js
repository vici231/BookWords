/* views/storybook.js — 知乎英语日报视图：一周 = 一期刊物（本周所有文章整合）。
   存档墙按周分组：点击封面阅读整刊，目录中的按钮进入对应文章练习。
   修复旧版「同一份迷你报 HTML 渲染进两个容器、双倍 DOM + 双 ResizeObserver」：
   只渲染当前可见视图内的容器，切换视图时由 router 重新触发渲染。 */

import { state } from "../state.js";
import { persist } from "../store.js";
import { $, esc, toast } from "../utils.js";
import { dailyWeekInfo, deleteArticle, localPeriodicalGroups, weekGroups, weekWordCount } from "../articles.js";
import { newspaperIssueCoverBody } from "../newspaper/markup.js";
import { openIssue, openIssueArticles, openNewspaper } from "../newspaper/reader.js";
import { downloadWordArticle, printNewspaper } from "../newspaper/export.js";
import { openPracticeArticle } from "./practice.js";

/* 一周分组：封面本身是唯一阅读入口，目录为每篇文章提供练习入口。 */
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
    const sourceCount = Object.entries(selectedArticles.reduce((map, article) => { const source = article.story?.source_type || "original"; map[source] = (map[source] || 0) + 1; return map; }, {})).map(([name, count]) => `${name} ${count}`).join(" · ");
    const themes = selectedArticles.flatMap((article) => {
      const group = article.sorting?.selected_group || {};
      return [{ name: group.theme || "本期选题", words: group.words || article.targetWords || [] }];
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
  /* 阅读整刊：勾选的文章（未保存过则全部）按月刊版式翻开 */
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

export function renderArticleBook() {
  const list = $("#article-list");        // 单词本视图内的存档墙
  const storyList = $("#story-book-list"); // 日报视图内的存档墙
  const count = $("#article-count");
  const storyCount = $("#story-book-count");
  if (!list && !storyList) return;

  /* 日报存档 = 本周所有文章的整合：统计篇数与目标词总数（去重） */
  const currentWeek = dailyWeekInfo();
  const weekArticles = state.articles.filter((article) => (article.weekKey || dailyWeekInfo(article.generatedAt).key) === currentWeek.key);
  const weeklyWordCount = $("#weekly-word-count");
  const weeklyIssueNote = $("#weekly-issue-note");
  if (weeklyWordCount) weeklyWordCount.textContent = weekWordCount(currentWeek.key) || state.wordbook.filter((word) => dailyWeekInfo(word.savedAt).key === currentWeek.key).length;
  if (weeklyIssueNote) weeklyIssueNote.textContent = weekArticles.length
    ? `${currentWeek.label} · 本周已出版 ${weekArticles.length} 篇，整合为一期刊物`
    : `${currentWeek.label} · 今天尚未生成`;
  const readIssueBtn = $("#btn-read-weekly-issue");
  if (readIssueBtn) readIssueBtn.hidden = !weekArticles.length;
  if (count) count.textContent = state.articles.length;

  const containers = [list, storyList].filter(Boolean);
  if (!state.articles.length) {
    containers.forEach((root) => (root.innerHTML = `<div class="article-empty">生成刊物后，每周的文章会整合成一期日报保存在这里。</div>`));
    return;
  }
  /* 只渲染当前可见（激活视图内）的容器；隐藏容器清空，切换视图时 router 会重新渲染 */
  const activeView = document.querySelector(".view.active");
  const groups = weekGroups();
  /* 周刊视图只展示“一周一刊”，右上角数字也对应刊物数量，而不是文章数量。 */
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

export function bindStorybookEvents() {
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
