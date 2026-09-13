/* router.js — 视图切换：侧边栏 is-active / 顶栏 active 双高亮 + 按需渲染。
   视图渲染器由 main.js 注册（registerView），本模块不 import 任何视图，保持无环依赖。 */

import { $ } from "./utils.js";

const viewRenderers = new Map();

export function registerView(viewId, render) {
  viewRenderers.set(viewId, render);
}

export function showView(viewId) {
  document.body.classList.toggle("is-home", viewId === "home-view");
  document.querySelectorAll(".view").forEach((view) => {
    const active = view.id === viewId;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  document.querySelectorAll(".nav-item, .sidebar-item, .mobile-tabbar button").forEach((nav) => {
    const isActive = nav.dataset.view === viewId;
    nav.classList.toggle("active", isActive);
    nav.classList.toggle("is-active", isActive);
  });
  requestAnimationFrame(updateNavIndicator);
  /* 视图激活后再渲染（隐藏容器测量为 0，先渲染会算错迷你报缩放） */
  viewRenderers.get(viewId)?.();
  if (viewId === "story-pool-view") {
    /* 行滑入动画只在进入界面时播放一次，池内增删不再重播 */
    const section = $("#story-pool-view");
    section.classList.remove("anim-once");
    void section.offsetWidth;
    section.classList.add("anim-once");
    clearTimeout(showView._poolAnimT);
    showView._poolAnimT = setTimeout(() => section.classList.remove("anim-once"), 900);
  }
  $(".app-shell")?.scrollTo({ top: 0, behavior: "smooth" });
}

export function updateNavIndicator() {
  const nav = document.querySelector(".main-nav");
  const active = nav?.querySelector(".nav-item.active");
  if (!nav || !active) return;
  const navRect = nav.getBoundingClientRect();
  const itemRect = active.getBoundingClientRect();
  nav.style.setProperty("--nav-left", `${itemRect.left - navRect.left}px`);
  nav.style.setProperty("--nav-width", `${itemRect.width}px`);
}

export function bindNavigation() {
  document.querySelectorAll("[data-view]").forEach((item) => {
    /* 首页内的导航（磁贴 / 叠层卡 / 步骤卡 / CTA）由 home.js 的「纸张扫过」
       转场统一接管：这里若直接绑定，视图会瞬间切走、扫幕动画失效。 */
    if (item.closest("#home-view")) return;
    item.addEventListener("click", () => showView(item.dataset.view));
  });
  updateNavIndicator();
  window.addEventListener("resize", updateNavIndicator);
}
