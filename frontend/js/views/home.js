/* home.js — 首页 hero v4：翻书硬切帧。
   交互约定（2026-09-13 用户确认）：书本本身保持静止——
   无定格抖动、无鼠标视差；「往左拖 = 翻开」；松手吸附最近帧；
   翻到全开 → 短暂停留后进入今日学习（story-pool-view）。
   动效原则参考 emil-design-eng：仅 transform/opacity、
   自定义 ease-out、交互可中断（弹簧）。 */

import { showView } from "../router.js";
import { state } from "../state.js";

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/* —— 本周学习进度：按真实数据加权计算 ——
   本周（周一 00:00 起）：学词 15 个 ×50% + 生成文章 3 篇 ×30% + 打卡 5 天 ×20%。 */
const WEEK_GOALS = { words: 15, articles: 3, checkins: 5 };

function weekStart() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; /* 周一 = 0 */
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function inWeek(iso, from) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t >= from;
}

export function renderHomeProgress() {
  const box = document.querySelector(".highlight-progress");
  if (!box) return;
  const from = weekStart().getTime();
  const words = state.wordbook.filter((w) => inWeek(w.savedAt, from)).length;
  const articles = state.articles.filter((a) => inWeek(a.savedAt || a.createdAt || a.generatedAt, from)).length;
  const checkins = state.dailyRecords.filter((r) => inWeek(r.checkedAt, from)).length;
  const score =
    0.5 * Math.min(1, words / WEEK_GOALS.words) +
    0.3 * Math.min(1, articles / WEEK_GOALS.articles) +
    0.2 * Math.min(1, checkins / WEEK_GOALS.checkins);
  const pct = Math.round(score * 100);
  const num = box.querySelector("strong");
  const bar = box.querySelector("i");
  if (num) num.textContent = pct + "%";
  if (bar) bar.style.width = pct + "%";
}

/* —— 全站按钮点击回弹：委托监听，pop 动画结束自动摘除，可重复触发 —— */
export function bindButtonPop() {
  if (document.documentElement.dataset.popBound) return;
  document.documentElement.dataset.popBound = "1";
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".btn-primary, #btn-generate, .btn-ghost");
    if (!btn || btn.disabled) return;
    btn.classList.remove("is-pop");
    void btn.offsetWidth; /* 强制重排以重启动画 */
    btn.classList.add("is-pop");
    /* 定长摘除：点击切换视图会让按钮 display:none，
       animationend/cancel 事件均不可靠，setTimeout 最稳 */
    setTimeout(() => btn.classList.remove("is-pop"), 380);
  });
}

