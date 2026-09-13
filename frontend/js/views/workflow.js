import { Api } from "../api.js";
import { state } from "../state.js";
import { $, esc, toast } from "../utils.js";
import { generateConfirmedArticle, recentMemoryCards, setResultMode } from "./generate.js";

let generationController = null;

function todayCards() {
  return state.pool.filter((card) => state.targetSelection.has(String(card.word || "").toLowerCase()));
}

function routeCards() {
  return state.generationRoute === "zhihu" ? recentMemoryCards(state.coverageDays) : todayCards();
}

function cleanCards(cards) {
  return cards.slice(0, 60).map(({ addedAt, savedAt, ...card }) => card);
}

function setStage(stage) {
  state.workflowStage = stage;
  renderWorkflow();
}

export function resetWorkflow() {
  if (state.generating) return;
  state.workflowStage = "words";
  state.coveragePlans = [];
  state.coverageStatus = null;
  state.selectedGroup = null;
  state.sourceSelection = null;
  state.originalTopic = "";
  state.workflowError = null;
  renderWorkflow();
}

function stepIndex() {
  return { words: 0, plan: 1, compose: 2, generating: 2, result: 3 }[state.workflowStage] ?? 0;
}

function renderSteps() {
  const current = stepIndex();
  document.querySelectorAll("[data-workflow-step]").forEach((step, index) => {
    step.classList.toggle("is-active", index === current);
    step.classList.toggle("is-done", index < current);
  });
}

function setRoute(route) {
  state.generationRoute = route === "custom" ? "custom" : "zhihu";
  state.memoryScope = state.generationRoute === "zhihu" ? "recent_3d" : "pool";
  state.coveragePlans = [];
  state.selectedGroup = null;
  state.sourceSelection = null;
  state.workflowStage = "words";
  document.querySelectorAll("[data-generation-route]").forEach((button) => button.classList.toggle("is-active", button.dataset.generationRoute === state.generationRoute));
  const recent = document.querySelector('input[name="memory-scope"][value="recent_3d"]');
  const pool = document.querySelector('input[name="memory-scope"][value="pool"]');
  if (recent) recent.checked = state.generationRoute === "zhihu";
  if (pool) pool.checked = state.generationRoute === "custom";
  renderWorkflow();
}

function renderRouteOptions() {
  const zhihu = $("#zhihu-route-options"); const custom = $("#custom-route-options");
  if (zhihu) zhihu.hidden = state.generationRoute !== "zhihu";
  if (custom) custom.hidden = state.generationRoute !== "custom";
  document.querySelectorAll("[data-coverage-days]").forEach((button) => button.classList.toggle("is-active", Number(button.dataset.coverageDays) === state.coverageDays));
  const cards = routeCards();
  const summary = $("#coverage-word-summary");
  if (summary) summary.innerHTML = state.generationRoute === "zhihu"
    ? `<strong>近 ${state.coverageDays} 天共 ${cards.length} 个待强化词</strong><span>${esc(cards.slice(0, 16).map((card) => card.word).join(" · "))}${cards.length > 16 ? " …" : ""}</span>`
    : `<strong>今天已勾选 ${cards.length} 个目标词</strong><span>${esc(cards.map((card) => card.word).join(" · "))}</span>`;
}

