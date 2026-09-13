/* llm.js — LLM 网关：OpenAI 兼容 chat/completions、指标 JSONL 日志。
   交付红线：只读 process.env.PORT 的规则同样适用于本模块——不读任何业务环境变量。 */

const { trace } = require("./util");

/* LLM 指标日志：进程内存（平台只读文件系统，重启重置）。 */
const recent = [];

function utcNow() {
  return new Date().toISOString();
}

function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let latin = 0;
  for (const ch of text) if (ch.charCodeAt(0) < 128) latin++;
  const nonLatin = text.length - latin;
  return Math.max(1, Math.round(latin / 4 + nonLatin / 1.6));
}

function usage(payload, messages, content) {
  const raw = payload && typeof payload.usage === "object" && payload.usage ? payload.usage : {};
  let inputTokens = raw.prompt_tokens !== undefined ? raw.prompt_tokens : raw.input_tokens;
  let outputTokens = raw.completion_tokens !== undefined ? raw.completion_tokens : raw.output_tokens;
  const estimated = inputTokens === undefined || outputTokens === undefined;
  if (inputTokens === undefined) inputTokens = estimateTokens(messages);
  if (outputTokens === undefined) outputTokens = estimateTokens(content);
  let total = raw.total_tokens !== undefined ? raw.total_tokens : inputTokens + outputTokens;
  return { input_tokens: Number(inputTokens), output_tokens: Number(outputTokens), total_tokens: Number(total), estimated };
}

function writeLog(record) {
  recent.unshift({ ...record });
  if (recent.length > 300) recent.length = 300;
}

function recentCalls(limit = 100) {
  const n = Math.max(1, Math.min(Number(limit) || 100, 300));
  return recent.slice(0, n).map((r) => ({ ...r }));
}

function clearLogs() {
  recent.length = 0;
}

function recordFallback(skillName, promptVersion, reason, config, metadata = {}) {
  const now = utcNow();
  writeLog({
    skill: skillName,
    prompt_version: promptVersion,
    model: "local-fallback",
    started_at: now,
    ended_at: now,
    elapsed_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    estimated_tokens: false,
    fallback: true,
    cache_hit: false,
    status: "fallback",
    reason: String(reason).slice(0, 400),
    metadata,
  });
}

function buildChatUrl(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/chat/completions`;
}

async function openaiComplete(messages, cfg, { timeout = [10, 120], temperature = 0.7, jsonMode = false } = {}) {
  if (!cfg.api_key || !cfg.base_url || !cfg.model) {
    throw new Error("文章生成 API 配置不完整，需要 Base URL、API Key 和模型");
  }
  const started = Date.now();
  const url = buildChatUrl(cfg.base_url);
  const headers = { Authorization: `Bearer ${cfg.api_key}`, "Content-Type": "application/json" };
  const payload = { model: cfg.model, messages, stream: false, temperature };
  if (jsonMode) payload.response_format = { type: "json_object" };

  const doFetch = (u, body) =>
    fetch(u, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((timeout[0] + timeout[1]) * 1000),
    });

  let effectiveUrl = url;
  let response = await doFetch(effectiveUrl, payload);
  /* 中转站兼容：404 且 URL 未含 /v1/ 时补路径重试 */
  if (response.status === 404 && !effectiveUrl.includes("/v1/")) {
    effectiveUrl = effectiveUrl.replace("/chat/completions", "/v1/chat/completions");
    response = await doFetch(effectiveUrl, payload);
  }
  /* 供应商不支持 response_format：优雅降级重试一次 */
  if (jsonMode && [400, 404, 422].includes(response.status)) {
    delete payload.response_format;
    response = await doFetch(effectiveUrl, payload);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const err = new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  let content;
  try {
    content = String(data.choices[0].message.content);
  } catch (err) {
    throw new Error("文章生成 API 返回结构不完整");
  }
  return {
    content,
    usage: data.usage && typeof data.usage === "object" ? data.usage : {},
    model: String(data.model || cfg.model),
    started_at: utcNow(),
    ended_at: utcNow(),
    elapsed_ms: Date.now() - started,
  };
}

async function complete({ skillName, promptVersion, messages, config = null, jsonMode = false,
                         temperature = 0.7, timeout = [10, 120], metadata = null }) {
  const cfg = config || {};
  const requestedModel = String(cfg.model || "");
  trace("llm_start", { skill: skillName, model: requestedModel });
  const startedAt = utcNow();
  const started = Date.now();
  try {
    const response = await openaiComplete(messages, cfg, { timeout, temperature, jsonMode });
    const usageInfo = usage({ usage: response.usage }, messages, response.content);
    const record = {
      skill: skillName,
      prompt_version: promptVersion,
      model: response.model,
      started_at: response.started_at || startedAt,
      ended_at: response.ended_at || utcNow(),
      elapsed_ms: response.elapsed_ms || 0,
      input_tokens: usageInfo.input_tokens,
      output_tokens: usageInfo.output_tokens,
      total_tokens: usageInfo.total_tokens,
      estimated_tokens: usageInfo.estimated,
      fallback: false,
      cache_hit: false,
      json_mode: jsonMode,
      status: "success",
      metadata: metadata || {},
    };
    writeLog(record);
    return { content: response.content, usage: usageInfo, metrics: record };
  } catch (err) {
    const estimated = estimateTokens(messages);
    writeLog({
      skill: skillName,
      prompt_version: promptVersion,
      model: requestedModel,
      started_at: startedAt,
      ended_at: utcNow(),
      elapsed_ms: Date.now() - started,
      input_tokens: estimated,
      output_tokens: 0,
      total_tokens: estimated,
      estimated_tokens: true,
      fallback: false,
      cache_hit: false,
      json_mode: jsonMode,
      status: "error",
      reason: String(err.message || err).slice(0, 400),
      metadata: metadata || {},
    });
    throw err;
  }
}

module.exports = { complete, recentCalls, clearLogs, recordFallback, buildChatUrl };
