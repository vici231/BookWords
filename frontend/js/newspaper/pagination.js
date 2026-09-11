/* newspaper/pagination.js — 头版正文分页：
   按版心高度把英文段落拆到多版（首版完整报头 / 续版紧凑报眉）。
   字号不缩、页内无滑条、每版整页完整显示。算法经过多轮实测调优，勿轻改。 */

import { esc } from "../utils.js";
import { dailyWeekInfo, genreLabelEn } from "../articles.js";

/* 续版紧凑报眉高度：用离屏探针在真实 .page-face 上下文中测量（含下边距）。 */
export function measureRunhead(pageEl) {
  const probe = document.createElement("div");
  probe.className = "page-face";
  probe.style.cssText = "position: fixed; left: -9999px; top: 0; visibility: hidden; width: " + pageEl.clientWidth + "px;";
  probe.innerHTML = '<section class="newspaper-page"><header class="newspaper-runhead"><span>ZHIHU ENGLISH DAILY</span><span>CONT. · FRONT PAGE</span></header></section>';
  document.body.appendChild(probe);
  const head = probe.querySelector(".newspaper-runhead");
  const h = head ? head.offsetHeight + (parseFloat(getComputedStyle(head).marginBottom) || 0) : 0;
  probe.remove();
  return h;
}

/* 整刊分页：每篇文章的头版（data-article-idx）各自执行分页。
   传单篇 = 单文章模式（等价 [article]）。 */
export function paginateFrontPages(articles) {
  const list = Array.isArray(articles) ? articles : [articles];
  list.forEach((article, i) => paginateArticle(article, i, list.length));
}

