/* views/storybook.js — 知乎英语日报视图：一周 = 一期刊物（本周所有文章整合）。
   存档墙按周分组：点击封面阅读整刊，目录中的按钮进入对应文章练习。
   修复旧版「同一份迷你报 HTML 渲染进两个容器、双倍 DOM + 双 ResizeObserver」：
   只渲染当前可见视图内的容器，切换视图时由 router 重新触发渲染。 */

import { state } from "../state.js";
import { $, esc } from "../utils.js";
import { dailyWeekInfo, localPeriodicalGroups, weekGroups, weekWordCount } from "../articles.js";
import { newspaperIssueCoverBody } from "../newspaper/markup.js";
import { openIssue, openNewspaper } from "../newspaper/reader.js";
import { downloadWordArticle, printNewspaper } from "../newspaper/export.js";
import { openPracticeArticle } from "./practice.js";

/* 一周分组：封面本身是唯一阅读入口，目录为每篇文章提供练习入口。 */
function weekGroupHtml(group, isCurrent) {
  const toc = group.articles.map((article, index) => `
    <li>
      <span class="weekly-toc-no">${String(index + 1).padStart(2, "0")}</span>
      <span class="weekly-toc-title">${esc(article.title || article.story?.title || "知乎英语日报")}</span>
      <button class="weekly-practice-button${article.completedAt ? " is-complete" : ""}" type="button" data-article-id="${esc(article.id)}">${article.completedAt ? "再练习" : "练习"}</button>
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
  root.querySelectorAll(".weekly-cover-button").forEach((button) => fitWeeklyCover(button));
}

function fitWeeklyCover(button) {
  const viewport = button.querySelector(".weekly-cover-viewport");
  const page = button.querySelector(".weekly-cover-page");
  if (!viewport || !page) return;
  const scale = Math.min(0.72, Math.max(0.28, (viewport.clientWidth - 2) / 980));
  const frame = page.querySelector(".paper-cover-frame");
  const sourceHeight = Math.max(930, frame?.scrollHeight || page.scrollHeight || 930);
  page.style.transform = `scale(${scale})`;
  viewport.style.height = `${Math.round(sourceHeight * scale)}px`;
}

function periodicalHtml(period) {
  const groups = localPeriodicalGroups(period);
  if (!groups.length) return `<div class="article-empty">积累日报后，这里会自动形成${period === "month" ? "月刊" : "周刊"}词汇地图。</div>`;
  return `<div class="periodical-summary">${groups.map((group) => {
    const sourceCount = Object.entries(group.sources).map(([name, count]) => `${name} ${count}`).join(" · ");
    const themes = group.themes.map((theme) => `<span title="${esc(theme.words.join(", "))}">${esc(theme.name)} · ${theme.words.length}词</span>`).join("");
    return `<section class="periodical-summary-card"><h4>${esc(group.label || group.key)} ${period === "month" ? "月刊" : "周刊"}</h4><p>${group.articleCount} 篇文章 · ${group.wordCount} 个去重目标词</p><p>题材来源：${esc(sourceCount || "原创")}</p><div class="periodical-theme-list">${themes}</div></section>`;
  }).join("")}</div>`;
}

function dailyHtml() {
  return `<div class="article-list">${state.articles.map((article) => `
    <article class="article-card">
      <div class="article-card-meta"><small>${esc(String(article.generatedAt || "").slice(0, 10))} · ${article.language === "zh" ? "中文呈现" : "英文呈现"}</small><strong>${esc(article.title || article.story?.title || "知乎英语日报")}</strong><span>${esc((article.targetWords || []).join(" · "))}</span></div>
      <div class="article-card-actions"><button class="btn-ghost article-open" type="button" data-article-id="${esc(article.id)}">阅读</button><button class="btn-primary article-practice" type="button" data-article-id="${esc(article.id)}">练习</button></div>
    </article>`).join("")}</div>`;
}

function bindDailyList(root) {
  root.querySelectorAll(".article-open").forEach((button) => button.addEventListener("click", () => openNewspaper(button.dataset.articleId)));
  root.querySelectorAll(".article-practice").forEach((button) => button.addEventListener("click", () => openPracticeArticle(button.dataset.articleId)));
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
        root.innerHTML = state.periodicalView === "week"
          ? groups.map((group) => weekGroupHtml(group, group.weekKey === currentWeek.key)).join("")
          : periodicalHtml("month");
        if (state.periodicalView === "week") bindArticleList(root);
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
