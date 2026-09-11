/* newspaper/reader.js — 翻书阅读器：
   A4(210/297) contain 书体 + 3D rotateY 翻页 880ms（reduced-motion 直切）+
   键盘 ←/→/Esc + 字体就绪重分页 + 窗口缩放防抖重排。 */

import { state } from "../state.js";
import { $ } from "../utils.js";
import { activeArticle, articlesOfWeek } from "../articles.js";
import { newspaperPages, issuePages } from "./markup.js";
import { paginateFrontPages } from "./pagination.js";

let paperIndex = 0;
let paperTurning = false;
/* 当前打开的刊物：{ type: "article", id } 单篇 | { type: "issue", weekKey } 一周整刊 */
let currentOpen = null;

function paperPages() {
  return Array.from(document.querySelectorAll("#newspaper-body .book-page"));
}

export function paperFlipDuration() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 880;
}

/* 书体尺寸：按 .book-wrap 可用空间以 A4 竖版比例(210:297) contain 计算并直接设内联尺寸。
   四周留 12px 呼吸边距，避免书体贴住框沿或底部被裁。字号保持真实、无变换缩放。 */
export function sizeBook() {
  const wrap = document.querySelector(".book-wrap");
  const book = document.querySelector(".book");
  if (!wrap || !book) return;
  const w = wrap.clientWidth - 24;
  const h = wrap.clientHeight - 24;
  if (w <= 0 || h <= 0) return;
  let bw = h * 210 / 297;   // 竖版：先按高度推导宽度
  if (bw > w) bw = w;       // 宽度不足时改为按宽度约束
  const bh = bw * 297 / 210;
  book.style.width = bw.toFixed(1) + "px";
  book.style.height = bh.toFixed(1) + "px";
}

export function resetPaperPages(pages) {
  (pages || paperPages()).forEach((page, i) => {
    page.classList.remove("is-anim", "is-flipped");
    page.style.zIndex = "1";
    page.style.visibility = i === paperIndex ? "visible" : "hidden";
  });
}

export function applyPaperIndicator() {
  const pages = paperPages();
  if (!pages.length) return;
  const indicator = $("#paper-page-indicator");
  if (indicator) indicator.textContent = paperIndex === 0 ? "COVER" : `PAGE ${paperIndex} / ${pages.length - 1}`;
  const prev = $("#paper-prev");
  const next = $("#paper-next");
  if (prev) prev.disabled = paperTurning || paperIndex <= 0;
  if (next) next.disabled = paperTurning || paperIndex >= pages.length - 1;
}

export function paperGo(delta) {
  const pages = paperPages();
  const target = paperIndex + delta;
  if (paperTurning || target < 0 || target >= pages.length) return;
  const dur = paperFlipDuration();
  if (!dur) {
    paperIndex = target;
    resetPaperPages(pages);
    applyPaperIndicator();
    return;
  }
  paperTurning = true;
  applyPaperIndicator();
  const forward = delta > 0;
  const mover = pages[forward ? paperIndex : target];
  const under = pages[forward ? target : paperIndex];
  pages.forEach((page) => {
    page.style.zIndex = page === mover ? "30" : page === under ? "10" : "1";
    page.style.visibility = page === mover || page === under ? "visible" : "hidden";
  });
  mover.classList.add("is-anim");
  if (forward) {
    requestAnimationFrame(() => requestAnimationFrame(() => mover.classList.add("is-flipped")));
  } else {
    mover.style.transition = "none";
    mover.classList.add("is-flipped");
    void mover.offsetWidth;
    mover.style.transition = "";
    requestAnimationFrame(() => requestAnimationFrame(() => mover.classList.remove("is-flipped")));
  }
  setTimeout(() => {
    mover.classList.remove("is-anim", "is-flipped");
    paperIndex = target;
    paperTurning = false;
    resetPaperPages(pages);
    applyPaperIndicator();
  }, dur + 50);
}

export function openNewspaper(id) {
  const article = state.articles.find((item) => item.id === id) || activeArticle();
  if (!article) return;
  state.lastArticleId = article.id;
  state.lastStory = article.story;
  renderPaper([article], { type: "article", id: article.id });
}

/* 打开一周整刊：本周所有文章整合一期（封面含目录 + 每篇头版）。不动练习目标。 */
export function openIssue(weekKey) {
  const articles = articlesOfWeek(weekKey);
  if (!articles.length) return;
  renderPaper(articles, { type: "issue", weekKey });
}

