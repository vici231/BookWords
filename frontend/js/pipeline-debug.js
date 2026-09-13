const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const SAMPLE_WORDS = [
  { word: "context", pos: "n.", meaning_cn: "语境", level: "CET4" },
  { word: "insight", pos: "n.", meaning_cn: "洞见", level: "CET6" },
  { word: "evidence", pos: "n.", meaning_cn: "证据", level: "CET4" },
  { word: "perspective", pos: "n.", meaning_cn: "视角", level: "CET6" },
  { word: "adapt", pos: "v.", meaning_cn: "适应", level: "CET4" },
  { word: "sustain", pos: "v.", meaning_cn: "维持", level: "CET6" },
  { word: "subtle", pos: "adj.", meaning_cn: "微妙的", level: "CET6" },
  { word: "reliable", pos: "adj.", meaning_cn: "可靠的", level: "CET4" },
  { word: "emerge", pos: "v.", meaning_cn: "出现", level: "CET4" },
];

const state = { result: null, language: "en", stepTimer: null };

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function markdown(value) {
  const safe = esc(value);
  return safe.replace(/\*\*([^*]+)\*\*/g, "<mark>$1</mark>");
}

function textLines(value) {
  return markdown(value).replace(/\r?\n/g, "<br>");
}

/* 本机凭证：与主应用共用 localStorage 键 wj-credentials，
   随请求头发给后端（后端只在本次请求内使用，不落盘）。 */
function credentialHeaders() {
  try {
    const cred = JSON.parse(localStorage.getItem("wj-credentials") || "null") || {};
    const headers = {};
    if (cred.api_key) headers["X-AI-Key"] = cred.api_key;
    if (cred.base_url) headers["X-AI-Base-URL"] = cred.base_url;
    if (cred.model) headers["X-AI-Model"] = cred.model;
    if (cred.access_secret) headers["X-Zhihu-Secret"] = cred.access_secret;
    return headers;
  } catch (error) {
    return {};
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...credentialHeaders(), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `请求失败（${response.status}）`);
    error.data = data;
    throw error;
  }
  return data;
}

function setMessage(message, error = false) {
  const node = $("#run-message");
  node.textContent = message;
  node.classList.toggle("is-error", error);
}

function setBadge(node, fallback, successText = "正常完成") {
  node.className = `result-badge ${fallback ? "is-fallback" : "is-success"}`;
  node.textContent = fallback ? "Fallback 成功" : successText;
}

function wordPills(words) {
  const values = Array.isArray(words) ? words : [];
  return values.map((word) => `<b>${esc(typeof word === "object" ? word.word : word)}</b>`).join("");
}

function parseWords(raw) {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    for (const key of ["words", "items", "entries", "wordbook", "data"]) {
      if (Array.isArray(parsed?.[key])) return parsed[key];
    }
    throw new Error("JSON 中没有可识别的词条数组");
  }
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function loadWordbook() {
  let words;
  try {
    words = JSON.parse(localStorage.getItem("wj-wordbook") || "[]");
  } catch {
    setMessage("主应用单词本数据已损坏，无法解析。", true);
    return;
  }
  if (!Array.isArray(words) || !words.length) {
    setMessage("主应用单词本为空，可先使用示例词条。", true);
    return;
  }
  $("#word-input").value = JSON.stringify(words, null, 2);
  $("#import-source").value = "local_wordbook";
  setMessage(`已从主应用载入 ${words.length} 个词条。`);
}

function loadSample() {
  $("#word-input").value = JSON.stringify(SAMPLE_WORDS, null, 2);
  $("#import-source").value = "manual";
  $("#topic-constraint").value = "真实信息如何帮助我们形成可靠判断";
  setMessage("已载入 9 个示例词条。未配置模型时也可观察 fallback 全链路。");
}

function sourceId(item) {
  return item?.content_id || item?.work_id || item?.id || item?.object_id || item?.target?.id || "";
}

function sourceTitle(item) {
  return item?.title || item?.chapter_name || item?.name || item?.question?.title || item?.target?.title || "";
}