function paginateArticle(article, articleIdx, articleCount) {
  const candidates = Array.from(document.querySelectorAll(`#newspaper-body .book-page[data-article-idx="${articleIdx}"]`));
  const origPage = candidates.find((p) => p.querySelector(".newspaper-page"));
  if (!origPage) return;
  const face = origPage.querySelector(".page-face-front");
  const pageEl = face ? face.querySelector(".newspaper-page") : null;
  const en = pageEl ? pageEl.querySelector(".newspaper-en") : null;
  if (!pageEl || !en) return;
  const ps = Array.from(en.querySelectorAll("p"));
  if (!ps.length) return;

  /* 封面不计页码；正文从 1 开始，后续文章沿用整刊物理顺序，不再每篇重置。 */
  const allPages = Array.from(document.querySelectorAll("#newspaper-body .book-page"));
  const pageOffset = Math.max(1, allPages.indexOf(origPage));

  const cs = getComputedStyle(pageEl);
  const padBottom = parseFloat(cs.paddingBottom) || 0;
  const folio = face.querySelector(".paper-folio");
  const folioH = folio ? folio.offsetHeight : 0;
  const chromeFull = en.offsetTop - pageEl.offsetTop; // 首版完整报头 + 标题等高度
  const runheadH = measureRunhead(pageEl);            // 续版紧凑报眉高度
  /* 仅保留一层统一 folio，删除重复期刊页脚与统计框后，把版心完整交给正文。 */
  const availPage0 = Math.max(1, Math.floor(face.clientHeight - folioH - chromeFull - padBottom - 30));
  const availCont = Math.max(1, Math.floor(face.clientHeight - folioH - runheadH - padBottom - 30));

  /* 正文按小段词组切片，而不是把自然段或整句当作不可拆单元。浏览器在单页内仍会
     把同段切片重新合并为一个 <p>；只有跨栏页边界时才从词间续排。这样每一栏都能
     用到最后一行，不会因为下一句话较长就把它整体推到下一页。 */
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
    const parts = paragraphChunks(p);
    parts.forEach((part, si) => frags.push({ pid, cont: si > 0, html: part }));
  });

  /* 片段高度在真实栏宽 (版心-栏距)/2 的离屏探针里测量；探针首段同样触发首字下沉，
     与头版渲染一致。每版容量 = 两个栏高（留约一行安全量防末行被裁）。 */
  const colGap = parseFloat(getComputedStyle(en).columnGap) || 30;
  const colW = Math.max(60, (en.clientWidth - colGap) / 2);
  const probe = document.createElement("div");
  probe.className = "newspaper-en pagination-probe";
  probe.lang = "en";
  probe.style.width = colW + "px";
  document.body.appendChild(probe);
  const capPage0 = Math.max(1, availPage0 * 2 - 28);  // 首版两栏容量
  const capCont = Math.max(1, availCont * 2 - 28);    // 续版两栏容量

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

  /* 在真实栏宽下测量合并后的段落。旧算法把每句话分别量高再相加，会把每句话末尾
     的半行也算成整行，导致容量被严重低估。 */
  const slotUsed = (slot, isFirst = false) => {
    probe.classList.toggle("is-cont", !isFirst);
    probe.innerHTML = groupBody(slot);
    return probe.scrollHeight;
  };

  /* 从头版起顺序贪心装版：头版按 capPage0、续版按 capCont 喂满，
     余量自然落在末版（边栏同在末版，末版略疏不突兀，中间版永远饱满）。 */
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
  if (slots.length === 1) {
    /* 短文一版放下：直接切成双栏，无需重建页面。 */
    en.classList.add("is-double");
    const folioText = folio?.querySelectorAll("span");
    if (folioText?.length >= 2) {
      folioText[0].textContent = `ISSUE ${article?.weekLabel || dailyWeekInfo(article?.generatedAt).label}`;
      folioText[1].textContent = `PAGE ${pageOffset}${articleCount > 1 ? ` · STORY ${articleIdx + 1}/${articleCount}` : ""}`;
    }
    probe.remove();
    return;
  }
  probe.remove();

  const story = article?.story || {};
  const sourceNote = esc(story.source_note || "来源：Bookwords 本地存档（历史文章未记录来源）");
  const targets = Array.isArray(article?.targetWords) ? article.targetWords.filter(Boolean) : [];
  const weekLabel = esc(article?.weekLabel || dailyWeekInfo(article?.generatedAt).label);
 const genreHtml = esc(genreLabelEn(article?.genre));
 const title = esc(story.title || article?.title || "Zhihu English Daily");

  const holder = document.createElement("div");
  let html = "";
  slots.forEach((group, gi) => {
    /* 同段相邻句片合并回一个 <p>（段间距只出现在自然段之间）；跨页续段不缩进。 */
    const body = groupBody(group);
    const isFirst = gi === 0;
    const pageNumber = pageOffset + gi;
    const gloss = isFirst
      ? `
      <div class="paper-gloss" data-gloss="words" hidden>
        <div class="paper-gloss-card">
          <p class="newspaper-kicker">THIS ISSUE · KEY WORDS</p>
          <div class="paper-gloss-words">${targets.length ? targets.map((word) => `<span>${esc(word)}</span>`).join("") : "<small>No target words</small>"}</div>
        </div>
      </div>`
      : "";
    const headHtml = isFirst
      ? `<header class="newspaper-masthead">
          <div class="newspaper-masthead-top"><span>ZHIHU ENGLISH DAILY</span><span>${weekLabel} · ${genreHtml}</span></div>
          <div class="newspaper-nameplate">ZHIHU ENGLISH DAILY</div>
         <div class="newspaper-dateline">LEARNING EDITION · ${genreHtml} · ZHIHU LEARNING DESK</div>
        </header>`
      : `<header class="newspaper-runhead"><span>${genreHtml} · CONTINUED</span></header>`;
    const attribution = gi === slots.length - 1 ? `<p class="newspaper-source-note">${sourceNote}</p>` : "";
    const leadHtml = isFirst
      ? `<section class="newspaper-lead">
          <p class="newspaper-kicker">${genreHtml} · Zhihu REPORT</p>
          <h1>${title}</h1>
          <p class="newspaper-byline">By the Zhihu Freelance Desk</p>
          <div class="newspaper-rule"></div>
          <div class="newspaper-en is-double" lang="en">${body}</div>${attribution}
        </section>`
      : `<section class="newspaper-lead">
          <div class="newspaper-en is-cont is-double" lang="en">${body}</div>${attribution}
        </section>`;
    html += `
    <section class="book-page" data-article-idx="${articleIdx}">
      <div class="page-face page-face-front">
        <section class="newspaper-page">
          ${headHtml}
          <div class="newspaper-grid">
            ${leadHtml}
          </div>
        </section>
        <div class="paper-folio"><span>ISSUE ${weekLabel}</span><span>PAGE ${pageNumber}${articleCount > 1 ? ` · STORY ${articleIdx + 1}/${articleCount}` : ""}</span></div>
        ${gloss}
      </div>
      <div class="page-face page-face-back"><span class="page-back-stamp">ZHIHU ENGLISH DAILY · ZHIHU LEARNING DESK</span></div>
    </section>`;
  });
  holder.innerHTML = html;
  origPage.replaceWith(...Array.from(holder.childNodes));
}