/* 渲染翻书阅读器；open 用于 resize / 字体就绪后按同一刊物重开。 */
function renderPaper(articles, open) {
  const viewport = $("#newspaper-body");
  if (!viewport) return;
  currentOpen = open;
  $("#newspaper-modal").hidden = false;
  paperIndex = 0;
  paperTurning = false;
  /* 每次分页都从原始文章页开始。paginateFrontPages 会用拆分后的页面替换原节点，
     因此不能在已分页 DOM 上重复执行，否则第二次只能看见第一页的那部分正文。 */
  viewport.innerHTML = issuePages(articles).join("");
  sizeBook();
  paginateFrontPages(articles);
  resetPaperPages();
  applyPaperIndicator();
  document.querySelectorAll("#newspaper-body .paper-gloss").forEach((glass) => (glass.hidden = true));
  ["words"].forEach((key) => {
    const btn = document.querySelector(`#btn-gloss-${key}`);
    if (btn) btn.classList.remove("is-active");
  });
  /* 字体就绪后重算书体尺寸并重跑分页：避免回退字体度量偏大导致正文只占一小块或被裁掉 */
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if ($("#newspaper-modal").hidden || !sameOpen(currentOpen, open)) return;
      const keep = paperIndex;
      viewport.innerHTML = issuePages(articles).join("");
      sizeBook();
      paginateFrontPages(articles);
      paperIndex = Math.min(keep, Math.max(0, paperPages().length - 1));
      resetPaperPages();
      applyPaperIndicator();
    }).catch(() => {});
  }
}

function sameOpen(a, b) {
  return Boolean(a && b && a.type === b.type && (a.id === b.id || a.weekKey === b.weekKey));
}

/* 阅读器当前打开的文章数组（整刊 = 一周所有文章；单篇 = 该篇）；未打开返回 []。
   弹窗内导出按钮用：导出「正在看的这期」。 */
export function currentOpenArticles() {
  if (currentOpen?.type === "issue") return articlesOfWeek(currentOpen.weekKey);
  if (currentOpen?.type === "article") return state.articles.filter((a) => a.id === currentOpen.id);
  return [];
}

/* 按记忆的打开模式重开（窗口缩放后保持内容与页码） */
function reopenPaper() {
  const keep = paperIndex;
  if (currentOpen?.type === "issue") openIssue(currentOpen.weekKey);
  else if (currentOpen?.type === "article" && state.articles.some((a) => a.id === currentOpen.id)) openNewspaper(currentOpen.id);
  else return;
  const pages = paperPages();
  if (pages.length) {
    paperIndex = Math.min(keep, pages.length - 1);
    resetPaperPages();
    applyPaperIndicator();
  }
}

/* 本期词汇：可交互按钮，在当前头版上以浮层显示。 */
function toggleGloss(key) {
  const panel = document.querySelector(`#newspaper-body .paper-gloss[data-gloss="${key}"]`);
  const btn = document.querySelector(`#btn-gloss-${key}`);
  if (!panel) return;
  const show = panel.hidden;
  if (show) {
    // 互斥：一次只显示一个浮层，避免多个浮层重叠
    document.querySelectorAll("#newspaper-body .paper-gloss").forEach((g) => (g.hidden = true));
    ["words"].forEach((k) => {
      const b = document.querySelector(`#btn-gloss-${k}`);
      if (b) b.classList.remove("is-active");
    });
  }
  panel.hidden = !show;
  if (btn) btn.classList.toggle("is-active", show);
}

/* 导出按钮的绑定在 main.js（export.js 依赖本模块的 openNewspaper，避免环） */
export function bindReaderEvents() {
  $("#btn-close-newspaper").addEventListener("click", () => $("#newspaper-modal").hidden = true);
  $("#newspaper-modal").addEventListener("click", (e) => {
    if (e.target.id === "newspaper-modal") $("#newspaper-modal").hidden = true;
  });
  let paperResizeTimer = null;
  window.addEventListener("resize", () => {
    const modal = $("#newspaper-modal");
    if (!modal || modal.hidden || !currentOpen) return;
    clearTimeout(paperResizeTimer);
    paperResizeTimer = setTimeout(reopenPaper, 120);
  });
  /* 刊物阅读器：翻书动画 + 键盘翻页 */
  $("#paper-prev").addEventListener("click", () => paperGo(-1));
  $("#paper-next").addEventListener("click", () => paperGo(1));
  document.querySelectorAll(".paper-toggle").forEach((btn) =>
    btn.addEventListener("click", () => toggleGloss(btn.dataset.gloss))
  );
  document.addEventListener("keydown", (e) => {
    if ($("#newspaper-modal").hidden) return;
    if (e.key === "ArrowRight") paperGo(1);
    else if (e.key === "ArrowLeft") paperGo(-1);
    else if (e.key === "Escape") $("#newspaper-modal").hidden = true;
  });
}