function renderPlans() {
  const root = $("#coverage-plans");
  if (!root) return;
  if (state.workflowError) {
    root.innerHTML = `<div class="workflow-error"><strong>${esc(state.workflowError.error || "知乎文章匹配失败")}</strong><div><button class="btn-ghost" data-plan-action="back" type="button">返回</button><button class="btn-primary" data-plan-action="retry" type="button">重新匹配</button></div></div>`;
  } else if (!state.coveragePlans.length) {
    root.innerHTML = '<div class="group-loading">正在筛选核心关键词、搜索高收藏知乎文章并进行 AI 审核…</div>';
  } else {
    root.innerHTML = `<div class="coverage-overview"><strong>覆盖 ${state.coverageStatus?.covered_words?.length || 0} / ${state.coverageStatus?.total_words || 0} 个单词</strong><span>${state.coverageStatus?.complete ? "已完整覆盖，可选择任意一篇生成" : "覆盖尚未完成，请重新匹配"}</span></div>${state.coveragePlans.map((plan) => `<article class="coverage-plan-card"><header><span>${esc({ zhihu_search: "知乎文章", hot: "知乎热榜", story: "知乎故事", knowledge: "知乎知识" }[plan.source] || "知乎题材")}${plan.vote_up_count ? ` · ${plan.vote_up_count} 赞` : ""} · 审核 ${plan.review?.score || 0} 分</span><strong>${esc(plan.title || "未命名")}</strong></header><p>${esc(plan.summary || "")}</p>${planWordMarkup(plan)}<small class="coverage-review-note">${esc(plan.review?.reason || plan.reason || "已通过题材审核")}</small><footer><small>${plan.word_count} 个词 · 预计 ${plan.estimated_length} 词${plan.author ? ` · 作者 ${esc(plan.author)}` : ""}</small><div>${plan.url ? `<a class="btn-link" href="${esc(plan.url)}" target="_blank" rel="noreferrer">预览原文</a>` : ""}<button class="btn-primary" type="button" data-use-plan="${esc(plan.id)}">使用这篇生成</button></div></footer></article>`).join("")}`;
  }
  root.querySelector('[data-plan-action="back"]')?.addEventListener("click", () => { state.workflowError = null; setStage("words"); });
  root.querySelector('[data-plan-action="retry"]')?.addEventListener("click", matchZhihuCoverage);
  root.querySelectorAll("[data-use-plan]").forEach((button) => button.addEventListener("click", () => useCoveragePlan(button.dataset.usePlan)));
}

function planWordMarkup(plan) {
  const core = Array.isArray(plan.core_words) ? plan.core_words : [];
  const coreKeys = new Set(core.map((word) => String(word).toLowerCase()));
  const supporting = (Array.isArray(plan.supporting_words) && plan.supporting_words.length
    ? plan.supporting_words
    : (plan.words || []).filter((word) => !coreKeys.has(String(word).toLowerCase())));
  return `<div class="coverage-plan-words"><div class="coverage-word-row"><b>搜索关键词</b>${core.map((word) => `<span class="coverage-core-word">${esc(word)}</span>`).join("")}</div><div class="coverage-word-row"><b>文章覆盖词</b>${supporting.map((word) => `<span>${esc(word)}</span>`).join("")}</div></div>`;
}

async function matchZhihuCoverage() {
  const cards = cleanCards(recentMemoryCards(state.coverageDays));
  if (cards.length < 3) return toast(`近 ${state.coverageDays} 天至少需要 3 个学习单词`);
  state.workflowStage = "plan";
  state.coveragePlans = [];
  state.workflowError = null;
  renderWorkflow();
  try {
    const result = await Api.zhihuCoverage(cards, state.coverageDays);
    state.coveragePlans = result.plans || [];
    state.coverageStatus = result.coverage || null;
  } catch (error) {
    state.workflowError = error.data || { error: error.message, stage: "topic_planning" };
  }
  renderWorkflow();
}

function useCoveragePlan(id) {
  const plan = state.coveragePlans.find((item) => item.id === id);
  if (!plan) return;
  state.source = plan.source || "zhihu_search";
  state.sourceSelection = { content_id: plan.content_id, work_id: plan.work_id, title: plan.title, author: plan.author, summary: plan.summary, description: plan.summary, excerpt: plan.summary, digest: plan.digest || "", labels: plan.labels, url: plan.url, vote_up_count: plan.vote_up_count };
  state.selectedGroup = { id: plan.id, theme: plan.title, reason: plan.reason, coherence: .85, words: plan.words, core_words: plan.core_words || [], supporting_words: plan.supporting_words || [], estimated_length: plan.estimated_length, estimated_genre: "daily-science" };
  state.sliders.length = plan.estimated_length || 220;
  state.sliders.genre = "daily-science";
  state.sliders.tone = "clear";
  state.sliders.structure = "scene-explain";
  const length = $("#length-slider"); if (length) length.value = state.sliders.length;
  const lengthLabel = $("#length-val"); if (lengthLabel) lengthLabel.textContent = `约 ${state.sliders.length} 词`;
  setStage("compose");
}

