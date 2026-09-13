/* views/generate.js — 生成控制：难度滑条 / 长度 / 调参下拉 / 出版按钮 / 结果卡渲染 */

import { Api } from "../api.js";
import { emit, MAX_STORY_CARDS, state } from "../state.js";
import { persist } from "../store.js";
import { $, esc, formatBold, toast } from "../utils.js";
import { saveArticle, dailyWeekInfo, genreLabelEn } from "../articles.js";
import { renderInlinePractice, renderPractice, withStoryGlosses } from "./practice.js";
import { renderArticleBook } from "./storybook.js";
import { aiDebugBegin, aiDebugEnd } from "./ai-debug.js";

function localDateStart(daysAgo = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date;
}

export function recentMemoryCards(days = 3) {
  const start = localDateStart(days - 1).getTime();
  const seen = new Set();
  const candidates = state.wordbook.map((card) => ({ card, stamp: new Date(card.savedAt || card.addedAt || "").getTime() }));
  state.articles.forEach((article) => {
    const stamp = new Date(article.lastPracticedAt || article.generatedAt || article.savedAt || "").getTime();
    (article.targetCards || []).forEach((card) => candidates.push({ card, stamp }));
  });
  state.recentMistakes.forEach((item) => {
    candidates.push({ card: item.card || { word: item.word }, stamp: new Date(item.wrongAt || "").getTime() });
  });
  return candidates
    .filter((item) => Number.isFinite(item.stamp) && item.stamp >= start)
    .sort((a, b) => b.stamp - a.stamp)
    .map((item) => item.card)
    .filter((card) => {
      const key = String(card.word || "").toLowerCase();
      if (!key || seen.has(key) || state.masteredWords[key]) return false;
      seen.add(key);
      return true;
    });
}

export function generationCards() {
  return state.memoryScope === "recent_3d"
    ? recentMemoryCards(state.coverageDays || 3)
    : state.pool.filter((card) => state.targetSelection.has(String(card.word || "").toLowerCase()));
}

function diffLevel(v) {
  if (v <= 3) return "junior";
  if (v <= 6) return "senior";
  return "cet";
}
function diffLabel(v) {
  const lbl = { junior: "初中 · 简单", senior: "高中 · 中等", cet: "四六级 · 进阶" };
  return lbl[diffLevel(v)];
}

export function updateDiffVal() {
  const v = Number($("#diff-slider").value || 3);
  state.diff = v;
  $("#diff-val").textContent = diffLabel(v);
}

export function updateLengthVal() {
  const input = $("#length-slider");
  if (!input) return;
  state.sliders.length = Math.max(180, Math.min(600, Number(input.value || 220)));
  $("#length-val").textContent = `约 ${state.sliders.length} 词`;
}

/* 生成调参滑条：key / 档位描述（低-中-高） */
const PARAM_META = {
  density: { bucket: (v) => (v <= 4 ? "低" : v <= 7 ? "中" : "高") },
  richness: { bucket: (v) => (v <= 4 ? "低" : v <= 7 ? "中" : "高") },
  reasoning: { bucket: (v) => (v <= 4 ? "低" : v <= 7 ? "中" : "高") },
  abstraction: { bucket: (v) => (v <= 4 ? "低" : v <= 7 ? "中" : "高") },
};

function closeTuneDropdowns() {
  document.querySelectorAll(".tune-field.is-open").forEach((field) => {
    field.classList.remove("is-open");
    field.querySelector(".tune-trigger")?.setAttribute("aria-expanded", "false");
  });
}

