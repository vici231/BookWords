/* views/generate.js — 生成控制：难度滑条 / 长度 / 调参下拉 / 出版按钮 / 结果卡渲染 */

import { Api } from "../api.js";
import { MAX_STORY_CARDS, state } from "../state.js";
import { $, esc, formatBold, toast } from "../utils.js";
import { saveArticle, dailyWeekInfo, genreLabelEn } from "../articles.js";
import { renderPractice, withStoryGlosses } from "./practice.js";
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
  return candidates
    .filter((item) => Number.isFinite(item.stamp) && item.stamp >= start)
    .sort((a, b) => b.stamp - a.stamp)
    .map((item) => item.card)
    .filter((card) => {
      const key = String(card.word || "").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function generationCards() {
  return state.memoryScope === "recent_3d" ? recentMemoryCards(3) : state.pool;
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
  state.sliders.length = Math.max(180, Math.min(260, Number(input.value || 220)));
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

let vortexRunId = 0;
let vortexCleanup = null;
/* Canvas 字母漩涡：保留原生成遮罩的蓝白 UI，只把未完成的转场替换为可中断的状态机。 */
const vortexEase = (t) => t * t * t;
const vortexClamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const vortexLerp = (a, b, t) => a + (b - a) * t;
const vortexRand = (a, b) => a + Math.random() * (b - a);
const vortexInt = (a, b) => Math.floor(vortexRand(a, b + 1));

function playVortexAnimation(words, onComplete) {
  const overlay = $("#generation-overlay");
  const orbit = overlay?.querySelector(".generation-orbit");
  if (!overlay || !orbit) return;
  vortexCleanup?.();
  vortexCleanup = null;
  const runId = ++vortexRunId;
  const canvas = document.createElement("canvas");
  canvas.className = "generation-vortex-canvas";
  canvas.setAttribute("aria-label", "字母漩涡吸入动画");
  orbit.prepend(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const sourceWords = words.map((word) => String(word.word || "").trim().toUpperCase()).filter(Boolean);
  const groups = [];
  for (let index = 0; index < sourceWords.length; index += 3) groups.push(sourceWords.slice(index, index + 3).join(" "));
  if (!groups.length) groups.push("DREAM BIG NOW");
  let groupIndex = 0;
  let chars = [...groups[groupIndex]];
  const state = { phase: "idle", since: performance.now(), nextPick: 0, dpr: 1, w: 0, h: 0, cx: 0, cy: 0, radius: 0, font: 18, glow: .2, raf: 0, last: 0 };
  const particles = [];
  let letters = [];

  function resize() {
    const rect = orbit.getBoundingClientRect();
    state.w = Math.max(1, rect.width);
    state.h = Math.max(1, rect.height);
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(state.w * state.dpr);
    canvas.height = Math.round(state.h * state.dpr);
    canvas.style.width = `${state.w}px`;
    canvas.style.height = `${state.h}px`;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    state.cx = state.w * .5;
    state.cy = state.h * .5;
    state.radius = Math.min(state.w, state.h) * .36;
    const arc = (Math.PI * 2 * state.radius / Math.max(chars.length, 1)) * .7;
    state.font = Math.max(14, Math.min(48, Math.min(arc, 48 - chars.length * .72)));
  }

  function resetLetters() {
    letters = chars.map((char, index) => ({
      char,
      angle: -Math.PI / 2 + (index / chars.length) * Math.PI * 2,
      seed: Math.random() * Math.PI * 2,
      dir: Math.random() > .5 ? 1 : -1,
      twist: vortexRand(.75, 1.25),
      status: "pending",
      started: 0,
      duration: vortexRand(1500, 2200),
      particleCount: vortexInt(2, 5),
      particlesMade: 0,
      nextParticle: 0,
    }));
  }

  function setPhase(phase, now) {
    state.phase = phase;
    state.since = now;
    if (phase === "sucking") state.nextPick = now;
    const label = $("#generation-status-text");
    if (label && overlay.dataset.phase !== "choice") {
      label.textContent = overlay.dataset.phase === "compose" ? "正在编排文章" : phase === "idle" ? "等待识别" : phase === "waiting" ? "识别完成" : "正在吸入词汇";
    }
  }

  function startLetter(letter, now, boosted = false) {
    letter.status = "sucking";
    letter.started = now;
    letter.duration = boosted ? vortexRand(700, 1050) : vortexRand(1500, 2200);
    letter.particleCount = vortexInt(2, 5);
    letter.particlesMade = 0;
    letter.nextParticle = now + vortexRand(70, 190);
  }

  function boost(now) {
    if (state.phase === "waiting") {
      startNext();
      return;
    }
    if (state.phase === "idle") setPhase("sucking", now);
    letters.filter((letter) => letter.status === "pending").forEach((letter, index) => startLetter(letter, now + index * 38, true));
    letters.filter((letter) => letter.status === "sucking").forEach((letter) => { letter.duration = Math.min(letter.duration, 900); });
    state.nextPick = Number.POSITIVE_INFINITY;
  }

  function startNext() {
    if (runId !== vortexRunId) return;
    orbit.classList.remove("is-vortex-done");
    groupIndex = (groupIndex + 1) % groups.length;
    chars = [...groups[groupIndex]];
    resize();
    resetLetters();
    particles.length = 0;
    setPhase("idle", performance.now());
  }

  function spawnParticle(letter, now, pos) {
    const dx = pos.x - state.cx;
    const dy = pos.y - state.cy;
    particles.push({
      x: pos.x, y: pos.y, radius: Math.hypot(dx, dy), angle: Math.atan2(dy, dx),
      dir: letter.dir, born: now, life: vortexRand(400, 900), size: vortexRand(1.2, 2.7), trail: [],
    });
  }

  function letterPosition(letter, progress, now) {
    if (letter.status !== "sucking") {
      const float = Math.sin(now * .0013 + letter.seed) * 2.2;
      const angle = letter.angle + Math.sin(now * .00045 + letter.seed) * .008;
      return { x: state.cx + Math.cos(angle) * (state.radius + float), y: state.cy + Math.sin(angle) * (state.radius + float), angle };
    }
    const eased = vortexEase(vortexClamp(progress));
    const angle = letter.angle + letter.dir * eased * letter.twist;
    const radius = state.radius * (1 - eased);
    const offset = Math.sin(eased * Math.PI * 2 + letter.seed) * state.radius * .055 * (1 - eased);
    return { x: state.cx + Math.cos(angle) * radius - Math.sin(angle) * offset, y: state.cy + Math.sin(angle) * radius + Math.cos(angle) * offset, angle };
  }

  function drawCenter(now, activeCount) {
    const target = .24 + Math.min(1, activeCount * .13) + (state.phase === "waiting" ? .08 : 0);
    state.glow += (target - state.glow) * .08;
    const pulse = .5 + .5 * Math.sin(now * .004);
    const radius = 5 + activeCount * 1.8 + pulse * 1.5 + state.glow * 2;
    ctx.fillStyle = `rgba(255,255,255,${.78 + state.glow * .16})`;
    ctx.shadowColor = `rgba(23,114,246,${.28 + state.glow * .22})`;
    ctx.shadowBlur = 10 + activeCount * 2;
    ctx.beginPath(); ctx.arc(state.cx, state.cy, radius, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
  }

  function renderParticles(now) {
    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const particle = particles[i];
      const p = (now - particle.born) / particle.life;
      if (p >= 1) { particles.splice(i, 1); continue; }
      const r = particle.radius * (1 - p);
      const angle = particle.angle + particle.dir * p * 1.7;
      const x = state.cx + Math.cos(angle) * r;
      const y = state.cy + Math.sin(angle) * r;
      ctx.fillStyle = `rgba(242,145,83,${(1 - p) * .9})`;
      ctx.beginPath(); ctx.arc(x, y, particle.size * (1 - p * .35), 0, Math.PI * 2); ctx.fill();
    }
  }

  function tick(now) {
    if (runId !== vortexRunId || overlay.hidden) return;
    if (!state.last) state.last = now;
    if (state.phase === "idle" && now - state.since >= 1200) setPhase("sucking", now);
    if (state.phase === "sucking") {
      while (now >= state.nextPick && letters.some((letter) => letter.status === "pending")) {
        const pending = letters.filter((letter) => letter.status === "pending");
        startLetter(pending[vortexInt(0, pending.length - 1)], now);
        const ratio = 1 - pending.length / letters.length;
        state.nextPick = now + vortexLerp(350, 120, ratio);
      }
      letters.forEach((letter) => {
        if (letter.status !== "sucking") return;
        const progress = vortexClamp((now - letter.started) / letter.duration);
        const pos = letterPosition(letter, progress, now);
        while (letter.particlesMade < letter.particleCount && now >= letter.nextParticle && progress < .95) {
          spawnParticle(letter, now, pos); letter.particlesMade += 1; letter.nextParticle += vortexRand(120, 260);
        }
        if (progress >= 1) letter.status = "done";
      });
      if (letters.every((letter) => letter.status === "done")) { setPhase("waiting", now); orbit.classList.add("is-vortex-done"); }
    } else if (state.phase === "waiting" && now - state.since >= 600) {
      startNext();
    }

    ctx.clearRect(0, 0, state.w, state.h);
    let activeCount = 0; let progressTotal = 0;
    letters.forEach((letter) => {
      let progress = letter.status === "done" ? 1 : 0;
      if (letter.status === "sucking") { activeCount += 1; progress = vortexClamp((now - letter.started) / letter.duration); }
      progressTotal += progress;
      if (letter.status === "done" || letter.char === " ") return;
      const pos = letterPosition(letter, progress, now);
      const warm = letter.status === "sucking" ? vortexClamp(progress / .8) : 0;
      const r = Math.round(vortexLerp(79, 242, warm));
      const g = Math.round(vortexLerp(106, 145, warm));
      const b = Math.round(vortexLerp(145, 83, warm));
      const alpha = letter.status === "sucking" ? (progress < .55 ? .95 : vortexLerp(.95, 0, (progress - .55) / .45)) : .72;
      const stretch = letter.status === "sucking" ? 1 + 5 * vortexEase(progress) : 1;
      const compress = letter.status === "sucking" ? vortexLerp(1, .78, vortexEase(progress)) : 1;
      ctx.save(); ctx.translate(pos.x, pos.y); let rotation = pos.angle + Math.PI / 2; if (Math.cos(pos.angle) < 0) rotation += Math.PI; ctx.rotate(rotation); ctx.scale(compress, stretch);
      ctx.font = `400 ${state.font}px Georgia, "Times New Roman", serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`; ctx.fillText(letter.char, 0, 0); ctx.restore();
    });
    renderParticles(now); drawCenter(now, activeCount);
    const progressValue = state.phase === "waiting" ? 1 : progressTotal / Math.max(letters.length, 1);
    const progressBar = overlay.querySelector(".generation-progress");
    if (progressBar) progressBar.style.setProperty("--vortex-progress", `${Math.round(progressValue * 100)}%`);
    state.raf = requestAnimationFrame(tick);
  }

  resize(); resetLetters();
  const activate = () => boost(performance.now());
  const onPointer = (event) => { if (event.target === overlay || event.target === orbit || event.target === canvas) activate(); };
  const onKey = (event) => { if (event.code === "Space" && !event.repeat) { event.preventDefault(); activate(); } };
  overlay.addEventListener("pointerdown", onPointer, { passive: true });
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", resize, { passive: true });
  state.raf = requestAnimationFrame(tick);
  const cleanup = () => {
    cancelAnimationFrame(state.raf);
    overlay.removeEventListener("pointerdown", onPointer);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", resize);
    canvas.remove();
    if (runId === vortexRunId) onComplete?.();
  };
  vortexCleanup = cleanup;
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
      playVortexAnimation(words);
    }
    const wordHost = stage?.querySelector(".generation-stage-words");
    if (wordHost) {
      wordHost.innerHTML = generationCards().slice(0, 20).map((word, index) => `<span style="--i:${index}">${esc(word.word || "")}</span>`).join("");
    }
  } else {
    vortexCleanup?.();
    vortexCleanup = null;
    vortexRunId += 1;
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

async function generate() {
  if (state.generating) return;
  const need = state.minCards || 3; /* 由 /api/meta 下发，前后端单一来源 */
  const candidateCards = generationCards();
  if (candidateCards.length < need) {
    toast(`故事需要至少 ${need} 张卡牌`);
    return;
  }
  if (state.source === "auto") {
    toast("请先在搜索中选择一个匹配题材");
    return;
  }
  if (state.source !== "original" && !state.sourceSelection) {
    toast("请先选择一个题材来源");
    return;
  }
  setLoading(true);
  generationOverlay(true, "wait");
  aiDebugBegin("/api/generate/story");
  let debugShown = false;
  try {
    const words = state.pool.slice(0, MAX_STORY_CARDS).map(({ addedAt, ...word }) => word);
    const recentCards = recentMemoryCards(3).slice(0, 80).map(({ addedAt, ...word }) => word);
    const options = { memoryScope: state.memoryScope, language: state.articleLanguage, recentCards };
    let data = await Api.generate("story", words, diffLevel(state.diff), state.sliders, state.source, state.sourceSelection, options);
    aiDebugEnd(data.debug || null, !data.error, data.error);
    debugShown = true;
    if (data.error) throw new Error(data.error);
    generationOverlay(true, "compose");
    renderResult(data);
  } catch (err) {
    /* 前置校验（卡牌不足等）与网络错误拿不到 trace，只显示错误行 */
    if (!debugShown) aiDebugEnd(err.data?.debug || null, false, err.data?.error || err.message);
    toast("生成失败：" + err.message);
  } finally {
    setLoading(false);
    setTimeout(() => generationOverlay(false), 520);
  }
}

export function renderResult(data) {
  const box = $("#result");
  if (data.story) {
    const s = data.story;
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
        <div class="result-publication"><span>ZHIHU ENGLISH DAILY</span><span>${esc(week.label)} · ${esc(genreLabelEn(issue.genre))}</span></div>
        <h3 class="result-title">${esc(s.title || "知乎英语日报")}</h3>
        <p class="result-dateline">${esc(s.dateline || "Zhihu Daily")} · 知乎英语日报编辑台</p>
        <div class="result-language-block"><span>${state.articleLanguage === "zh" ? "中文呈现" : "ENGLISH"}</span><p class="result-en">${formatBold(state.articleLanguage === "zh" ? s.zh : s.en)}</p></div>
        ${s.takeaway ? `<p class="result-takeaway"><span>Takeaway</span>${esc(s.takeaway)}</p>` : ""}
        <div class="result-language-block result-translation"><span>${state.articleLanguage === "zh" ? "ENGLISH REFERENCE" : "中文翻译"}</span><p class="result-cn">${formatBold(state.articleLanguage === "zh" ? s.en : (s.zh || withStoryGlosses(s.cn, s)))}</p></div>
        <p class="newspaper-source-note">${esc(s.source_note || "来源：AI 原创生成｜Bookwords 英语学习材料")}${s.source_url ? ` · <a href="${esc(s.source_url)}" target="_blank" rel="noreferrer">查看原链接</a>` : ""}</p>
        <div class="result-actions"><div class="result-tip">这一期已存入日报存档，练习已在词汇池下方准备好。</div><button class="result-practice-link" type="button">开始填空练习 →</button></div>
      </div>`;
    box.querySelector(".result-practice-link").addEventListener("click", () => {
      $("#practice-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    renderPractice();
  }
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

export function bindGenerateEvents() {
  $("#diff-slider").addEventListener("input", updateDiffVal);
  $("#length-slider").addEventListener("input", updateLengthVal);
  Object.keys(PARAM_META).forEach(wireParamSelect);
  document.addEventListener("click", closeTuneDropdowns);
  $("#btn-generate").addEventListener("click", generate);
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

function candidateCardByWord(word) {
  const key = String(word || "").toLowerCase();
  return generationCards().find((card) => String(card.word || "").toLowerCase() === key) || null;
}