function prepareCustom() {
  const cards = todayCards();
  if (cards.length < 3) return toast("今日自由创作至少勾选 3 个单词");
  state.source = "original";
  state.sourceSelection = null;
  state.selectedGroup = { id: "custom-today", theme: "用户自定义文章", reason: "使用今天勾选的目标词自由生成", coherence: 1, words: cards.slice(0, 20).map((card) => card.word), estimated_length: state.sliders.length, estimated_genre: state.customStyle.genre };
  state.originalTopic = $("#custom-article-topic")?.value.trim() || state.originalTopic;
  setStage("plan");
}

function renderCustomForm() {
  $("#custom-article-topic").value = state.originalTopic;
  $("#custom-article-genre").value = state.customStyle.genre;
  $("#custom-article-tone").value = state.customStyle.tone;
  $("#custom-article-structure").value = state.customStyle.structure;
  renderButton();
}

function customReady() {
  /* 中文 2 字即为有效主题（如「原神」），门槛过高会挡住自由创作 */
  return state.originalTopic.trim().length >= 2 && todayCards().length >= 3;
}

function saveCustomForm() {
  state.originalTopic = $("#custom-article-topic").value.trim();
  state.customStyle.genre = $("#custom-article-genre").value;
  state.customStyle.tone = $("#custom-article-tone").value;
  state.customStyle.structure = $("#custom-article-structure").value;
  state.sliders.genre = state.customStyle.genre;
  state.sliders.tone = state.customStyle.tone;
  state.sliders.structure = state.customStyle.structure;
  if (state.selectedGroup) state.selectedGroup.estimated_genre = state.customStyle.genre;
}

function renderSummary() {
  const root = $("#generation-summary");
  if (!root || state.workflowStage !== "compose" || !state.selectedGroup) return;
  const source = state.generationRoute === "zhihu" ? `知乎文章《${state.sourceSelection?.title || ""}》` : `原创主题：${state.originalTopic || "尚未填写"}`;
  root.innerHTML = `<strong>生成确认</strong><span>${state.selectedGroup.words.length} 个目标词 · 约 ${state.sliders.length} 词 · ${state.customStyle.genre === "daily-curiosity" ? "冷知识" : state.customStyle.genre === "light-entertainment" ? "轻娱乐观察" : "生活科普"}</span><small>${esc(source)}</small>`;
  root.classList.toggle("is-ready", state.generationRoute === "zhihu" || customReady());
}

async function generateArticle() {
  saveCustomForm();
  if (state.generationRoute === "custom" && !customReady()) return toast("请先填写文章主题（至少 2 个字符），并勾选 3 个以上单词");
  state.workflowStage = "generating";
  state.workflowError = null;
  generationController?.abort();
  generationController = new AbortController();
  renderWorkflow();
  try {
    await generateConfirmedArticle(generationController.signal);
    state.workflowStage = "result";
    state.resultMode = "reading";
  } catch (error) {
    if (error.name === "AbortError") return;
    state.workflowError = error.data || { error: error.message, stage: "generation", suggestions: [] };
  } finally {
    generationController = null;
  }
  renderWorkflow();
}

function backToPlan() {
  generationController?.abort();
  generationController = null;
  state.workflowError = null;
  state.workflowStage = state.generationRoute === "zhihu" ? "plan" : "plan";
  renderWorkflow();
}