function wireParamSelect(key) {
  const input = document.getElementById(`param-${key}`);
  if (!input) return;
  const meta = PARAM_META[key];
  const field = input.closest(".tune-field");
  const trigger = field?.querySelector(".tune-trigger");
  const options = field?.querySelector(".tune-options");
  const upd = () => {
    const v = Number(input.value);
    state.sliders[key] = v;
    if (trigger) {
      const selected = options?.querySelector(`.tune-option[data-value="${v}"]`);
      trigger.querySelector(".tune-value").textContent = selected?.textContent.trim() || `${meta.bucket(v)} · ${v}`;
      options?.querySelectorAll(".tune-option").forEach((option) => {
        const active = option === selected;
        option.classList.toggle("is-selected", active);
        option.setAttribute("aria-selected", active ? "true" : "false");
      });
    }
  };
  input.addEventListener("change", upd);
  trigger?.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = !field.classList.contains("is-open");
    closeTuneDropdowns();
    field.classList.toggle("is-open", opening);
    trigger.setAttribute("aria-expanded", opening ? "true" : "false");
  });
  options?.querySelectorAll(".tune-option").forEach((option) => {
    option.addEventListener("click", () => {
      input.value = option.dataset.value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      closeTuneDropdowns();
    });
  });
  upd();
}

function setLoading(on) {
  state.generating = on;
  const btn = $("#btn-generate");
  btn.disabled = on;
  const label = btn.querySelector("span:first-child");
  if (label) label.textContent = on ? "正在排版…" : "生成知乎英语日报";
}

let curtainRunId = 0;
let curtainCleanup = null;
/* 正方形英文窗帘：机制参考 motion-web char-curtain ——
   18 条独立垂直 Verlet 串（无横向约束，指针才能「拨开」帘子）；
   各向异性指针力 x 全量 / y *0.35，字母行保持可读、不揉成汤。
   皮肤为 Bookwords 蓝；字母由用户参考单词循环构成；
   识别吸入 = 字母暖色渐隐（像被认出来取走），进度条沿用 --vortex-progress。 */
const curtainClamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const curtainLerp = (a, b, t) => a + (b - a) * t;
const curtainRand = (a, b) => a + Math.random() * (b - a);
const curtainInt = (a, b) => Math.floor(curtainRand(a, b + 1));

