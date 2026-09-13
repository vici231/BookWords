/* newspaper/magazine.js — 整刊月刊版式（蓝白色调）：
   周刊/月刊打开时渲染成一本分栏式英文杂志：封面（生成插画 + 头条目录）→
   Contents → 每篇文章按字数分两档版面（≤300 词 BRIEF 双栏 / >300 词 FEATURE 三栏）。
   正文分页复用 pagination.js 的实测算法思想：词组切片 + 离屏探针量高 + 贪心装版，
   字号不缩、页内无滑条、每版整页完整显示。 */

import { esc } from "../utils.js";
import { dailyWeekInfo, genreLabelEn } from "../articles.js";
import { bookPage, paperParagraphs } from "./markup.js";

/* ------------------------------------------------------------------
   文本工具
------------------------------------------------------------------ */

const MONTHS_EN = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

function articleWords(article) {
  const en = String(article?.story?.en || "");
  return (en.match(/[A-Za-z0-9'’-]+/g) || []).length;
}

function articleSentences(article) {
  return String(article?.story?.en || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z"“'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* dek：takeaway 为英文时直接用作导语，否则取正文第一句截短 */
function articleDek(article) {
  const takeaway = String(article?.story?.takeaway || "").trim();
  const latin = (takeaway.match(/[A-Za-z]/g) || []).length;
  if (takeaway && latin >= takeaway.length * 0.5) return takeaway;
  const first = articleSentences(article)[0] || "";
  return first.length > 150 ? `${first.slice(0, 147).trimEnd()}…` : first;
}

/* pull quote：取正文第二句（8–32 词），没有就省略 */
function articlePull(article) {
  const s = articleSentences(article)[1] || "";
  const words = (s.match(/[A-Za-z0-9'’-]+/g) || []).length;
  return s && words >= 8 && words <= 32 ? s : "";
}

function articleMinutes(words) {
  return Math.max(1, Math.round(words / 200));
}

function articleTargets(article) {
  return Array.isArray(article?.targetWords) ? article.targetWords.filter(Boolean) : [];
}

/* ------------------------------------------------------------------
   期号 / 生成插画
------------------------------------------------------------------ */

function issueLabel(meta, articles) {
  if (meta?.period === "month" && /^\d{4}-\d{2}$/.test(meta.key || "")) {
    const [y, m] = meta.key.split("-").map(Number);
    return `${MONTHS_EN[m - 1]} ${y}`;
  }
  return articles[0]?.weekLabel || dailyWeekInfo(articles[0]?.generatedAt).label;
}

function issueVol(meta, articles) {
  if (meta?.period === "month" && /^\d{4}-\d{2}$/.test(meta.key || "")) {
    const [y, m] = meta.key.split("-").map(Number);
    return Math.max(1, (y - 2026) * 12 + m);
  }
  const key = articles[0]?.weekKey || dailyWeekInfo(articles[0]?.generatedAt).key;
  const base = Date.parse(key || "");
  return Number.isFinite(base) ? Math.max(1, Math.round((base - Date.parse("2026-01-05")) / 604800000) + 1) : 1;
}

/* 生成插画：text_to_image 接口，prompt 编码后直接作为图片 URL。
   相同 prompt 稳定出同一张图（CDN 缓存），蓝白版面全程可控。 */
function genImage(prompt, size) {
  return `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodeURIComponent(prompt)}&image_size=${size}`;
}

const GENRE_SCENE = {
  "daily-science": "everyday science wonders on a study desk",
  "daily-curiosity": "curious mind exploring strange little facts",
  "light-entertainment": "playful pop culture scene with stars",
};

function articleHero(article) {
  const title = String(article?.story?.title || article?.title || "").slice(0, 90);
  const scene = GENRE_SCENE[article?.genre] || "quiet reading corner with books";
  return genImage(
    `flat editorial magazine illustration, ${scene}, about ${title}, limited palette of cobalt blue, sky blue and pure white, bold flat shapes, risograph print grain, vintage poster art, elegant, no text`,
    "landscape_16_9"
  );
}

function issueCoverImage(meta, articles) {
  const label = issueLabel(meta, articles);
  return genImage(
    `flat editorial magazine cover illustration, tall stack of books and an open magazine with a lighthouse, sea of clouds, limited palette of cobalt blue, sky blue and pure white, bold flat shapes, risograph print grain, vintage poster art, elegant, no text, ${label}`,
    "portrait_4_3"
  );
}

/* ------------------------------------------------------------------
   页面骨架
------------------------------------------------------------------ */

const MAG_PERIOD_NOUN = (meta) => (meta?.period === "month" ? "month" : "week");

/* 封面：报头 + 生成插画 + 头条（点击跳页） */
function magCoverHtml(articles, meta) {
  const list = (articles || []).filter(Boolean);
  const label = issueLabel(meta, list);
  const vol = issueVol(meta, list);
  const words = new Set();
  list.forEach((a) => articleTargets(a).forEach((w) => w && words.add(String(w).toLowerCase())));
  const lines = list.slice(0, 3).map((a, i) => `
    <li class="mag-cover-line" data-goto-page="cover" data-mag-article="${i}">
      <span class="mag-cover-line-no">0${i + 1}</span>
      <span class="mag-cover-line-title">${esc(a.story?.title || a.title || "")}</span>
      <span class="mag-cover-line-page" data-mag-ref="${i}">—</span>
    </li>`).join("");
  return `
    <div class="mag-cover">
      <header class="mag-cover-top">
        <span class="mag-cover-vol">VOL.${String(vol).padStart(2, "0")} · ${esc(label)}</span>
        <span class="mag-cover-edition">${meta?.period === "month" ? "MONTHLY EDITION" : "WEEKLY EDITION"}</span>
      </header>
      <div class="mag-cover-mast">The Zhihu Review</div>
      <p class="mag-cover-sub">ZHIHU LEARNING DESK · ENGLISH EDITION · YOUR ${MAG_PERIOD_NOUN(meta).toUpperCase()}, IN PLAIN ENGLISH</p>
      <figure class="mag-cover-figure"><img src="${issueCoverImage(meta, list)}" alt="Issue cover illustration in cobalt blue and white"></figure>
      <ul class="mag-cover-lines">${lines || "<li class='mag-cover-line'><span class='mag-cover-line-title'>This issue is being prepared…</span></li>"}</ul>
      <footer class="mag-cover-foot">
        <span>${list.length} ${list.length > 1 ? "STORIES" : "STORY"} · ${words.size} TARGET WORDS</span>
        <span class="mag-cover-cta">OPEN THE ISSUE →</span>
      </footer>
    </div>`;
}

/* Contents：每行可点击跳页，页码由分页结果回填 */
function magTocHtml(articles, meta) {
  const list = (articles || []).filter(Boolean);
  const rows = list.map((a, i) => {
    const words = articleWords(a);
    const tier = words <= 300 ? "brief" : "feature";
    return `
    <li class="mag-toc-row" data-goto-page="toc" data-mag-article="${i}">
      <span class="mag-toc-no">${String(i + 1).padStart(2, "0")}</span>
      <div class="mag-toc-main">
        <h3>${esc(a.story?.title || a.title || "")}</h3>
        <p>${esc(articleDek(a))} — By the Zhihu Freelance Desk</p>
      </div>
      <div class="mag-toc-meta">
        <span class="mag-chip mag-chip-${tier}">${tier === "brief" ? "BRIEF" : "FEATURE"}</span>
        <span>${words} W</span>
        <span class="mag-toc-page" data-mag-ref="${i}">—</span>
      </div>
    </li>`;
  }).join("");
  return `
    <div class="mag-toc">
      <header class="mag-toc-head">
        <p class="mag-kicker">IN THIS ISSUE · ${esc(issueLabel(meta, list))}</p>
        <h2 class="mag-toc-title">Contents</h2>
        <div class="mag-toc-legend">
          <span class="mag-chip mag-chip-brief">BRIEF · 2 COLUMNS · ≤300 WORDS</span>
          <span class="mag-chip mag-chip-feature">FEATURE · 3 COLUMNS · 301+ WORDS</span>
        </div>
      </header>
      <ol class="mag-toc-list">${rows}</ol>
      <footer class="mag-toc-foot"><span>THE ZHIHU REVIEW</span><span>EDITED IN A SMALL ROOM WITH GOOD LIGHT</span></footer>
    </div>`;
}

/* 文章首版：档位规格章 + 题头 + 生成题图（仅 FEATURE）+ 导语引言 + 版心 */
function magArticleFirstInner(article, articleIdx, articleCount, meta) {
  const story = article?.story || {};
  const words = articleWords(article);
  const tier = words <= 300 ? "brief" : "feature";
  const genre = esc(genreLabelEn(article?.genre));
  const title = esc(story.title || article?.title || "Zhihu English Daily");
  const pull = articlePull(article);
  const hero = tier === "feature" ? `<figure class="mag-hero"><img src="${articleHero(article)}" alt="${esc(story.title || "")} illustration"></figure>` : "";
  const pullHtml = tier === "feature" && pull ? `<aside class="mag-pull">${esc(pull)}</aside>` : "";
  return `
    <section class="mag-article mag-tier-${tier}" lang="en">
      <header class="mag-head">
        <span class="mag-spec mag-spec-${tier}">${tier === "brief" ? "BRIEF · TWO COLUMNS" : "FEATURE SPREAD · THREE COLUMNS"} — ${words} WORDS</span>
        <p class="mag-kicker">${genre} · ZHIHU REPORT${articleCount > 1 ? ` · STORY ${articleIdx + 1}/${articleCount}` : ""}</p>
        <h1 class="mag-title">${title}</h1>
        <p class="mag-dek">${esc(articleDek(article))}</p>
        <p class="mag-byline">By the Zhihu Freelance Desk · ${articleMinutes(words)} MIN READ</p>
        ${pullHtml}
      </header>
      <div class="mag-en">${paperParagraphs(story.en)}</div>
    </section>`;
}

function magArticleContInner(article, tier, genreHtml) {
  return `
    <section class="mag-article mag-tier-${tier}" lang="en">
      <header class="mag-runhead"><span>${genreHtml} · CONTINUED</span><span>THE ZHIHU REVIEW</span></header>
      <div class="mag-en"></div>
    </section>`;
}

/* 首版占位页（挂载后被 paginateMagazine 按实际高度重排） */
function magArticleFirstPage(article, articleIdx, articleCount, meta) {
  return bookPage(
    magArticleFirstInner(article, articleIdx, articleCount, meta),
    `ISSUE ${esc(issueLabel(meta, [article]))}`,
    ` data-mag-idx="${articleIdx}"`
  );
}

/* ------------------------------------------------------------------
   出口 1：整刊初始页面（封面 + Contents + 每篇首版占位）
------------------------------------------------------------------ */

export function issueMagazinePages(articles, meta = {}) {
  const list = (articles || []).filter(Boolean);
  const pages = [bookPage(magCoverHtml(list, meta), null)];
  pages.push(bookPage(magTocHtml(list, meta), `ISSUE ${esc(issueLabel(meta, list))}`));
  list.forEach((article, i) => pages.push(magArticleFirstPage(article, i, list.length, meta)));
  return pages;
}

/* ------------------------------------------------------------------
   出口 2：整刊分页（蓝白杂志版）
   每篇文章占位页（data-mag-idx）按真实高度切成 1..N 版：
   首版 = 完整题头 + 题图；续版 = 紧凑报眉 + 通栏版心。分页后回填目录页码。
------------------------------------------------------------------ */

function measureMagRunhead(width) {
  const probe = document.createElement("div");
  probe.className = "page-face";
  probe.style.cssText = `position: fixed; left: -9999px; top: 0; visibility: hidden; width: ${width}px;`;
  probe.innerHTML = '<section class="mag-article mag-tier-feature"><header class="mag-runhead"><span>GENRE · CONTINUED</span><span>THE ZHIHU REVIEW</span></header></section>';
  document.body.appendChild(probe);
  const head = probe.querySelector(".mag-runhead");
  const h = head ? head.offsetHeight + (parseFloat(getComputedStyle(head).marginBottom) || 0) : 0;
  probe.remove();
  return h;
}

export function paginateMagazine(articles, meta = {}) {
  const list = (articles || []).filter(Boolean);
  const refs = [];

  list.forEach((article, articleIdx) => {
    const origPage = document.querySelector(`#newspaper-body .book-page[data-mag-idx="${articleIdx}"]`);
    if (!origPage) return;
    const face = origPage.querySelector(".page-face-front");
    const pageEl = face ? face.querySelector(".mag-article") : null;
    const en = pageEl ? pageEl.querySelector(".mag-en") : null;
    const ps = en ? Array.from(en.querySelectorAll("p")) : [];
    if (!pageEl || !en || !ps.length) return;

    const story = article?.story || {};
    const words = articleWords(article);
    const tier = words <= 300 ? "brief" : "feature";
    const cols = tier === "brief" ? 2 : 3;
    const genre = esc(genreLabelEn(article?.genre));
    const label = esc(issueLabel(meta, [article]));

    const allPages = Array.from(document.querySelectorAll("#newspaper-body .book-page"));
    const pageOffset = Math.max(1, allPages.indexOf(origPage));
    refs[articleIdx] = pageOffset;

    const cs = getComputedStyle(pageEl);
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const folio = face.querySelector(".paper-folio");
    const folioH = folio ? folio.offsetHeight : 0;
    const chromeFull = en.offsetTop - pageEl.offsetTop;
    const runheadH = measureMagRunhead(face.clientWidth);
    const availPage0 = Math.max(1, Math.floor(face.clientHeight - folioH - chromeFull - padBottom - 30));
    const availCont = Math.max(1, Math.floor(face.clientHeight - folioH - runheadH - padBottom - 30));

    /* 词组切片（同 pagination.js）：页边界只发生在词间，栏内段落重新合并 */
    const paragraphChunks = (p, size = 8) => {
      const tokens = [];
      p.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          tokens.push(...String(node.textContent || "").trim().split(/\s+/).filter(Boolean).map(esc));
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          tokens.push(node.outerHTML);
        }
      });
      if (!tokens.length) return [p.innerHTML];
      const chunks = [];
      for (let i = 0; i < tokens.length; i += size) chunks.push(tokens.slice(i, i + size).join(" "));
      return chunks;
    };
    const frags = [];
    ps.forEach((p, pid) => {
      paragraphChunks(p).forEach((part, si) => frags.push({ pid, cont: si > 0, html: part }));
    });

    const colGap = parseFloat(getComputedStyle(en).columnGap) || 26;
    const colW = Math.max(60, (en.clientWidth - colGap * (cols - 1)) / cols);
    const probe = document.createElement("div");
    probe.className = `mag-en mag-tier-${tier} pagination-probe`;
    probe.lang = "en";
    probe.style.width = colW + "px";
    document.body.appendChild(probe);
    const capPage0 = Math.max(1, availPage0 * cols - 14 * cols);
    const capCont = Math.max(1, availCont * cols - 14 * cols);

    const groupBody = (group) => {
      let body = "";
      let j = 0;
      while (j < group.length) {
        const f = frags[group[j]];
        let para = f.html;
        let k = j + 1;
        while (k < group.length && frags[group[k]].pid === f.pid) {
          para += " " + frags[group[k]].html;
          k++;
        }
        body += `<p${f.cont ? ' style="text-indent:0"' : ""}>${para}</p>`;
        j = k;
      }
      return body;
    };

    const slotUsed = (slot, isFirst = false) => {
      probe.classList.toggle("is-cont", !isFirst);
      probe.innerHTML = groupBody(slot);
      return probe.scrollHeight;
    };

    const slots = [];
    let cur = [];
    for (let i = 0; i < frags.length; i++) {
      const budget = slots.length === 0 ? capPage0 : capCont;
      if (cur.length && slotUsed(cur.concat(i), slots.length === 0) > budget) {
        slots.push(cur);
        cur = [i];
      } else {
        cur.push(i);
      }
    }
    if (cur.length) slots.push(cur);
    probe.remove();

    const sourceNote = esc(story.source_note || "来源：Bookwords 本地存档（历史文章未记录来源）");
    const title = esc(story.title || article?.title || "Zhihu English Daily");

    const holder = document.createElement("div");
    let html = "";
    slots.forEach((group, gi) => {
      const body = groupBody(group);
      const isFirst = gi === 0;
      const pageNumber = pageOffset + gi;
      const isLast = gi === slots.length - 1;
      const inner = isFirst
        ? magArticleFirstInner(article, articleIdx, list.length, meta)
        : magArticleContInner(article, tier, genre);
      /* 续版 / 末版把正文灌进版心（首版正文已在占位页内） */
      const finalInner = isFirst
        ? inner
        : inner.replace('<div class="mag-en"></div>', `<div class="mag-en is-cont">${body}</div>`);
      const attribution = isLast ? `<p class="mag-source">${sourceNote}</p>` : "";
      const articleHtml = isLast
        ? finalInner.replace("</section>", `${attribution}</section>`)
        : finalInner;
      html += `
    <section class="book-page" data-mag-idx="${articleIdx}">
      <div class="page-face page-face-front">${articleHtml}
        <div class="paper-folio"><span>THE ZHIHU REVIEW · ${label}</span><span>PAGE ${pageNumber}</span></div>
      </div>
      <div class="page-face page-face-back"><span class="page-back-stamp">THE ZHIHU REVIEW · ZHIHU LEARNING DESK</span></div>
    </section>`;
    });
    holder.innerHTML = html;
    origPage.replaceWith(...Array.from(holder.childNodes));
  });

  /* 目录页码回填：封面头条 + Contents 行 → 文章首版的物理页码 */
  document.querySelectorAll("#newspaper-body [data-mag-ref]").forEach((node) => {
    const idx = parseInt(node.dataset.magRef, 10);
    if (Number.isFinite(idx) && refs[idx] != null) {
      node.textContent = `P. ${String(refs[idx]).padStart(2, "0")}`;
      const row = node.closest("[data-goto-page]");
      if (row) row.dataset.gotoPage = String(refs[idx]);
    }
  });
}
