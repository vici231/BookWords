/* views/settings.js — 系统设置：AI 接口（供应商/模型/Key）+ 知乎 Secret + 主题。
   供应商目录与识别规则由 /api/meta 下发（前后端单一来源，不再双份硬编码）。 */

import { Api } from "../api.js";
import { state } from "../state.js";
import { clearLocalUserData, persistSettingsStamp } from "../store.js";
import { $, esc, formatStamp, toast } from "../utils.js";
import { setSource } from "./source.js";
import { renderStoryPoolView } from "./pool.js";
import { renderDaily } from "./daily.js";
import { renderProfile } from "./profile.js";

/* 设置弹窗内 API Key 的编辑状态：
   false + 输入框为空 = 用户没动 Key，保存时省略该字段（保持原 Key）；
   true（点了「清除 Key」）= 保存时显式提交空串清除。 */
let keyCleared = false;
let zhihuSecretCleared = false;
const MOBILE_LAYOUT_KEY = "wj-mobile-layout-preview";

function applyMobileLayoutPreview(enabled) {
  document.body.classList.toggle("force-mobile-layout", Boolean(enabled));
}

function storedMobileLayoutPreview() {
  try { return localStorage.getItem(MOBILE_LAYOUT_KEY) === "1"; } catch (e) { return false; }
}

function providerById(id) {
  return state.providers.find((p) => p.id === id) || null;
}

function detectProviderId(base_url, model) {
  const b = (base_url || "").toLowerCase();
  const m = (model || "").toLowerCase();
  for (const [token, id] of state.providerRules.tokens || []) {
    if (b.includes(token)) return id;
  }
  for (const [prefix, id] of state.providerRules.modelPrefixes || []) {
    if (m.startsWith(prefix)) return id;
  }
  return "custom";
}

function syncThemeButtons() {
  document.querySelectorAll(".theme-btn").forEach((b) => b.classList.toggle("active", b.dataset.theme === state.theme));
}

export function applySettings(res) {
  state.settings = res;
  state.theme = res.theme || "paper";
  document.body.dataset.theme = state.theme;
  syncThemeButtons();
}

function buildProviderOptions() {
  const sel = $("#cfg-provider");
  sel.innerHTML = '<option value="">—— 选择 / 识别供应商 ——</option>' +
    state.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
}

function showCustomModel(show, value = "") {
  /* 切换「自定义模型」输入框显隐（修复旧版从不显示的缺陷）；绝不触碰用户资料 */
  const wrap = $("#cfg-model-custom-wrap");
  if (wrap) wrap.hidden = !show;
  const box = $("#cfg-model-custom");
  if (show && box) {
    box.value = value;
    box.focus();
  }
}

function renderModelOptions(providerId, currentModel) {
  const sel = $("#cfg-model");
  const models = state.fetchedModels || [];
  if (!models.length) {
    sel.innerHTML = '<option value="">（暂无模型，请点「获取可用模型」或自定义）</option>';
    sel.value = "";
    showCustomModel(true, currentModel || "");
    return;
  }
  let html = models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  const saved = currentModel && !models.includes(currentModel) ? currentModel : "";
  if (saved) html += `<option value="${esc(saved)}">${esc(saved)}（已保存）</option>`;
  html += `<option value="__custom__">自定义模型…</option>`;
  sel.innerHTML = html;
  if (saved) {
    sel.value = saved; showCustomModel(false);
  } else if (currentModel && models.includes(currentModel)) {
    sel.value = currentModel; showCustomModel(false);
  } else {
    sel.value = models[0]; showCustomModel(false);
  }
}

function getModelValue() {
  const sel = $("#cfg-model");
  const v = sel.value;
  if (v === "__custom__" || v === "") return $("#cfg-model-custom").value.trim();
  return v;
}

function updateDetectHint(base_url, model) {
  const el = $("#cfg-detect");
  const id = detectProviderId(base_url, model);
  const p = providerById(id);
  if (id === "custom") {
    el.textContent = base_url ? "识别为：自定义 OpenAI 兼容接口（模型需实时获取）" : "未识别到内置供应商，可自定义";
    el.className = "cfg-detect";
  } else {
    el.textContent = `识别为：${p ? p.name : id}（模型来自接口实时查询）`;
    el.className = "cfg-detect ok";
  }
}

function syncProviderDropdown(base_url, model) {
  const id = detectProviderId(base_url, model);
  $("#cfg-provider").value = id;
  renderModelOptions(id, model || "");
  updateDetectHint(base_url, model || getModelValue());
}