export function bindHomeHero() {
  const hero = document.querySelector(".home-hero-v4");
  if (!hero || hero.dataset.bound) return;
  hero.dataset.bound = "1";

  const book = hero.querySelector("#home-flipbook");
  const frames = book ? [...book.querySelectorAll("img")] : [];
  const hint = hero.querySelector(".home-book-hint");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* —— 翻书：往左拖打开；拖拽映射 [0, 1]（dx<0 → 进度增加） —— */
  const DRAG_RANGE = 300;  /* 拖满一整趟的像素距离 */
  const FLING_MS = 260;    /* 轻扫判定：更快、更短的一划也应翻页 */
  const FLING_PX = 48;
  let target = 0, pos = 0, vel = 0;
  let dragging = false, startX = 0, startPos = 0, startAt = 0, moved = false;
  /* 翻到全开后短暂停留进入今日学习；期间按住书本或翻回封面则取消 */
  let openTimer = 0;
  const CUE = hero.querySelector(".home-actions");

  function cueOpen(on) { if (CUE) CUE.classList.toggle("is-book-open", on); }

  if (book) {
    book.addEventListener("pointerdown", (e) => {
      clearTimeout(openTimer); cueOpen(false);
      dragging = true; moved = false;
      startX = e.clientX; startPos = target; startAt = performance.now();
      try { book.setPointerCapture?.(e.pointerId); } catch { /* 合成指针无 active pointer，忽略 */ }
    });
    book.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 4) moved = true;
      /* 往左拖（dx < 0）→ 进度增加 → 翻开 */
      target = clamp(startPos - dx / DRAG_RANGE, 0, 1);
    });
    ["pointerup", "pointercancel"].forEach((t) => book.addEventListener(t, (e) => {
      if (!dragging) return;
      dragging = false;
      /* 距离过半翻页；快速轻扫（短时间 + 明确方向）也翻页 */
      const dx = e.clientX - startX;
      const quick = performance.now() - startAt < FLING_MS && Math.abs(dx) > FLING_PX;
      target = clamp(Math.round(target + (quick ? -Math.sign(dx) * 0.5 : 0)), 0, 1);
      if (hint && moved) hint.classList.add("is-done");
      /* 全开 = 翻开这本书 → 进入今日学习 */
      clearTimeout(openTimer); cueOpen(false);
      if (target === 1) {
        cueOpen(true);
        openTimer = setTimeout(() => { cueOpen(false); showView("story-pool-view"); }, 620);
      }
    }));
  }

  /* —— 悬浮装饰：指针视差跟随（鼠标/触控 pointermove，lerp 平滑） —— */
  const floats = [...hero.querySelectorAll(".home-float")].map((el) => ({
    el,
    gain: parseFloat(el.dataset.gain) || 12,
    mx: 0, my: 0, tx: 0, ty: 0,
  }));
  if (floats.length && !reduced) {
    window.addEventListener("pointermove", (e) => {
      const nx = (e.clientX / innerWidth) * 2 - 1;   /* -1 .. 1 */
      const ny = (e.clientY / innerHeight) * 2 - 1;
      floats.forEach((f) => { f.tx = nx * f.gain; f.ty = ny * f.gain * 0.7; });
    }, { passive: true });
    /* 指针离开窗口：缓慢回中 */
    document.addEventListener("pointerleave", () => {
      floats.forEach((f) => { f.tx = 0; f.ty = 0; });
    });
  }

  /* —— 渲染循环：仅在需要时写样式，静止零开销 —— */
  let last = 0, lastIdx = -1, settled = true;

  /* 离开首页时把书重置回封面，返回首页看到的是合上的书 */
  const homeView = document.getElementById("home-view");
  if (homeView) {
    let wasActive = true;
    new MutationObserver(() => {
      const active = homeView.classList.contains("active");
      /* 重新进入首页：退出彩蛋态，回到原版主页 */
      if (active && !wasActive) homeView.classList.remove("is-egg");
      wasActive = active;
      if (!active) {
        clearTimeout(openTimer); cueOpen(false);
        target = 0; pos = 0; vel = 0; settled = true; dragging = false;
        if (lastIdx !== 0) {
          lastIdx = 0;
          frames.forEach((f, i) => f.classList.toggle("is-on", i === 0));
        }
      }
    }).observe(homeView, { attributes: true, attributeFilter: ["class"] });
  }

  function tick(now) {
    if (!last) last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (hero.offsetParent) { /* 视图隐藏时跳过 */
      /* 装饰视差：lerp 逼近目标，写 CSS 变量（与 CSS 浮动动画叠加） */
      for (const f of floats) {
        if (Math.abs(f.tx - f.mx) > 0.05 || Math.abs(f.ty - f.my) > 0.05) {
          f.mx += (f.tx - f.mx) * 0.06;
          f.my += (f.ty - f.my) * 0.06;
          f.el.style.setProperty("--mx", f.mx.toFixed(2) + "px");
          f.el.style.setProperty("--my", f.my.toFixed(2) + "px");
        }
      }
      const needsStep = !settled || dragging || Math.abs(target - pos) > 0.0004 || Math.abs(vel) > 0.0004;
      if (needsStep) {
        /* 弹簧：轻微过冲，像把书拨过去 */
        const k = 130, c = 13;
        vel += (k * (target - pos) - c * vel) * dt;
        pos += vel * dt;
        if (!dragging && Math.abs(target - pos) < 0.0004 && Math.abs(vel) < 0.0004) {
          pos = target; vel = 0; settled = true;
        } else {
          settled = false;
        }

        /* 硬切帧：round() 直接跳帧，无交叉淡化 */
        const idx = clamp(Math.round(pos * (frames.length - 1)), 0, frames.length - 1);
        if (idx !== lastIdx) {
          lastIdx = idx;
          frames.forEach((f, i) => f.classList.toggle("is-on", i === idx));
        }
      }
    }
    requestAnimationFrame(tick);
  }
  if (!reduced || frames.length) requestAnimationFrame(tick);
}