function playCurtainAnimation(words, onComplete) {
  const overlay = $("#generation-overlay");
  const orbit = overlay?.querySelector(".generation-orbit");
  if (!overlay || !orbit) return;
  curtainCleanup?.();
  curtainCleanup = null;
  const runId = ++curtainRunId;
  const canvas = document.createElement("canvas");
  canvas.className = "generation-curtain-canvas";
  canvas.setAttribute("aria-label", "英文字母窗帘：划过拨开，点击加速");
  orbit.prepend(canvas);
  const note = document.createElement("span");
  note.className = "generation-curtain-note";
  note.textContent = "划过拨开字母帘 · 点击加速吸入";
  orbit.append(note);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* 字母来自参考单词（大写、空格分词） */
  const sourceWords = words.map((word) => String(word.word || "").trim().toUpperCase()).filter(Boolean);
  const groups = [];
  for (let index = 0; index < sourceWords.length; index += 3) groups.push(sourceWords.slice(index, index + 3).join(" "));
  if (!groups.length) groups.push("DREAM BIG NOW");
  let groupIndex = 0;
  let chars = [...groups[groupIndex]];

  /* —— Verlet 窗帘参数（正方形 COLS × ROWS） —— */
  const COLS = 18, ROWS = 18, ROW_SPACING = 24;
  const GRAVITY = reduced ? .4 : .22;
  const DRAG = .03;
  const SOLVER_PASSES = 4;
  const HOME_PULL = .35;
  const MOUSE_RADIUS = 84;
  const MOUSE_FORCE = 4.6;
  const MOUSE_Y_BIAS = .35;
  const SPEED_FOR_FULL_FADE = 8;

  const nodes = [];
  const links = [];
  const at = (c, r) => nodes[c * ROWS + r];
  const S = { w: 0, h: 0, dpr: 1, cardW: 420, x0: 0, y0: 0, font: 16, phase: "idle", since: performance.now(), nextPick: 0, raf: 0 };

  function layout() {
    S.cardW = Math.min(S.w * .86, 430);
    S.x0 = (S.w - S.cardW) / 2;
    S.y0 = Math.max(16, (S.h - ROWS * ROW_SPACING) / 2);
    S.font = Math.max(11, Math.min(20, ROW_SPACING * .72));
  }

  function build() {
    nodes.length = 0; links.length = 0;
    layout();
    const colSpacing = S.cardW / (COLS - 1);
    let i = 0;
    for (let c = 0; c < COLS; c += 1) {
      for (let r = 0; r < ROWS; r += 1) {
        const x = S.x0 + c * colSpacing;
        const y = S.y0 + r * ROW_SPACING;
        nodes.push({ x, y, oldX: x, oldY: y, initX: x, initY: y, char: chars[i++ % chars.length], isAnchor: r === 0, status: "pending", started: 0, duration: 0 });
      }
    }
    for (let c = 0; c < COLS; c += 1) for (let r = 1; r < ROWS; r += 1) links.push({ a: at(c, r - 1), b: at(c, r), len: ROW_SPACING });
  }

  function resize() {
    const rect = orbit.getBoundingClientRect();
    if (!rect.width) return;
    S.w = rect.width; S.h = rect.height;
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(S.w * S.dpr);
    canvas.height = Math.round(S.h * S.dpr);
    canvas.style.width = `${S.w}px`;
    canvas.style.height = `${S.h}px`;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    layout();
    /* 只移挂点，帘身自己摆过去 */
    const colSpacing = S.cardW / (COLS - 1);
    for (let c = 0; c < COLS; c += 1) {
      const head = at(c, 0);
      if (!head) continue;
      const nx = S.x0 + c * colSpacing;
      head.x = nx; head.oldX = nx; head.initX = nx; head.initY = S.y0;
    }
  }

  function setPhase(phase, now) {
    S.phase = phase;
    S.since = now;
    if (phase === "sucking") S.nextPick = now;
    const label = $("#generation-status-text");
    if (label && overlay.dataset.phase !== "choice") {
      label.textContent = overlay.dataset.phase === "compose" ? "正在编排文章" : phase === "idle" ? "等待识别" : phase === "waiting" ? "识别完成" : "正在吸入词汇";
    }
  }

  function startNode(node, now, boosted = false) {
    node.status = "sucking";
    node.started = now;
    node.duration = boosted ? curtainRand(600, 900) : curtainRand(1400, 2100);
  }

  function boost(now) {
    if (S.phase === "waiting") { startNext(); return; }
    if (S.phase === "idle") setPhase("sucking", now);
    nodes.filter((n) => n.status === "pending" && !n.isAnchor).forEach((n, index) => startNode(n, now + index * 6, true));
    nodes.filter((n) => n.status === "sucking").forEach((n) => { n.duration = Math.min(n.duration, 800); });
    S.nextPick = Number.POSITIVE_INFINITY;
  }

  function startNext() {
    if (runId !== curtainRunId) return;
    groupIndex = (groupIndex + 1) % groups.length;
    chars = [...groups[groupIndex]];
    build();
    setPhase("idle", performance.now());
  }

  /* —— 指针：各向异性排斥（x 全量、y *0.35） —— */
  let mouseX = 0, mouseY = 0, mouseActive = false;
  function onMove(event) {
    const rect = canvas.getBoundingClientRect();
    mouseX = event.clientX - rect.left;
    mouseY = event.clientY - rect.top;
    mouseActive = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  }
  overlay.addEventListener("pointermove", onMove, { passive: true });
  overlay.addEventListener("pointerleave", () => { mouseActive = false; });

  function step() {
    for (const n of nodes) {
      const vx = (n.x - n.oldX) * (1 - DRAG);
      const vy = (n.y - n.oldY) * (1 - DRAG);
      n.oldX = n.x; n.oldY = n.y;
      n.x += vx; n.y += vy + (n.isAnchor ? 0 : GRAVITY);
    }
    for (const n of nodes) {
      if (!n.isAnchor) continue;
      n.x += (n.initX - n.x) * HOME_PULL;
      n.y += (n.initY - n.y) * HOME_PULL;
    }
    if (mouseActive && !reduced) {
      for (const n of nodes) {
        const dx = n.x - mouseX, dy = n.y - mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= MOUSE_RADIUS || dist === 0) continue;
        const pct = 1 - dist / MOUSE_RADIUS;
        const force = pct * pct * MOUSE_FORCE;
        const grip = n.isAnchor ? .75 : 1;
        n.x += (dx / dist) * force * grip;
        n.y += (dy / dist) * force * MOUSE_Y_BIAS * grip;
      }
    }
    for (let pass = 0; pass < SOLVER_PASSES; pass += 1) {
      for (const l of links) {
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist === 0) continue;
        const pct = ((l.len - dist) / dist) * .5;
        const ox = dx * pct, oy = dy * pct;
        l.a.x -= ox; l.a.y -= oy;
        l.b.x += ox; l.b.y += oy;
      }
    }
  }

  function draw(now) {
    ctx.clearRect(0, 0, S.w, S.h);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `500 ${S.font}px "Space Grotesk", "PingFang SC", "Microsoft YaHei", sans-serif`;
    for (const n of nodes) {
      if (n.isAnchor || n.status === "done") continue;
      let alpha, rgb;
      if (n.status === "sucking") {
        const p = curtainClamp((now - n.started) / n.duration);
        const warm = curtainClamp(p / .8);
        rgb = `${Math.round(curtainLerp(23, 242, warm))},${Math.round(curtainLerp(114, 145, warm))},${Math.round(curtainLerp(246, 83, warm))}`;
        alpha = p < .55 ? .95 : curtainLerp(.95, 0, (p - .55) / .45);
      } else {
        const speed = Math.hypot(n.x - n.oldX, n.y - n.oldY);
        const fade = curtainClamp(speed / SPEED_FOR_FULL_FADE);
        rgb = `${Math.round(curtainLerp(23, 122, fade))},${Math.round(curtainLerp(114, 168, fade))},${Math.round(curtainLerp(246, 250, fade))}`;
        alpha = curtainLerp(.78, .3, fade);
      }
      ctx.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
      ctx.fillText(n.char, n.x, n.y);
    }
  }

  function tick(now) {
    if (runId !== curtainRunId || overlay.hidden) return;
    if (S.phase === "idle" && now - S.since >= 1200) setPhase("sucking", now);
    if (S.phase === "sucking") {
      const pending = () => nodes.filter((n) => n.status === "pending" && !n.isAnchor);
      while (now >= S.nextPick && pending().length) {
        const list = pending();
        startNode(list[curtainInt(0, list.length - 1)], now);
        S.nextPick = now + curtainLerp(320, 110, 1 - list.length / Math.max(1, nodes.length));
      }
      for (const n of nodes) if (n.status === "sucking" && now - n.started >= n.duration) n.status = "done";
      if (!pending().length && !nodes.some((n) => n.status === "sucking")) setPhase("waiting", now);
    } else if (S.phase === "waiting" && now - S.since >= 600) {
      startNext();
    }

    step();
    draw(now);

    const body = nodes.filter((n) => !n.isAnchor);
    const done = body.reduce((acc, n) => acc + (n.status === "done" ? 1 : n.status === "sucking" ? curtainClamp((now - n.started) / n.duration) : 0), 0);
    const progressValue = S.phase === "waiting" ? 1 : done / Math.max(1, body.length);
    const progressBar = overlay.querySelector(".generation-progress");
    if (progressBar) progressBar.style.setProperty("--vortex-progress", `${Math.round(progressValue * 100)}%`);
    S.raf = requestAnimationFrame(tick);
  }

  resize(); build();
  const activate = () => boost(performance.now());
  const onPointer = (event) => { if (event.target === overlay || event.target === orbit || event.target === canvas) activate(); };
  const onKey = (event) => { if (event.code === "Space" && !event.repeat) { event.preventDefault(); activate(); } };
  overlay.addEventListener("pointerdown", onPointer, { passive: true });
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", resize, { passive: true });
  S.raf = requestAnimationFrame(tick);
  const cleanup = () => {
    cancelAnimationFrame(S.raf);
    overlay.removeEventListener("pointerdown", onPointer);
    overlay.removeEventListener("pointermove", onMove);
    overlay.removeEventListener("pointerleave", () => { mouseActive = false; });
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", resize);
    canvas.remove();
    note.remove();
    if (runId === curtainRunId) onComplete?.();
  };
  curtainCleanup = cleanup;
  return cleanup;
}

