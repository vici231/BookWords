/* newspaper/export.js — 导出：PDF（打印样式 body.print-newspaper）/ Word（.doc Blob）
   日报 = 一周文章整合：导出本周所有文章（Word 拼接 / PDF 打开整刊后打印）。 */

import { toast } from "../utils.js";
import { activeArticle, dailyWeekInfo, currentWeekArticles } from "../articles.js";
import { newspaperMarkup } from "./markup.js";
import { openNewspaper, openIssue } from "./reader.js";

/* 导出目标：优先当前打开的刊物（阅读器内按钮传入）；否则本周整刊；最后退回当前刊物 */
function exportTarget(articles) {
  const cur = (Array.isArray(articles) ? articles : []).filter(Boolean);
  if (cur.length) return cur;
  const week = currentWeekArticles();
  if (week.length) return week;
  const active = activeArticle();
  return active ? [active] : [];
}

export function downloadWordArticle(articles) {
  const target = exportTarget(articles);
  if (!target.length) {
    toast("还没有可以导出的日报");
    return;
  }
  const first = target[0];
  const issueName = target.length > 1
    ? `Zhihu-English-Daily-${(first.weekLabel || first.generatedAt || "").replace(/[\\/:*?"<>|.\s]/g, "-")}`
    : String(first.title || first.story?.title || "Zhihu-English-Daily").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Georgia,'Times New Roman',serif;color:#211c18;line-height:1.8}h1{font-family:'Playfair Display',Georgia,serif;font-size:30px;border-bottom:2px solid #211c18;padding-bottom:12px}.newspaper-masthead{text-align:center}.newspaper-nameplate{font-family:'Playfair Display',Georgia,serif;font-size:26px;font-weight:700;letter-spacing:3px}.newspaper-dateline,.newspaper-byline,.newspaper-kicker,.newspaper-status,.newspaper-footer{font-family:Arial,sans-serif;color:#806f61;font-size:11px}.newspaper-en{font-size:15px;font-family:Georgia,'Times New Roman',serif}.newspaper-translation{border-top:1px solid #b9aa98;margin-top:24px;padding-top:18px}.newspaper-translation>div{font-family:'Microsoft YaHei',sans-serif}.newspaper-box{border:1px solid #b9aa98;padding:12px;margin-top:12px}.newspaper-word-list span{display:inline-block;margin:3px 8px 3px 0}.newspaper-footer{border-top:1px solid #211c18;margin-top:24px;padding-top:10px;display:flex;justify-content:space-between}.issue-sep{page-break-before:always}</style></head><body>${target.map((a) => newspaperMarkup(a)).join("\n")}</body></html>`;
  /* Word 打开 .doc：Blob 前缀必须是真实 BOM 字符（"\ufeff" 转义即真实字符），否则中文乱码 */
  const blob = new Blob(["\ufeff", html], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${issueName}.doc`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* 打印整刊：传入当前打开的文章时直接打印（阅读器已显示该内容）；
   否则打开本周整合版（封面目录 + 每篇头版）后打印。 */
export function printNewspaper(articles) {
  const target = exportTarget(articles);
  if (!target.length) {
    toast("还没有可以导出的日报");
    return;
  }
  const cur = (Array.isArray(articles) ? articles : []).filter(Boolean);
  if (!cur.length) {
    if (target.length > 1) openIssue(target[0].weekKey || dailyWeekInfo(target[0].generatedAt).key);
    else openNewspaper(target[0].id);
  }
  const cleanup = () => document.body.classList.remove("print-newspaper");
  document.body.classList.add("print-newspaper");
  window.addEventListener("afterprint", cleanup, { once: true });
  window.print();
  setTimeout(cleanup, 2500);
}