function sourceSummary(item) {
  return item?.summary || item?.excerpt || item?.description || item?.content || item?.target?.excerpt || "";
}

async function loadZhihu() {
  const source = $("#content-source").value;
  const button = $("#load-zhihu");
  if (source !== "zhihu_search") return;
  const query = $("#topic-constraint").value.trim() || "英语学习 日常知识";
  button.disabled = true;
  setMessage("正在读取知乎素材…");
  try {
    const data = await request(`/api/zhihu/search?q=${encodeURIComponent(query)}&limit=10`);
    const item = Array.isArray(data.items) ? data.items[0] : null;
    if (!item) throw new Error("当前来源没有可用素材");
    const id = sourceId(item);
    const title = sourceTitle(item);
    $("#source-id").value = id;
    $("#source-title").value = title;
    $("#source-summary").value = sourceSummary(item);
    const tags = item.labels || item.tags || [];
    $("#source-tags").value = Array.isArray(tags) ? tags.join(", ") : "";
    if (!$("#topic-constraint").value.trim()) $("#topic-constraint").value = title;
    setMessage(`已载入一条知乎素材（${item.vote_up_count || 0} 赞）。`);
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function sourcePayload() {
  const source = $("#content-source").value;
  const title = $("#source-title").value.trim() || $("#topic-constraint").value.trim();
  const summary = $("#source-summary").value.trim();
  const workId = $("#source-id").value.trim();
  const tags = $("#source-tags").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
  if (source === "zhihu_search") return { content_id: workId };
  return { title, summary, tags, answer_outline: summary };
}

function resetSteps() {
  clearInterval(state.stepTimer);
  $$(".pipeline-track span").forEach((node) => node.classList.remove("is-running", "is-done"));
}

function animateSteps() {
  resetSteps();
  const steps = $$(".pipeline-track span");
  let index = 0;
  steps[0]?.classList.add("is-running");
  state.stepTimer = setInterval(() => {
    steps[index]?.classList.remove("is-running");
    steps[index]?.classList.add("is-done");
    index = Math.min(index + 1, steps.length - 1);
    steps[index]?.classList.add("is-running");
  }, 700);
}

function finishSteps() {
  clearInterval(state.stepTimer);
  $$(".pipeline-track span").forEach((node) => {
    node.classList.remove("is-running");
    node.classList.add("is-done");
  });
}

function renderImport(data) {
  $("#import-badge").className = `result-badge ${data.anomaly_count ? "is-fallback" : "is-success"}`;
  $("#import-badge").textContent = data.anomaly_count ? `${data.anomaly_count} 个异常` : "全部有效";
  $("#import-summary").innerHTML = `来源：<strong>${esc(data.source)}</strong> · 原始 ${esc(data.raw_count)} 条 · 有效 ${esc(data.valid_count)} 条 · 异常 ${esc(data.anomaly_count)} 条`;
  $("#import-words").innerHTML = (data.valid_entries || []).map((item) => `<span title="${esc(item.meaning_cn || item.meaning_en)}">${esc(item.word)}</span>`).join("");
  const tbody = $("#import-anomalies tbody");
  tbody.innerHTML = (data.anomalies || []).length
    ? data.anomalies.map((item) => `<tr><td>${esc(Number(item.index) + 1)}</td><td>${esc(item.value)}</td><td>${esc(item.reason)}</td></tr>`).join("")
    : '<tr><td colspan="3">没有异常项</td></tr>';
}

function renderSorting(data, metric) {
  setBadge($("#sort-state"), Boolean(metric?.fallback));
  $("#semantic-clusters").innerHTML = (data.semantic_clusters || []).map((item) =>
    `<article><strong>${esc(item.theme)}</strong><div>${wordPills(item.words)}</div></article>`).join("") || "暂无数据";
  const labels = { foundation: "基础", intermediate: "进阶", advanced: "高阶" };
  $("#difficulty-layers").innerHTML = Object.entries(labels).map(([key, label]) =>
    `<section><strong>${label}</strong><div>${wordPills(data.difficulty_layers?.[key]) || "暂无"}</div></section>`).join("");
  $("#cooccurrence").innerHTML = (data.cooccurrence || []).map((item) =>
    `<article><strong>${esc((item.words || []).join(" + "))}</strong><p>${esc(item.reason)}</p></article>`).join("") || "暂无关系";
  $("#optimal-groups").innerHTML = (data.optimal_groups || []).map((item) =>
    `<article><strong>${esc(item.id)} · ${esc(item.theme)}</strong><div>${wordPills(item.words)}</div><p>${esc(item.reason)}</p></article>`).join("") || "暂无分组";
}

function renderLanguageContent() {
  if (!state.result) return;
  const language = state.language;
  const story = state.result.story;
  const daily = state.result.daily;
  $("#story-title").textContent = story.title;
  $("#story-content").innerHTML = textLines(language === "zh" ? story.zh : story.en);
  $("#daily-output").innerHTML = `
    <h3>${esc(daily.title)}</h3>
    <p>${esc(daily.date)} · ${esc(language === "zh" ? "中文" : "英文")} · ${esc((daily.word_set || []).join(", "))}</p>
    <p>${textLines(language === "zh" ? daily.content_zh : daily.content_en)}</p>
    <small>${esc(daily.source_note || "来源：AI 原创生成｜Bookwords 英语学习材料")}</small>`;
  $("#story-meta").innerHTML = `输入词集：${esc(story.input_words.join(", "))} · Prompt：<code>${esc(story.prompt_version)}</code> · 当前呈现：${language === "zh" ? "中文" : "英文"}`;
}

function renderDigest(result, metric) {
  setBadge($("#digest-state"), Boolean(metric?.fallback));
  const weekly = result.weekly || {};
  const monthly = result.monthly || {};
  const weeklyThemes = (weekly.themes || []).map((item) => `${esc(item.name)}：${esc((item.words || []).join(", "))}`).join("<br>");
  const monthlyThemes = (monthly.candidate_themes || []).map(esc).join(" · ");
  $("#digest-output").innerHTML = `
    <div class="digest-block"><h3>${esc(weekly.title || "周刊")}</h3><p>${esc(weekly.format || "")}</p><p>${esc(weekly.summary || "")}</p><p>${weeklyThemes}</p></div>
    <div class="digest-block"><h3>${esc(monthly.title || "月刊")}</h3><p>${esc(monthly.format || "")}</p><p>${esc(monthly.summary || "")}</p><p>${monthlyThemes}</p></div>`;
}

function renderResult(result) {
  state.result = result;
  state.language = result.language?.selected === "zh" ? "zh" : "en";
  const selected = $(`input[name="language"][value="${state.language}"]`);
  if (selected) selected.checked = true;
  $("#observer-empty").hidden = true;
  $("#observer-results").hidden = false;
  $("#run-id").textContent = result.run_id;
  const metrics = result.metrics || [];
  const totalTokens = metrics.reduce((sum, item) => sum + Number(item.total_tokens || 0), 0);
  const elapsed = metrics.reduce((sum, item) => sum + Number(item.elapsed_ms || 0), 0);
  const fallbacks = metrics.filter((item) => item.fallback).length;
  $("#run-stats").innerHTML = [
    ["有效词条", result.import.valid_count],
    ["LLM Token", totalTokens],
    ["累计耗时", `${elapsed} ms`],
    ["Fallback", fallbacks],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${esc(value)}</strong></div>`).join("");
  renderImport(result.import);
  renderSorting(result.sorting, metrics[0]);
  setBadge($("#story-state"), Boolean(result.story.fallback), result.story.mode === "article" ? "文章生成" : "已生成");
  $("#daily-status").className = `result-badge ${result.daily.status === "success" ? "is-success" : "is-fallback"}`;
  $("#daily-status").textContent = result.daily.status === "success" ? "生成完成" : "降级完成";
  renderLanguageContent();
  renderDigest(result, metrics[2]);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

async function refreshCalls() {
  try {
    const data = await request("/api/debug/llm-calls?limit=100");
    const calls = data.calls || [];
    $("#calls-body").innerHTML = calls.length ? calls.map((item) => {
      const status = item.cache_hit ? "cache" : item.fallback ? "fallback" : item.status || "success";
      const label = item.cache_hit ? "缓存命中" : item.fallback ? "Fallback" : item.status === "error" ? "错误" : "成功";
      const tokens = `${esc(item.input_tokens || 0)} / ${esc(item.output_tokens || 0)} / ${esc(item.total_tokens || 0)}${item.estimated_tokens ? " *" : ""}`;
      return `<tr title="${esc(item.reason || "")}"><td><code>${esc(item.skill)}</code></td><td><code>${esc(item.prompt_version)}</code></td><td>${esc(item.model)}</td><td>${tokens}</td><td>${esc(item.elapsed_ms || 0)} ms</td><td><span class="call-status ${esc(status)}">${label}</span></td><td>${esc(formatDate(item.started_at))}</td></tr>`;
    }).join("") : '<tr><td colspan="7">暂无记录</td></tr>';
  } catch (error) {
    $("#calls-body").innerHTML = `<tr><td colspan="7">${esc(error.message)}</td></tr>`;
  }
}

async function runPipeline() {
  let words;
  try {
    words = parseWords($("#word-input").value);
  } catch (error) {
    setMessage(`词条解析失败：${error.message}`, true);
    return;
  }
  if (words.length < 3) {
    setMessage("至少需要 3 个词条才能运行。", true);
    return;
  }
  const source = $("#content-source").value;
  const payload = {
    words,
    import_source: $("#import-source").value,
    language: state.language,
    source,
    source_payload: sourcePayload(),
  };
  if (source !== "original" && !payload.source_payload.content_id) {
    setMessage("请先搜索并载入一条知乎素材。", true);
    return;
  }
  const button = $("#run-pipeline");
  button.disabled = true;
  animateSteps();
  setMessage("链路运行中；模型不可用时会自动进入各 Skill 的 fallback。 ");
  try {
    const result = await request("/api/debug/pipeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    finishSteps();
    renderResult(result);
    const fallbackCount = (result.metrics || []).filter((item) => item.fallback).length;
    setMessage(`运行完成：${fallbackCount ? `${fallbackCount} 个 Skill 使用 fallback` : "全部 Skill 正常完成"}。`);
  } catch (error) {
    resetSteps();
    setMessage(`运行失败：${error.message}`, true);
    if (error.data?.import) renderImport(error.data.import);
  } finally {
    button.disabled = false;
    refreshCalls();
  }
}

async function clearCalls() {
  try {
    await request("/api/debug/llm-calls", { method: "DELETE" });
    await refreshCalls();
  } catch (error) {
    setMessage(`清空记录失败：${error.message}`, true);
  }
}

async function loadStatus() {
  try {
    const data = await request("/api/mode");
    const node = $("#model-status");
    node.textContent = data.available ? data.display || "AI 已连接" : data.label || "未配置模型";
    node.classList.add(data.available ? "is-ready" : "is-offline");
  } catch {
    $("#model-status").textContent = "服务未连接";
    $("#model-status").classList.add("is-offline");
  }
}

function bind() {
  $("#load-wordbook").addEventListener("click", loadWordbook);
  $("#load-sample").addEventListener("click", loadSample);
  $("#load-zhihu").addEventListener("click", loadZhihu);
  $("#run-pipeline").addEventListener("click", runPipeline);
  $("#refresh-calls").addEventListener("click", refreshCalls);
  $("#clear-calls").addEventListener("click", clearCalls);
  $("#content-source").addEventListener("change", (event) => {
    $("#zhihu-fields").hidden = event.target.value === "original";
  });
  $$('input[name="language"]').forEach((input) => input.addEventListener("change", (event) => {
    state.language = event.target.value;
    renderLanguageContent();
  }));
}

bind();
loadStatus();
refreshCalls();
loadWordbook();
if (!$("#word-input").value.trim()) loadSample();