function generationOverlay(on, phase = "wait") {
  const overlay = $("#generation-overlay");
  const stage = $("#generation-stage");
  const pool = $("#story-pool-view");
  if (!overlay) return;
  if (on) {
    const wasHidden = overlay.hidden;
    overlay.hidden = false;
    overlay.dataset.phase = phase;
    overlay.classList.toggle("has-generation-choice", phase === "choice");
    document.body.classList.add("is-generating");
    if (pool) pool.classList.add("is-generating");
    if (stage) stage.hidden = false;
    if (wasHidden) {
      const words = generationCards().slice(0, 80);
      playCurtainAnimation(words);
    }
    const wordHost = stage?.querySelector(".generation-stage-words");
    if (wordHost) {
      wordHost.innerHTML = generationCards().slice(0, 20).map((word, index) => `<span style="--i:${index}">${esc(word.word || "")}</span>`).join("");
    }
  } else {
    curtainCleanup?.();
    curtainCleanup = null;
    curtainRunId += 1;
    overlay.hidden = true;
    overlay.classList.remove("has-generation-choice");
    document.body.classList.remove("is-generating");
    if (pool) pool.classList.remove("is-generating");
    if (stage) stage.hidden = true;
  }
  const label = $("#generation-status-text");
  if (label) label.textContent = phase === "compose" ? "正在编排文章" : phase === "choice" ? "识别完成，选择编排方式" : "等待识别";
  const choices = overlay.querySelector(".generation-choice");
  if (choices) choices.hidden = phase !== "choice";
  const original = overlay.querySelector('[data-generation-choice="original"] strong');
  if (original) original.textContent = state.source === "original" ? "原创" : "建议原创";
}

