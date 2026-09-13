/* views/settings.js — 系统设置：本机凭证（API Key / 知乎 Access Secret）+ 视觉风格。

   凭证策略：用户在设置页自己填，只写入浏览器 localStorage，随请求头临时发给
   服务端使用（服务端不落盘、不回显）。因此仓库与部署包里不含任何真实凭证，
   别人 clone 下来填自己的即可。 */

import { Api } from "../api.js";
import { state, emit } from "../state.js";
import { persistSettingsStamp, loadCredentials, saveCredentials } from "../store.js";
import { $, formatStamp, toast } from "../utils.js";

function syncThemeButtons() {
  document.querySelectorAll(".theme-btn").forEach((b) => b.classList.toggle("active", b.dataset.theme === state.theme));
}

function mask(value, head = 4, tail = 4) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= head + tail) return "已填写";
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function credentialStatus() {
  const cred = state.credentials || {};
  const parts = [];
  parts.push(cred.api_key ? `API Key ${mask(cred.api_key)}` : "未填 API Key");
  parts.push(cred.access_secret ? `知乎 Secret ${mask(cred.access_secret, 4, 4)}` : "未填知乎 Secret");
  if (cred.base_url) parts.push(`Base URL ${cred.base_url}`);
  if (cred.model) parts.push(`模型 ${cred.model}`);
  return parts.join(" · ");
}

export function renderCredentialForm() {
  const cred = state.credentials || {};
  if ($("#cfg-api-base")) $("#cfg-api-base").value = cred.base_url || "";
  if ($("#cfg-api-key")) $("#cfg-api-key").value = cred.api_key || "";
  if ($("#cfg-api-model")) $("#cfg-api-model").value = cred.model || "";
  if ($("#cfg-zhihu-secret")) $("#cfg-zhihu-secret").value = cred.access_secret || "";
  if ($("#cfg-credential-status")) {
    $("#cfg-credential-status").textContent = (cred.api_key || cred.access_secret)
      ? `已保存到本机：${credentialStatus()}`
      : "尚未配置：填写后点「保存到本机」";
  }
}

function readCredentialForm() {
  return {
    base_url: $("#cfg-api-base") ? $("#cfg-api-base").value.trim() : "",
    api_key: $("#cfg-api-key") ? $("#cfg-api-key").value.trim() : "",
    model: $("#cfg-api-model") ? $("#cfg-api-model").value.trim() : "",
    access_secret: $("#cfg-zhihu-secret") ? $("#cfg-zhihu-secret").value.trim() : "",
  };
}

function saveCredentialsFromForm() {
  const next = saveCredentials(readCredentialForm());
  renderCredentialForm();
  emit("credentials");
  toast(next.api_key || next.access_secret ? "已保存到本机浏览器" : "已清空本机凭证");
  return next;
}

async function testCredentials() {
  const status = $("#cfg-credential-status");
  if (status) status.textContent = "正在测试…";
  try {
    const result = await Api.testAiConfig({});
    if (status) status.textContent = `连接正常：${result.provider_name || result.provider || ""} ${result.model || ""}`.trim();
    toast("模型连接正常");
  } catch (err) {
    if (status) status.textContent = `连接失败：${err.message}`;
    toast("连接失败：" + err.message);
  }
}

export function applySettings(res) {
  state.settings = res;
  state.theme = res.theme || "paper";
  document.body.dataset.theme = state.theme;
  syncThemeButtons();
}

async function saveTheme(theme) {
  state.theme = theme;
  document.body.dataset.theme = theme;
  syncThemeButtons();
  try {
    const res = await Api.saveConfig({ theme });
    applySettings(res);
    persistSettingsStamp();
    if ($("#settings-updated-at")) $("#settings-updated-at").textContent = state.settingsUpdatedAt ? `最近更新：${formatStamp(state.settingsUpdatedAt) || "时间未知"}` : "尚未保存过设置";
    toast("风格已保存");
  } catch (err) {
    toast("风格已本地生效，保存失败：" + err.message);
  }
}

export function openSettings() {
  if ($("#settings-updated-at")) $("#settings-updated-at").textContent = state.settingsUpdatedAt ? `最近更新：${formatStamp(state.settingsUpdatedAt) || "时间未知"}` : "尚未保存过设置";
  loadCredentials();
  renderCredentialForm();
  syncThemeButtons();
  $("#settings-modal").hidden = false;
}

export function bindSettingsEvents() {
  $("#btn-settings").addEventListener("click", openSettings);
  $("#sidebar-settings").addEventListener("click", openSettings);
  $("#btn-close-settings").addEventListener("click", () => ($("#settings-modal").hidden = true));
  $("#settings-modal").addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") $("#settings-modal").hidden = true;
  });
  document.querySelectorAll(".theme-btn").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.theme !== state.theme) saveTheme(b.dataset.theme);
    })
  );
  $("#btn-save-credentials")?.addEventListener("click", () => saveCredentialsFromForm());
  $("#btn-test-credentials")?.addEventListener("click", () => {
    saveCredentialsFromForm();
    testCredentials();
  });
  $("#btn-clear-credentials")?.addEventListener("click", () => {
    saveCredentials({ base_url: "", api_key: "", model: "", access_secret: "" });
    renderCredentialForm();
    emit("credentials");
    toast("已清除本机凭证");
  });
  renderCredentialForm();
}