export function openSettings() {
  const api = state.settings.api || {};
  keyCleared = false;
  buildProviderOptions();
  const baseUrl = api.base_url || "";
  const model = api.model || "";
  const providerId = baseUrl ? detectProviderId(baseUrl, model) : "deepseek";
  const pDefault = providerById(providerId) || providerById("deepseek") || { base_url: "" };
  $("#cfg-base-url").value = baseUrl || pDefault.base_url || "";
  $("#cfg-provider").value = providerId;
  syncProviderDropdown($("#cfg-base-url").value, model);
  $("#cfg-api-key").value = "";
  $("#cfg-api-key").placeholder = api.has_key ? "已保存 Key，输入新 Key 可替换" : "未配置 API Key（可选）";
  const hasKey = !!api.has_key;
  $("#btn-clear-key").hidden = !hasKey;
  $("#cfg-key-note").textContent = hasKey
    ? `当前已保存 Key：${api.api_key_masked}；留空保存 = 保持不变`
    : "未配置 API Key，文章生成功能暂不可用";
  $("#cfg-test-result").textContent = "";
  $("#cfg-test-result").className = "";
  $("#cfg-model-status").textContent = "";
  $("#cfg-model-status").className = "cfg-detect";
  const zh = state.settings.zhihu || {};
  zhihuSecretCleared = false;
  $("#cfg-zhihu-secret").value = "";
  $("#cfg-zhihu-secret").placeholder = zh.has_secret ? "已保存 Secret，输入新值可替换" : "未配置 Access Secret（可选）";
  $("#btn-clear-zhihu").hidden = !zh.has_secret;
  $("#cfg-zhihu-note").textContent = zh.has_secret
    ? `当前已保存 Secret：${zh.access_secret_masked}；留空保存 = 保持不变`
    : "未配置 Access Secret（知乎搜索与热榜暂不可用）";
  if ($("#settings-updated-at")) $("#settings-updated-at").textContent = state.settingsUpdatedAt ? `最近更新：${formatStamp(state.settingsUpdatedAt) || "时间未知"}` : "尚未保存过设置";
  syncThemeButtons();
  if ($("#cfg-mobile-layout")) $("#cfg-mobile-layout").checked = storedMobileLayoutPreview();
  $("#settings-modal").hidden = false;
  if (hasKey) fetchModels();
}

async function fetchModels() {
  const baseUrl = $("#cfg-base-url").value.trim();
  const key = $("#cfg-api-key").value.trim();
  const el = $("#cfg-model-status");
  if (!baseUrl) { el.textContent = "先填写 Base URL"; el.className = "cfg-detect"; return; }
  el.textContent = "查询中…";
  el.className = "cfg-detect";
  try {
    const res = await Api.models({ api: { base_url: baseUrl, api_key: key, model: "" } });
    if (res.ok && Array.isArray(res.models) && res.models.length) {
      state.fetchedModels = res.models;
      renderModelOptions($("#cfg-provider").value, getModelValue() || "");
      el.textContent = `${res.message} — 已按 Key 实时获取。`;
      el.className = "cfg-detect ok";
    } else {
      state.fetchedModels = [];
      renderModelOptions($("#cfg-provider").value, getModelValue() || "");
      el.textContent = "获取失败：" + (res.message || "未返回模型");
      el.className = "cfg-detect";
    }
  } catch (err) {
    state.fetchedModels = [];
    renderModelOptions($("#cfg-provider").value, getModelValue() || "");
    el.textContent = "获取失败：" + err.message;
    el.className = "cfg-detect";
  }
}

async function saveSettings() {
  const api = {
    base_url: $("#cfg-base-url").value.trim(),
    model: getModelValue(),
  };
  const keyVal = $("#cfg-api-key").value.trim();
  if (keyVal) api.api_key = keyVal;
  else if (keyCleared) api.api_key = "";
  const payload = { api, theme: state.theme };
  const zhihu = {};
  const zhVal = $("#cfg-zhihu-secret").value.trim();
  if (zhVal) zhihu.access_secret = zhVal;
  else if (zhihuSecretCleared) zhihu.access_secret = "";
  if (Object.keys(zhihu).length) payload.zhihu = zhihu;
  try {
    const res = await Api.saveConfig(payload);
    applySettings(res);
    persistSettingsStamp();
    const mobilePreview = Boolean($("#cfg-mobile-layout")?.checked);
    try { localStorage.setItem(MOBILE_LAYOUT_KEY, mobilePreview ? "1" : "0"); } catch (e) { /* 本地预览失败不影响设置保存 */ }
    applyMobileLayoutPreview(mobilePreview);
    $("#settings-modal").hidden = true;
    toast("设置已保存");
  } catch (err) {
    toast("保存失败：" + err.message);
  }
}