function chooseGenerationMode() {
  const overlay = $("#generation-overlay");
  if (!overlay) return Promise.resolve("recommended");
  generationOverlay(true, "choice");
  return new Promise((resolve) => {
    const fallback = setTimeout(() => finish("recommended"), 1400);
    const choices = overlay.querySelectorAll("[data-generation-choice]");
    const finish = (mode) => {
      clearTimeout(fallback);
      choices.forEach((button) => button.removeEventListener("click", button._generationHandler));
      choices.forEach((button) => button.classList.toggle("is-selected", button.dataset.generationChoice === mode));
      resolve(mode);
    };
    choices.forEach((button) => {
      button._generationHandler = () => finish(button.dataset.generationChoice);
      button.addEventListener("click", button._generationHandler, { once: true });
    });
  });
}

export async function generateConfirmedArticle(signal = null) {
  if (state.generating) return;
  const need = state.minCards || 3; /* 由 /api/meta 下发，前后端单一来源 */
  const candidateCards = generationCards();
  if (candidateCards.length < need) {
    throw new Error(`故事需要至少 ${need} 张卡牌`);
  }
  setLoading(true);
  generationOverlay(true, "wait");
  aiDebugBegin("/api/generate/story");
  let debugShown = false;
  try {
    const words = state.pool.slice(0, MAX_STORY_CARDS).map(({ addedAt, ...word }) => word);
    const recentCards = recentMemoryCards(state.coverageDays || 3).slice(0, 80).map(({ addedAt, ...word }) => word);
    const options = {
      memoryScope: state.memoryScope,
      language: state.articleLanguage,
      recentCards,
      confirmedGroup: state.selectedGroup,
      lockedWords: Array.from(state.lockedWords),
      excludedWords: Array.from(state.excludedWords),
      originalTopic: state.originalTopic,
      signal,
    };
    let data = await Api.generate("story", words, diffLevel(state.diff), state.sliders, state.source, state.sourceSelection, options);
    aiDebugEnd(data.debug || null, !data.error, data.error);
    debugShown = true;
    if (data.error) throw new Error(data.error);
    generationOverlay(true, "compose");
    renderResult(data);
    return data;
  } catch (err) {
    /* 前置校验（卡牌不足等）与网络错误拿不到 trace，只显示错误行 */
    if (!debugShown) aiDebugEnd(err.data?.debug || null, false, err.data?.error || err.message);
    if (err.name !== "AbortError") toast("生成失败：" + err.message);
    throw err;
  } finally {
    setLoading(false);
    setTimeout(() => generationOverlay(false), 520);
  }
}

