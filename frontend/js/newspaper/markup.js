/* newspaper/markup.js — 刊物 HTML 结构：
   - newspaperMarkup：线性单页版（存档墙迷你报 + Word 导出用）
   - bookPage + newspaperCoverBody + newspaperPages：翻书分版壳（阅读器用） */

import { esc, formatBold } from "../utils.js";
import { dailyWeekInfo, genreLabelEn } from "../articles.js";

export function newspaperMarkup(article) {
  const story = article?.story || {};
  const sourceNote = story.source_note || "来源：Bookwords 本地存档（历史文章未记录来源）";
  const targets = Array.isArray(article?.targetWords) ? article.targetWords.filter(Boolean) : [];
  return `
    <article class="newspaper-page">
      <header class="newspaper-masthead">
        <div class="newspaper-masthead-top"><span>ZHIHU ENGLISH DAILY</span><span>${esc(article?.weekLabel || dailyWeekInfo(article?.generatedAt).label)} · ${esc(genreLabelEn(article?.genre))}</span></div>
        <div class="newspaper-nameplate">ZHIHU ENGLISH DAILY</div>
      <div class="newspaper-dateline">LEARNING EDITION · ${esc(genreLabelEn(article?.genre))} · ZHIHU LEARNING DESK</div>
      </header>
      <div class="newspaper-grid">
        <section class="newspaper-lead">
          <p class="newspaper-kicker">${esc(genreLabelEn(article?.genre))} · Zhihu REPORT</p>
          <h1>${esc(story.title || article?.title || "Zhihu English Daily")}</h1>
          <p class="newspaper-byline">By the Zhihu Freelance Desk</p>
          <div class="newspaper-rule"></div>
          <div class="newspaper-en">${formatBold(story.en || "")}</div>
          ${story.takeaway ? `<aside class="newspaper-takeaway"><b>TAKEAWAY</b><span>${esc(story.takeaway)}</span></aside>` : ""}
          ${(story.zh || story.cn) ? `<section class="newspaper-translation"><p class="newspaper-kicker">中文翻译</p><div>${formatBold(story.zh || story.cn).replace(/\n/g, "<br>")}</div></section>` : ""}
          <p class="newspaper-source-note">${esc(sourceNote)}</p>
        </section>
        <aside class="newspaper-sidebar">
          <div class="newspaper-box newspaper-box-highlight"><span class="newspaper-box-label">THE MEMORY DESK</span><strong>${targets.length}</strong><small>WORDS STOCKED THIS WEEK</small></div>
        </aside>
      </div>
      <footer class="newspaper-footer"><span>Zhihu Daily</span><span>ISSUE ${esc(article?.weekLabel || dailyWeekInfo(article?.generatedAt).label)}</span></footer>
    </article>`;
}