async function clearLocalData() {
  if (!window.confirm("确定清除所有已保存数据吗？\n\n将移除 API Key，并清空本周词汇池。\n此操作不可撤销。")) return;
  try {
    const res = await Api.resetConfig();
    applySettings(res);
    clearLocalUserData();
    renderStoryPoolView();
    renderDaily();
    renderProfile();
    setSource("original");
    $("#settings-modal").hidden = true;
    toast("已清除全部保存数据（含 API Key）");
  } catch (err) {
    toast("清除失败：" + err.message);
  }
}

async function testAI() {
  const el = $("#cfg-test-result");
  el.textContent = "测试中…";
  el.className = "";
  const payload = {
    api: {
      base_url: $("#cfg-base-url").value.trim(),
      api_key: $("#cfg-api-key").value.trim(),
      model: getModelValue(),
    },
  };
  try {
    const res = await Api.health(payload);
    if (res.available) {
      el.textContent = `连接成功 · ${res.provider_name || res.provider || "OpenAI 兼容"} · ${res.model || ""}`;
      el.className = "test-ok";
    } else {
      el.textContent = res.message || "未提供 API Key";
      el.className = "test-warn";
    }
  } catch (err) {
    el.textContent = "测试失败：" + err.message;
    el.className = "test-warn";
  }
}

export function bindSettingsEvents() {
  applyMobileLayoutPreview(storedMobileLayoutPreview());
  $("#btn-settings").addEventListener("click", openSettings);
  $("#sidebar-settings").addEventListener("click", openSettings);
  $("#btn-close-settings").addEventListener("click", () => ($("#settings-modal").hidden = true));
  $("#btn-cancel-config").addEventListener("click", () => ($("#settings-modal").hidden = true));
  $("#settings-modal").addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") $("#settings-modal").hidden = true;
  });
  $("#btn-save-config").addEventListener("click", saveSettings);
  $("#btn-test-ai").addEventListener("click", testAI);
  $("#btn-clear-data").addEventListener("click", clearLocalData);
  $("#btn-fetch-models").addEventListener("click", fetchModels);

  $("#cfg-provider").addEventListener("change", () => {
    const id = $("#cfg-provider").value;
    const p = providerById(id);
    if (p && p.base_url) {
      $("#cfg-base-url").value = p.base_url;
      syncProviderDropdown(p.base_url, "");
    } else {
      renderModelOptions(id, "");
      updateDetectHint($("#cfg-base-url").value, getModelValue());
    }
  });
  $("#cfg-base-url").addEventListener("input", () => {
    syncProviderDropdown($("#cfg-base-url").value, getModelValue());
  });
  $("#cfg-model").addEventListener("change", () => {
    showCustomModel($("#cfg-model").value === "__custom__");
    updateDetectHint($("#cfg-base-url").value, getModelValue());
  });
  $("#cfg-model-custom").addEventListener("input", () => {
    updateDetectHint($("#cfg-base-url").value, getModelValue());
  });

  $("#btn-clear-key").addEventListener("click", () => {
    keyCleared = true;
    $("#cfg-api-key").value = "";
    $("#cfg-key-note").textContent = "将清除已保存的 Key";
    $("#btn-clear-key").hidden = true;
    $("#cfg-api-key").focus();
  });
  $("#btn-clear-zhihu").addEventListener("click", () => {
    zhihuSecretCleared = true;
    $("#cfg-zhihu-secret").value = "";
    $("#cfg-zhihu-note").textContent = "将清除已保存的 Secret";
    $("#btn-clear-zhihu").hidden = true;
    $("#cfg-zhihu-secret").focus();
  });
  document.querySelectorAll(".theme-btn").forEach((b) =>
    b.addEventListener("click", () => {
      state.theme = b.dataset.theme;
      document.body.dataset.theme = state.theme;
      syncThemeButtons();
    })
  );
  $("#cfg-mobile-layout")?.addEventListener("change", (event) => {
    const enabled = event.target.checked;
    try { localStorage.setItem(MOBILE_LAYOUT_KEY, enabled ? "1" : "0"); } catch (e) { /* 本地预览失败不阻塞界面切换 */ }
    applyMobileLayoutPreview(enabled);
  });
}