/* —— 桌面端粘性叠层导航：点击卡片 → 「纸张扫过」遮罩 → 进入目标视图 ——
   机制参考 motion-web press-stack 的 sticky 叠层（CSS 完成滚动叠盖），
   这里只负责点击进入：遮罩从底部扫上来盖住屏幕，中点切换视图并回顶。 */
export function bindDeskStack() {
  const stack = document.querySelector(".desk-stack");
  if (!stack || stack.dataset.bound) return;
  stack.dataset.bound = "1";

  /* 遮罩元素只建一次 */
  let veil = document.querySelector(".stack-veil");
  if (!veil) {
    veil = document.createElement("div");
    veil.className = "stack-veil";
    veil.setAttribute("aria-hidden", "true");
    veil.innerHTML = '<span class="veil-mark">BOOKWORDS</span>';
    document.body.appendChild(veil);
  }

  let sweeping = false;
  const zone = document.querySelector(".home-view");
  zone.addEventListener("click", (e) => {
    /* .scatter-brand 不在此列：单击不做任何事，双击（brandEggClick）专管彩蛋转场 */
    const card = e.target.closest(".stack-card, .scatter-tile, .view-link");
    if (!card || sweeping) return;

    /* 设置卡：不切视图，直接打开设置弹窗 */
    if (card.dataset.action === "settings") {
      document.getElementById("btn-settings")?.click();
      return;
    }
    const view = card.dataset.view;
    if (!view) return;

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { showView(view); scrollToTop(); return; }

    sweeping = true;
    veil.classList.remove("is-sweeping");
    void veil.offsetWidth; /* 重启扫过动画 */
    veil.classList.add("is-sweeping");
    /* 遮罩盖住屏幕（约 260ms 处）时切换视图并回到顶部 */
    setTimeout(() => { showView(view); scrollToTop(); }, 270);
    /* 动画定长摘除（切视图后 animationend 不可靠，同 bindButtonPop 约定） */
    setTimeout(() => { veil.classList.remove("is-sweeping"); sweeping = false; }, 640);
  });

  function scrollToTop() {
    const shell = document.querySelector(".app-shell");
    if (shell && shell.scrollHeight > shell.clientHeight) shell.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }

  /* —— 进站「纸张揭幕」：桌面端 veil 先盖住，页面加载完成后向上扫开 —— */
  if (matchMedia("(min-width: 981px)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    veil.classList.add("is-boot");
    const open = () => {
      veil.classList.remove("is-boot");
      veil.classList.add("is-booting");
      setTimeout(() => veil.classList.remove("is-booting"), 850);
    };
    if (document.readyState === "complete") setTimeout(open, 400);
    else window.addEventListener("load", () => setTimeout(open, 400), { once: true });
  }

  /* —— 手机端叠层滚动编排（照抄 press-stack）：滚动驱动各屏文案 RISE 上浮、
     manifesto 逐词点亮与顶部进度条；桌面端叠层 display:none，paint 自动跳过 —— */
  const secs = [...stack.querySelectorAll(".sec")];
  const mani = document.getElementById("stack-mani");
  if (secs.length && mani) {
    const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* manifesto 拆词（照抄 LINES/ITAL/WORDS）：手写体词上色，key 决定点亮次序 */
    const LINES = [["把生词，", "读成"], ["你真正", "关心的事。"]];
    const ITAL = new Set(["读成", "关心的事。"]);
    mani.setAttribute("aria-label", LINES.map((l) => l.join("")).join(""));
    const WORDS = [];
    LINES.forEach((line, li) => {
      line.forEach((w, wi) => {
        const s = document.createElement("span");
        s.className = "w" + (ITAL.has(w) ? " i" : "");
        s.textContent = w;
        s.setAttribute("aria-hidden", "true");
        mani.appendChild(s);
        WORDS.push({ el: s, key: li / LINES.length + (wi / line.length) * 0.17 / LINES.length });
      });
      if (li < LINES.length - 1) mani.appendChild(document.createElement("br"));
    });

    /* 每屏上升文案（manifesto 词走自己的点亮，不进 RISE） */
    const RISE = secs.map((sec) => [...sec.querySelectorAll(".sec-title, .lab, .foot span, .grid4 .stack-card, .end, .big")].filter((el) => !el.closest(".manifesto")));
    const maniIdx = secs.findIndex((s) => s.querySelector(".manifesto"));
    const progBar = stack.querySelector(".stack-prog");
    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const ease = (q) => q * q * (3 - 2 * q); /* smoothstep，同参考 */

    /* 位置测量：用 offsetHeight + margin 累加，天然免疫 sticky 钉住位移，
       不必读钉住后的 getBoundingClientRect（缓存会随滚动失准） */
    let vh = innerHeight, stickyTop = 68, secMargin = 0;
    const tops = [];
    const docTop = (el) => { let t = 0; while (el) { t += el.offsetTop; el = el.offsetParent; } return t; };
    const measure = () => {
      vh = innerHeight;
      const cs = getComputedStyle(secs[0]);
      stickyTop = parseFloat(cs.top) || 0;
      secMargin = parseFloat(cs.marginBottom) || 0;
      const base = docTop(stack);
      let acc = 0;
      tops.length = 0; /* 重复测量先清空，否则 resize 后 paint 读到旧条目 */
      for (const sec of secs) { tops.push(base + acc); acc += sec.offsetHeight + secMargin; }
    };

    const progress = new Array(secs.length).fill(0);
    const paint = () => {
      if (!stack.offsetParent) return; /* 叠层隐藏（桌面端 / 离开首页）不写样式 */
      const y = window.scrollY || document.documentElement.scrollTop;
      for (let i = 0; i < secs.length; i++) progress[i] = clamp01((y - (tops[i] - stickyTop)) / vh);
      if (progBar) progBar.style.width = (clamp01(y / Math.max(1, document.documentElement.scrollHeight - vh)) * 100) + "%";

      /* 各屏文案在钉住期间上浮点亮（首屏标题加载即可见，从 1 起跳） */
      for (let i = 1; i < RISE.length; i++) {
        const list = RISE[i], n = list.length, d = 0.42 / Math.max(1, n);
        for (let k = 0; k < n; k++) {
          const q = ease(clamp01((progress[i] * 1.5 - k * d) / 0.34));
          const el = list[k];
          el.style.opacity = (0.06 + 0.94 * q).toFixed(3);
          el.style.transform = `translate3d(0,${((1 - q) * 22).toFixed(1)}px,0)`;
        }
      }
      /* manifesto 逐词点亮：未点亮词保持 0.22 可读，扫过升起（照抄 SWEEP） */
      const sw = progress[maniIdx] * 1.24;
      for (const w of WORDS) w.el.style.opacity = (0.22 + 0.78 * ease(clamp01((sw - w.key) / 0.2))).toFixed(3);
    };

    if (RM) {
      WORDS.forEach((w) => { w.el.style.opacity = "1"; });
    } else {
      measure();
      paint();
      window.addEventListener("scroll", paint, { passive: true });
      window.addEventListener("resize", () => { measure(); paint(); });
      window.addEventListener("load", () => { measure(); paint(); }, { once: true });
    }
  }

  /* —— 磁贴交互：碰碰车物理 ——
     指针是隐形撞锤：快速扫过磁贴把它撞飞（动量 ∝ 指针速度），
     飞行中磁贴互撞传递动量、撞墙反弹，最后弹簧归位；
     慢速靠近只放大 + 轻微视差跟随。按下（click）直接进入对应界面。 */
  const scatter = document.querySelector(".desk-scatter");
  const tiles = [...document.querySelectorAll(".scatter-tile")].map((el) => ({
    el,
    gain: parseFloat(el.style.getPropertyValue("--g")) || 12,
    mx: 0, my: 0, tx: 0, ty: 0,          /* 指针视差 */
    x: 0, y: 0, vx: 0, vy: 0,            /* 撞飞位移与速度 */
    rot: 0,                              /* 撞击旋转扰动 */
    sc: 1, scT: 1,                        /* proximity scale */
    state: "home",                        /* home | fly | return */
  }));

  if (tiles.length && scatter && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    let lastPt = null, ptVX = 0, ptVY = 0;
    window.addEventListener("pointermove", (e) => {
      if (lastPt) { ptVX = e.clientX - lastPt.x; ptVY = e.clientY - lastPt.y; }
      lastPt = { x: e.clientX, y: e.clientY };
      const nx = (e.clientX / innerWidth) * 2 - 1;
      const ny = (e.clientY / innerHeight) * 2 - 1;
      tiles.forEach((f) => { f.tx = nx * f.gain; f.ty = ny * f.gain * 0.7; });
    }, { passive: true });
    document.addEventListener("pointerleave", () => {
      lastPt = null;
      tiles.forEach((f) => { f.tx = 0; f.ty = 0; });
    });

    let ptLast = 0;
    requestAnimationFrame(function ptTick(now) {
      if (!ptLast) ptLast = now;
      if ((now - ptLast) >= 1000 / 60) { /* 60fps 上限 */
        ptLast = now;
        if (scatter.offsetParent) {
          /* 容器矩形每帧读取（egg 页下方有 story 可滚动，缓存会随滚动失准） */
          const boxRect = scatter.getBoundingClientRect();
          const rects = tiles.map((f) => f.el.getBoundingClientRect());
          const pSpd = Math.hypot(ptVX, ptVY);
          /* 指针撞击（快扫）+ proximity 放大（慢靠）
             注意：rect 已含当前 transform（含位移），中心不能再叠加 f.x/f.y */
          for (let i = 0; i < tiles.length; i++) {
            const f = tiles[i], r = rects[i];
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            if (lastPt) {
              const dx = lastPt.x - cx, dy = lastPt.y - cy;
              const d = Math.hypot(dx, dy);
              const hitR = Math.max(r.width, r.height) * 0.55;
              if (f.state === "home" && d < hitR && pSpd > 9) {
                /* 撞飞：动量 = 指针速度 + 推离分量 */
                const power = Math.min(46, pSpd * 0.9);
                const ux = d > 0 ? -dx / d : 0, uy = d > 0 ? -dy / d : 1;
                f.vx = ptVX * 0.75 + ux * power * 0.6;
                f.vy = ptVY * 0.75 + uy * power * 0.6;
                f.rot = (Math.random() - 0.5) * 14;
                f.state = "fly";
                f.scT = 1;
              } else if (d < 150) {
                const k = 1 - d / 150;
                f.scT = 1 + 0.14 * k * k;
              } else f.scT = 1;
            } else f.scT = 1;
          }
          /* 飞行互撞：分离 + 动量传递（被撞的磁贴也飞起来） */
          for (let i = 0; i < tiles.length; i++) {
            const a = tiles[i];
            if (a.state !== "fly") continue;
            for (let j = 0; j < tiles.length; j++) {
              if (i === j) continue;
              const b = tiles[j], rb = rects[j];
              const acx = rects[i].left + rects[i].width / 2, acy = rects[i].top + rects[i].height / 2;
              const bcx = rb.left + rb.width / 2, bcy = rb.top + rb.height / 2;
              const minD = (rects[i].width + rb.width) * 0.54;
              const dx = acx - bcx, dy = acy - bcy;
              const d = Math.hypot(dx, dy);
              if (d > 0 && d < minD) {
                const ux = dx / d, uy = dy / d, push = (minD - d) * 0.5;
                a.x += ux * push; a.y += uy * push;
                if (b.state === "home") {
                  b.state = "fly";
                  b.vx = a.vx * 0.6 + ux * 2.2;
                  b.vy = a.vy * 0.6 + uy * 2.2;
                  b.rot = (Math.random() - 0.5) * 10;
                }
                a.vx *= 0.55; a.vy *= 0.55;
              }
            }
          }
          /* 状态推进 + 批量写 */
          for (const f of tiles) {
            if (f.state === "fly") {
              f.x += f.vx; f.y += f.vy;
              f.vx *= 0.93; f.vy *= 0.93;
              f.rot *= 0.94;
              /* 边界反弹（磁贴中心限制在容器内） */
              const w = f.el.offsetWidth, h = f.el.offsetHeight;
              const basePx = (parseFloat(f.el.style.getPropertyValue("--x")) || 0) / 100 * boxRect.width;
              const basePy = (parseFloat(f.el.style.getPropertyValue("--y")) || 0) / 100 * boxRect.height;
              const minX = 10 + w / 2 - basePx, maxX = boxRect.width - 10 - w / 2 - basePx;
              const minY = 10 + h / 2 - basePy, maxY = boxRect.height - 10 - h / 2 - basePy;
              if (f.x < minX) { f.x = minX; f.vx = Math.abs(f.vx) * 0.75; f.rot = -f.rot * 0.6; }
              if (f.x > maxX) { f.x = maxX; f.vx = -Math.abs(f.vx) * 0.75; f.rot = -f.rot * 0.6; }
              if (f.y < minY) { f.y = minY; f.vy = Math.abs(f.vy) * 0.75; f.rot = -f.rot * 0.6; }
              if (f.y > maxY) { f.y = maxY; f.vy = -Math.abs(f.vy) * 0.75; f.rot = -f.rot * 0.6; }
              if (Math.hypot(f.vx, f.vy) < 0.45) f.state = "return";
            } else if (f.state === "return") {
              f.x *= 0.86; f.y *= 0.86; f.rot *= 0.86;
              if (Math.hypot(f.x, f.y) < 0.5) { f.x = 0; f.y = 0; f.rot = 0; f.state = "home"; }
            }
            f.sc += (f.scT - f.sc) * 0.13;
            f.mx += (f.tx - f.mx) * 0.06;
            f.my += (f.ty - f.my) * 0.06;
            const px = f.x + f.mx, py = f.y + f.my;
            if (f.state !== "home" || Math.abs(px) > 0.05 || Math.abs(py) > 0.05 || Math.abs(f.sc - 1) > 0.001) {
              const rotCss = f.rot ? ` + ${f.rot.toFixed(2)}deg` : "";
              f.el.style.transform = `translate3d(${px.toFixed(2)}px, ${py.toFixed(2)}px, 0) rotate(calc(var(--r)${rotCss})) scale(${f.sc.toFixed(3)})`;
            } else if (f.el.style.transform) {
              f.el.style.transform = "";
            }
          }
          ptVX *= 0.8; ptVY *= 0.8; /* 指针速度衰减（停手后不再撞飞） */
        } else {
          for (const f of tiles) {
            f.x = 0; f.y = 0; f.vx = 0; f.vy = 0; f.rot = 0; f.state = "home";
            if (f.el.style.transform) f.el.style.transform = "";
          }
        }
      }
      requestAnimationFrame(ptTick);
    });
  }
  /* —— 彩蛋页：桌面双击左上角 logo 进入/返回便利贴磁贴页（veil 纸张转场） —— */
  const homeView = document.querySelector(".home-view");
  const isDesktop = () => matchMedia("(min-width: 981px)").matches;
  let eggVeiling = false;
  const toggleEgg = () => {
    if (!isDesktop() || eggVeiling) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      homeView.classList.toggle("is-egg");
      return;
    }
    eggVeiling = true;
    veil.classList.remove("is-sweeping");
    void veil.offsetWidth; /* 重启扫过动画 */
    veil.classList.add("is-sweeping");
    /* 遮罩盖住屏幕（约 260ms 处）切换主页/彩蛋页；
       从其他视图双击 logo 进来时先激活首页 */
    setTimeout(() => {
      if (!homeView.classList.contains("active")) showView("home-view");
      homeView.classList.toggle("is-egg");
    }, 270);
    setTimeout(() => { veil.classList.remove("is-sweeping"); eggVeiling = false; }, 640);
  };
  /* 双击检测：两次 click 间隔 <400ms 视为双击（比 dblclick 事件更稳） */
  let lastBrandClick = 0;
  const brandEggClick = () => {
    const now = performance.now();
    if (now - lastBrandClick < 400) { lastBrandClick = 0; toggleEgg(); }
    else lastBrandClick = now;
  };
  document.querySelector(".topbar .brand-home")?.addEventListener("click", brandEggClick);
  document.querySelector(".sidebar-brand.brand-home")?.addEventListener("click", brandEggClick);
  document.querySelector(".scatter-brand")?.addEventListener("click", brandEggClick);

  /* —— 滑动内容介绍：滚动进入 reveal —— */
  const story = document.querySelector(".home-story");
  if (story && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); }
      }
    }, { root: document.querySelector(".app-shell") || null, threshold: 0.22 });
    story.querySelectorAll(".story-sec").forEach((sec) => io.observe(sec));
  }
}