export function renderResult(data) {
  const box = $("#result");
  if (data.story) {
    const s = data.story;
    state.lastGeneration = data;
    state.lastStory = s;
    const selectedCards = (data.sorting?.selected_group?.words || []).map((word) => candidateCardByWord(word)).filter(Boolean);
    const issue = saveArticle(s, {
      cards: selectedCards,
      language: data.language?.selected || state.articleLanguage,
      memoryScope: data.memory_scope || state.memoryScope,
      sorting: data.sorting || {},
    });
    renderArticleBook();
    state.practiceCompleted = false;
    const week = dailyWeekInfo(issue.generatedAt);
    box.innerHTML = `
      <div class="result-card">
        <div class="result-mode-tabs" role="tablist"><button class="is-active" type="button" data-result-mode="reading">阅读</button><button type="button" data-result-mode="practice">练习</button></div>
        <div data-result-pane="reading">
        <div class="result-publication"><span>ZHIHU ENGLISH DAILY</span><span>${esc(week.label)} · ${esc(genreLabelEn(issue.genre))}</span></div>
        <h3 class="result-title">${esc(s.title || "知乎英语日报")}</h3>
        <p class="result-dateline">${esc(s.dateline || "Zhihu Daily")} · 知乎英语日报编辑台</p>
        <div class="result-language-block"><span>${state.articleLanguage === "zh" ? "中文呈现" : "ENGLISH"}</span><p class="result-en">${interactiveWords(state.articleLanguage === "zh" ? s.zh : s.en)}</p></div>
        ${s.takeaway ? `<p class="result-takeaway"><span>Takeaway</span>${esc(s.takeaway)}</p>` : ""}
        <div class="result-language-block result-translation"><span>${state.articleLanguage === "zh" ? "ENGLISH REFERENCE" : "中文翻译"}</span><p class="result-cn">${interactiveWords(state.articleLanguage === "zh" ? s.en : (s.zh || withStoryGlosses(s.cn, s)))}</p></div>
        <p class="newspaper-source-note">${esc(s.source_note || "来源：AI 原创生成｜Bookwords 英语学习材料")}${s.source_url ? ` · <a href="${esc(s.source_url)}" target="_blank" rel="noreferrer">查看原链接</a>` : ""}</p>
        ${s.validation_warnings?.length ? `<div class="article-quality-warning"><strong>校对提醒</strong><span>${esc(s.validation_warnings.join("；"))}。可返回文章方案调整，或重新生成。</span></div>` : ""}
        </div><div data-result-pane="practice" hidden><div id="inline-practice"></div></div>
      </div>`;
    box.querySelectorAll("[data-result-mode]").forEach((button) => button.addEventListener("click", () => setResultMode(button.dataset.resultMode)));
    box.querySelectorAll("[data-read-word]").forEach((button) => button.addEventListener("click", () => openWordPopup(button.dataset.readWord, button.closest("p")?.textContent || "")));
    renderPractice();
    renderInlinePractice();
  }
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

export function bindGenerateEvents() {
  $("#diff-slider").addEventListener("input", updateDiffVal);
  $("#length-slider").addEventListener("input", updateLengthVal);
  Object.keys(PARAM_META).forEach(wireParamSelect);
  document.addEventListener("click", closeTuneDropdowns);
  document.querySelectorAll('input[name="memory-scope"]').forEach((input) => input.addEventListener("change", (event) => {
    state.memoryScope = event.target.value === "recent_3d" ? "recent_3d" : "pool";
    const count = recentMemoryCards(3).length;
    const note = $("#recent-memory-note");
    if (note) note.textContent = `包含今天、昨天和前天收藏的 ${count} 个单词`;
    if (state.source === "auto") document.querySelector('.source-tab[data-source="auto"]')?.click();
  }));
  document.querySelectorAll('input[name="article-language"]').forEach((input) => input.addEventListener("change", (event) => {
    state.articleLanguage = event.target.value === "zh" ? "zh" : "en";
  }));
}

function interactiveWords(text) {
  return esc(text).replace(/\*\*([^*]+)\*\*/g, (_, word) => {
    const key = String(word).trim().toLowerCase();
    return `<button class="reading-word${state.masteredWords[key] ? " is-mastered" : ""}" type="button" data-read-word="${esc(key)}">${esc(word)}</button>`;
  }).replace(/\n/g, "<br>");
}

function activeTargetCard(key) {
  const article = state.articles.find((item) => item.id === state.lastArticleId);
  return (article?.targetCards || []).find((card) => String(card.word || "").toLowerCase() === key)
    || state.wordbook.find((card) => String(card.word || "").toLowerCase() === key)
    || generationCards().find((card) => String(card.word || "").toLowerCase() === key);
}

function openWordPopup(key, context) {
  const card = activeTargetCard(key) || { word: key };
  const saved = state.wordbook.some((item) => String(item.word || "").toLowerCase() === key);
  const mastered = Boolean(state.masteredWords[key]);
  const modal = $("#reading-word-modal");
  $("#reading-word-title").textContent = card.word || key;
  $("#reading-word-phonetic").textContent = card.phonetic || "暂无音标";
  $("#reading-word-meaning").textContent = `${card.pos || "词汇"} · ${card.meaning_cn || card.meaning || card.meaning_en || "暂无释义"}`;
  const sentence = String(context || "").split(/(?<=[.!?。！？])\s*/).find((part) => part.toLowerCase().includes(key)) || context;
  $("#reading-word-context").textContent = sentence;
  const save = $("#btn-reading-save-word");
  save.disabled = saved;
  save.textContent = saved ? "已在单词本" : "加入单词本";
  save.dataset.word = key;
  const master = $("#btn-reading-master-word");
  master.textContent = mastered ? "取消已掌握" : "标记已掌握";
  master.dataset.word = key;
  modal.hidden = false;
}

export function setResultMode(mode) {
  state.resultMode = mode === "practice" ? "practice" : "reading";
  document.querySelectorAll("[data-result-mode]").forEach((button) => button.classList.toggle("is-active", button.dataset.resultMode === state.resultMode));
  document.querySelectorAll("[data-result-pane]").forEach((pane) => (pane.hidden = pane.dataset.resultPane !== state.resultMode));
  if (state.resultMode === "practice") renderInlinePractice();
}

export function bindReadingWordEvents() {
  $("#btn-close-reading-word")?.addEventListener("click", () => ($("#reading-word-modal").hidden = true));
  $("#reading-word-modal")?.addEventListener("click", (event) => { if (event.target.id === "reading-word-modal") event.currentTarget.hidden = true; });
  $("#btn-reading-save-word")?.addEventListener("click", (event) => {
    const card = activeTargetCard(event.currentTarget.dataset.word);
    if (!card) return;
    if (!state.wordbook.some((item) => String(item.word || "").toLowerCase() === String(card.word || "").toLowerCase())) {
      state.wordbook.unshift({ ...card, savedAt: new Date().toISOString() });
      persist(); emit("wordbook"); toast(`「${card.word}」已加入单词本`);
    }
    event.currentTarget.disabled = true; event.currentTarget.textContent = "已在单词本";
  });
  $("#btn-reading-master-word")?.addEventListener("click", (event) => {
    const key = event.currentTarget.dataset.word;
    if (state.masteredWords[key]) delete state.masteredWords[key]; else state.masteredWords[key] = new Date().toISOString();
    persist();
    event.currentTarget.textContent = state.masteredWords[key] ? "取消已掌握" : "标记已掌握";
    document.querySelectorAll(`[data-read-word="${CSS.escape(key)}"]`).forEach((word) => word.classList.toggle("is-mastered", Boolean(state.masteredWords[key])));
  });
}

function candidateCardByWord(word) {
  const key = String(word || "").toLowerCase();
  return generationCards().find((card) => String(card.word || "").toLowerCase() === key) || null;
}

