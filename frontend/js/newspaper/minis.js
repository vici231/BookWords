/* newspaper/minis.js — 存档墙迷你报纸：
   按 980px 基准排版真实 newspaperMarkup，再整体 transform scale 缩到卡片宽度。
   单一共享 ResizeObserver（旧版每个容器一套观察器，DOM 翻倍）。 */

const MINI_PAGE_WIDTH = 980;
let miniObserver = null;

export function fitArticleMini(mini) {
  const viewport = mini?.querySelector(".article-mini-viewport");
  const page = mini?.querySelector(".article-mini-page");
  if (!viewport || !page) return;
  const scale = (viewport.clientWidth || 1) / MINI_PAGE_WIDTH;
  page.style.transform = `scale(${scale})`;
  viewport.style.height = `${Math.round(page.offsetHeight * scale)}px`;
}

export function setupArticleMinis(root) {
  const minis = Array.from(root.querySelectorAll(".article-mini"));
  minis.forEach(fitArticleMini);
  if (!minis.length) return;
  if (typeof ResizeObserver === "function") {
    if (!miniObserver) {
      miniObserver = new ResizeObserver((entries) => {
        entries.forEach((entry) => fitArticleMini(entry.target));
      });
    }
    minis.forEach((mini) => miniObserver.observe(mini));
  } else {
    window.addEventListener("resize", () => minis.forEach(fitArticleMini));
  }
}