function renderError() {
  const root = $("#workflow-error");
  if (!root) return;
  root.hidden = !state.workflowError;
  if (!state.workflowError) return;
  root.innerHTML = `<strong>${esc(state.workflowError.error || "文章生成失败")}</strong><div><button class="btn-ghost" type="button" data-generation-error="back">← 返回文章方案</button><button class="btn-primary" type="button" data-generation-error="retry">重试</button></div>`;
  root.querySelector('[data-generation-error="back"]')?.addEventListener("click", backToPlan);
  root.querySelector('[data-generation-error="retry"]')?.addEventListener("click", generateArticle);
}

function renderButton() {
  const button = $("#btn-generate"); if (!button) return;
  const label = button.querySelector("span:first-child");
  let text = state.generationRoute === "zhihu" ? "匹配知乎文章" : "下一步：自定义文章";
  let disabled = false;
  if (state.workflowStage === "plan") {
    if (state.generationRoute === "zhihu") { text = "请选择一篇知乎文章"; disabled = true; }
    else { text = "下一步：确认生成设置"; disabled = !customReady(); }
  } else if (state.workflowStage === "compose") {
    text = "生成文章";
    disabled = state.generationRoute === "custom" && !customReady();
  } else if (state.workflowStage === "generating") { text = "正在生成文章…"; disabled = true; }
  else if (state.workflowStage === "result") text = "开始练习";
  if (label) label.textContent = text;
  button.disabled = disabled || state.generating;
}

function primaryAction() {
  if (state.workflowStage === "words") {
    if (state.generationRoute === "zhihu") matchZhihuCoverage(); else prepareCustom();
  } else if (state.workflowStage === "plan" && state.generationRoute === "custom") {
    saveCustomForm(); setStage("compose");
  } else if (state.workflowStage === "compose") generateArticle();
  else if (state.workflowStage === "result") setResultMode("practice");
}

export function renderWorkflow() {
  renderSteps(); renderRouteOptions();
  document.querySelectorAll("[data-generation-route]").forEach((button) => (button.disabled = state.workflowStage === "generating"));
  document.querySelectorAll("[data-workflow-panel]").forEach((panel) => panel.hidden = panel.dataset.workflowPanel !== state.workflowStage);
  $("#coverage-plan-panel").hidden = !(state.workflowStage === "plan" && state.generationRoute === "zhihu");
  $("#custom-plan-panel").hidden = !(state.workflowStage === "plan" && state.generationRoute === "custom");
  if (state.workflowStage === "plan" && state.generationRoute === "zhihu") renderPlans();
  if (state.workflowStage === "plan" && state.generationRoute === "custom") renderCustomForm();
  if (state.workflowStage === "compose") renderSummary();
  if (state.workflowStage === "generating") renderError();
  if (state.workflowStage === "result") setResultMode(state.resultMode);
  renderButton();
}

export function bindWorkflowEvents() {
  $("#btn-generate")?.addEventListener("click", primaryAction);
  document.querySelectorAll("[data-generation-route]").forEach((button) => button.addEventListener("click", () => setRoute(button.dataset.generationRoute)));
  document.querySelectorAll("[data-coverage-days]").forEach((button) => button.addEventListener("click", () => { state.coverageDays = Number(button.dataset.coverageDays) === 7 ? 7 : 3; state.memoryScope = "recent_3d"; renderWorkflow(); }));
  $("#btn-refresh-coverage")?.addEventListener("click", matchZhihuCoverage);
  $("#btn-back-route")?.addEventListener("click", () => setStage("words"));
  $("#btn-back-custom-route")?.addEventListener("click", () => setStage("words"));
  $("#btn-back-compose")?.addEventListener("click", backToPlan);
  $("#btn-back-generating")?.addEventListener("click", backToPlan);
  ["custom-article-topic", "custom-article-genre", "custom-article-tone", "custom-article-structure"].forEach((id) => $("#" + id)?.addEventListener("input", () => { saveCustomForm(); renderSummary(); renderButton(); }));
  document.querySelectorAll("[data-result-action]").forEach((button) => button.addEventListener("click", () => { if (button.dataset.resultAction === "back") backToPlan(); else generateArticle(); }));
  window.addEventListener("bookwords:pool-change", resetWorkflow);
  renderWorkflow();
}
