/* settings.js — 统一设置存取（api / zhihu / theme）。
   凭证来源两条，优先级从高到低：
   1) 请求携带的「本机配置」：前端把用户在自己浏览器里填的 key/secret 放在请求头
      （X-AI-Key / X-AI-Base-URL / X-AI-Model / X-Zhihu-Secret）随请求发来。
      服务端只在这次请求内使用，**不落盘、不回显、不写日志**。
   2) data/settings.json 启动种子（可选、只读加载）。仓库与部署包默认不含真实凭证，
      没有该文件就只是「未配置」，页面会提示用户在本机设置里填写。
   运行期改动只保存在进程内存；AI Works 平台文件系统只读，不做磁盘写入。
   对外只回脱敏视图，明文密钥不出后端。 */

const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");

const STORE_PATH = path.join(__dirname, "..", "data", "settings.json");

const DEFAULT_SETTINGS = {
  api: { base_url: "https://api.deepseek.com", api_key: "", model: "" },
  zhihu: { access_secret: "" },
  theme: "paper",
};
const THEMES = ["paper", "ink"];

/* 每次请求的凭证上下文：server.js 的中间件用 runWithCredentials 包住请求处理，
   下游模块照常调用 effectiveApi()/zhihuSecret()，自动拿到本次请求的凭证。 */
const requestScope = new AsyncLocalStorage();

function runWithCredentials(overrides, fn) {
  const clean = {};
  const source = overrides && typeof overrides === "object" ? overrides : {};
  for (const key of ["api_key", "base_url", "model", "access_secret"]) {
    const value = String(source[key] || "").trim();
    if (value) clean[key] = value;
  }
  return requestScope.run(clean, fn);
}

function requestOverrides() {
  return requestScope.getStore() || {};
}

let current = null;

function normalizeBaseUrl(url) {
  let out = String(url || "").trim();
  out = out.replace(/\/v1\/chat\/completions\/?$/, "/v1");
  out = out.replace(/\/chat\/completions\/?$/, "");
  return out.replace(/\/+$/, "");
}

function load() {
  if (current) return current;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (raw && typeof raw === "object") {
      current = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...raw };
      return current;
    }
  } catch (err) { /* 无存档或不可读：走默认值 */ }
  current = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  return current;
}

function save(payload) {
  const cur = load();
  const body = payload && typeof payload === "object" ? payload : {};
  const apiIn = body.api && typeof body.api === "object" ? body.api : {};
  if ("base_url" in apiIn) cur.api.base_url = normalizeBaseUrl(String(apiIn.base_url || ""));
  if ("api_key" in apiIn) cur.api.api_key = String(apiIn.api_key || "").trim();
  if ("model" in apiIn) cur.api.model = String(apiIn.model || "").trim();
  const zhIn = body.zhihu && typeof body.zhihu === "object" ? body.zhihu : {};
  if ("access_secret" in zhIn) cur.zhihu.access_secret = String(zhIn.access_secret || "").trim();
  if (THEMES.includes(body.theme)) cur.theme = body.theme;
  current = cur;
  return publicView(cur);
}

function reset() {
  current = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  return publicView(current);
}

function mask(secret) {
  const s = String(secret || "");
  if (s.length > 8) return `${s.slice(0, 3)}…${s.slice(-4)}`;
  return s ? "已设置" : "";
}

function publicView(data) {
  const d = data || load();
  return {
    api: {
      base_url: d.api.base_url || "",
      model: d.api.model || "",
      has_key: Boolean(d.api.api_key),
      api_key_masked: mask(d.api.api_key || ""),
    },
    zhihu: {
      has_secret: Boolean(d.zhihu.access_secret),
      access_secret_masked: mask(d.zhihu.access_secret || ""),
    },
    theme: d.theme || "paper",
  };
}

function effectiveApi() {
  const over = requestOverrides();
  const api = load().api;
  return {
    api_key: String(over.api_key || api.api_key || "").trim(),
    base_url: normalizeBaseUrl(String(over.base_url || api.base_url || "").trim() || "https://api.deepseek.com"),
    model: String(over.model || api.model || "").trim(),
  };
}

function effectiveApiFrom(payload) {
  const over = requestOverrides();
  const saved = load().api;
  const api = payload && typeof payload.api === "object" ? payload.api : {};
  return {
    api_key: String(api.api_key || over.api_key || saved.api_key || "").trim(),
    base_url: normalizeBaseUrl(
      String(api.base_url || over.base_url || saved.base_url || "").trim() || "https://api.deepseek.com"
    ),
    model: String(api.model || over.model || saved.model || "").trim(),
  };
}

function zhihuSecret() {
  const over = requestOverrides();
  return String(over.access_secret || load().zhihu.access_secret || "").trim();
}

module.exports = {
  normalizeBaseUrl, load, save, reset, publicView, effectiveApi, effectiveApiFrom, zhihuSecret,
  runWithCredentials, requestOverrides,
};