/* 正文按空行分段，保留 **目标词** 加粗，输出 <p> 段落（报刊排版用）。 */
export function paperParagraphs(text) {
  return formatBold(String(text || ""))
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p>${part.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/* 外层 bookPage 提供 3D 翻页壳；folioLabel 为页脚刊号行；attrs 附加到外壳（如 data-article-idx）。 */
export function bookPage(bodyHtml, folioLabel, attrs = "") {
  const folio = folioLabel
    ? `<div class="paper-folio"><span>ZHIHU ENGLISH DAILY</span><span>${esc(folioLabel)}</span></div>`
    : "";
  return `
    <section class="book-page"${attrs}>
      <div class="page-face page-face-front">${bodyHtml}${folio}</div>
      <div class="page-face page-face-back"><span class="page-back-stamp">ZHIHU ENGLISH DAILY · ZHIHU LEARNING DESK</span></div>
    </section>`;
}

/* 统一封面：每一期同一版式，仅期号、标题与目标词不同。 */
export function newspaperCoverBody(article) {
  const story = article?.story || {};
  const targets = Array.isArray(article?.targetWords) ? article.targetWords.filter(Boolean) : [];
  const week = dailyWeekInfo(article?.generatedAt);
  const weekLabel = article?.weekLabel || week.label;
  const volBase = Date.parse(week.key || "");
  const vol = Number.isFinite(volBase) ? Math.max(1, Math.round((volBase - Date.parse("2026-01-05")) / 604800000) + 1) : 1;
  const done = Boolean(article?.completedAt);
  return `
    <div class="paper-cover-frame">
      <div class="paper-cover-top">
        <p class="paper-cover-vol">VOL.${String(vol).padStart(2, "0")} · ${esc(weekLabel)}</p>
        <div class="paper-cover-mast">Zhihu English Daily</div>
        <p class="paper-cover-sub">Zhihu Learning Desk · ${esc(genreLabelEn(article?.genre))}</p>
      </div>
      <div class="paper-cover-orn"><span></span><i>✦</i><span></span></div>
      <div class="paper-cover-story">
        <p class="paper-cover-kicker">Cover Story</p>
        <h1 class="paper-cover-title">${esc(story.title || article?.title || "Zhihu English Daily")}</h1>
        <p class="paper-cover-by">By the Freelance Desk · Your words, in print</p>
      </div>
      <div class="paper-cover-words"><span>In This Issue · ${targets.length} Target Words</span><div>${targets.length ? targets.map((word) => `<b>${esc(word)}</b>`).join("") : "<small>No target words</small>"}</div></div>
      <div class="paper-cover-base">
        <p class="paper-cover-status"><i class="${done ? "is-done" : ""}"></i>${done ? "This week's fill-in complete" : "This week's fill-in pending"}</p>
        <div class="paper-cover-foot"><span>Zhihu Daily</span><span>Zhihu Learning Desk</span></div>
      </div>
    </div>`;
}

/* 周刊归档封面：蓝白月刊迷你封面（与阅读器整刊封面同一视觉语言）。 */
export function newspaperIssueCoverBody(articles) {
  const list = (articles || []).filter(Boolean);
  const weekLabel = list[0]?.weekLabel || dailyWeekInfo(list[0]?.generatedAt).label;
  const volBase = Date.parse(list[0]?.weekKey || "");
  const vol = Number.isFinite(volBase) ? Math.max(1, Math.round((volBase - Date.parse("2026-01-05")) / 604800000) + 1) : 1;
  const targets = new Set();
  list.forEach((a) => (a.targetWords || []).forEach((w) => w && targets.add(String(w).toLowerCase())));
  const lines = list.slice(0, 3).map((a) => `<span>${esc(a.story?.title || a.title || "")}</span>`).join("");
  return `
    <div class="mag-mini-cover" aria-label="The Zhihu Review, ${list.length} stories">
      <div class="mag-mini-top"><span>VOL.${String(vol).padStart(2, "0")}</span><span>${esc(weekLabel)}</span></div>
      <div class="mag-mini-mast">The Zhihu Review</div>
      <p class="mag-mini-sub">ZHIHU LEARNING DESK · ENGLISH EDITION</p>
      <div class="mag-mini-orn"><span></span><i>✦</i><span></span></div>
      <div class="mag-mini-lines">${lines || "<span>This issue is being prepared…</span>"}</div>
      <div class="mag-mini-foot"><span>${list.length} ${list.length > 1 ? "STORIES" : "STORY"}</span><span>${targets.size} TARGET WORDS</span><span>OPEN →</span></div>
    </div>`;
}

/* 分版刊物（单篇）：统一封面 → 头版。头版带 data-article-idx，正文分页由 pagination.js 处理。 */
export function newspaperPages(article) {
  const pages = [bookPage(articleCoverBody([article]), null)];
  pages.push(articleFrontPage(article, 0, 1));
  return pages;
}

/* 整刊分版（日报 = 一周文章的整合）：统一封面（含目录）→ 每篇文章一个头版。 */
export function issuePages(articles) {
  const list = (articles || []).filter(Boolean);
  const pages = [bookPage(articleCoverBody(list), null)];
  list.forEach((article, i) => pages.push(articleFrontPage(article, i, list.length)));
  return pages;
}

/* 整刊封面：只保留品牌字面，目录与练习状态由存档页承担。 */
function articleCoverBody(articles) {
  const list = (articles || []).filter(Boolean);
  return `
    <div class="paper-cover-frame paper-cover-minimal" aria-label="Zhihu English Daily${list.length ? `, ${list.length} stories` : ""}">
      <div class="paper-cover-wordmark">
        <span>ZHIHU</span>
        <span>ENGLISH</span>
        <span>DAILY</span>
      </div>
    </div>`;
}

/* 单篇文章的头版页（整刊中的一版）。articleIdx 供 pagination 定位分页。 */
function articleFrontPage(article, articleIdx, articleCount) {
  const story = article?.story || {};
  const sourceNote = story.source_note || "来源：Bookwords 本地存档（历史文章未记录来源）";
  const targets = Array.isArray(article?.targetWords) ? article.targetWords.filter(Boolean) : [];
  const weekLabel = esc(article?.weekLabel || dailyWeekInfo(article?.generatedAt).label);
  const storyNo = articleCount > 1 ? `STORY ${articleIdx + 1}/${articleCount} · ` : "";
  return bookPage(`
    <section class="newspaper-page">
      <header class="newspaper-masthead">
        <div class="newspaper-masthead-top"><span>ZHIHU ENGLISH DAILY</span><span>${weekLabel} · ${esc(genreLabelEn(article?.genre))}</span></div>
        <div class="newspaper-nameplate">ZHIHU ENGLISH DAILY</div>
        <div class="newspaper-dateline">${esc(story.dateline || article?.dateline || "Zhihu Daily")} · ZHIHU LEARNING DESK</div>
      </header>
      <div class="newspaper-grid">
        <section class="newspaper-lead">
          <p class="newspaper-kicker">${esc(genreLabelEn(article?.genre))} · Zhihu REPORT</p>
          <h1>${esc(story.title || article?.title || "Zhihu English Daily")}</h1>
          <p class="newspaper-byline">By the Zhihu Freelance Desk</p>
          <div class="newspaper-rule"></div>
          <div class="newspaper-en">${paperParagraphs(story.en)}</div>
          ${story.takeaway ? `<aside class="newspaper-takeaway"><b>TAKEAWAY</b><span>${esc(story.takeaway)}</span></aside>` : ""}
          <p class="newspaper-source-note">${esc(sourceNote)}</p>
        </section>
      </div>
    </section>
    <div class="paper-gloss" data-gloss="words" hidden>
      <div class="paper-gloss-card">
        <p class="newspaper-kicker">THIS STORY · KEY WORDS</p>
        <div class="paper-gloss-words">${targets.length ? targets.map((word) => `<span>${esc(word)}</span>`).join("") : "<small>No target words</small>"}</div>
      </div>
    </div>`, `FRONT PAGE${articleCount > 1 ? ` · STORY ${articleIdx + 1}` : ""}`, ` data-article-idx="${articleIdx}"`);
}
