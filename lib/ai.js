/* ai.js — AI 文章生成服务：状态、连通性测试、模型列表、生成与校验。
   契约与 Flask 版 ai_service.py 一致；密钥只来自 settings.js。 */

const crypto = require("crypto");
const settings = require("./settings");
const prompts = require("./prompts");
const llm = require("./llm");
const grouping = require("./grouping");
const { extractJson, trace } = require("./util");

/* 生成内容第二道安全闸门：只查模型输出，不查用户词卡。 */
const RESTRICTED_RE = /(?:色情|淫秽|裸体|裸露|性行为|情色|强奸|血腥|斩首|\b(?:porn|pornography|nude|nudity|naked|erotic|sexual|sex|intercourse|orgasm|hentai|xxx|rape|gore|beheading)\b)/i;

const SOURCES = ["original", "zhihu_search", "hot", "story", "knowledge"];
const LEVELS = { junior: "初中（简单）", senior: "高中（中等）", cet: "四六级（进阶）" };
const PARAM_KEYS = ["density", "richness", "reasoning", "abstraction"];
const GENRES = ["daily-science", "daily-curiosity", "light-entertainment"];
const TONES = ["clear", "warm", "lively"];
const STRUCTURES = ["scene-explain", "problem-solution", "contrast"];

const ARTICLE_CACHE_TTL = 10 * 60 * 1000;
const articleCache = new Map(); // key -> {expires, result}

class GenerationError extends Error {
  constructor(message, { code = "AI_UPSTREAM_ERROR", statusCode = 502, retryable = true, requestId = "", stage = "generation", suggestions = [] } = {}) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.requestId = requestId;
    this.stage = stage;
    this.suggestions = suggestions;
  }
}

function providerCatalog() {
  return [
    { id: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com" },
    { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1" },
    { id: "relay", name: "API 中转站", base_url: "" },
    { id: "custom", name: "自定义 OpenAI 兼容接口", base_url: "" },
  ];
}

function providerDeterminationRules() {
  return {
    tokens: [["api.deepseek.com", "deepseek"], ["api.openai.com", "openai"]],
    model_prefixes: [["deepseek", "deepseek"], ["gpt-", "openai"], ["o1", "openai"], ["o3", "openai"]],
    relay_domains: ["api.", "-api.", "proxy", "relay", "gateway", "oneapi", "newapi"],
  };
}

function providerInfo(cfg) {
  const baseUrl = String(cfg.base_url || "").toLowerCase();
  const model = String(cfg.model || "").toLowerCase();
  if (baseUrl.includes("api.deepseek.com") || model.startsWith("deepseek")) return ["deepseek", "DeepSeek"];
  if (baseUrl.includes("api.openai.com") || /^(gpt-|o1|o3)/.test(model)) return ["openai", "OpenAI"];
  if (baseUrl && ["proxy", "relay", "gateway", "oneapi", "newapi", "aihub", "中转"].some((kw) => baseUrl.includes(kw))) {
    return ["relay", "API 中转站"];
  }
  return ["custom", "OpenAI 兼容 API"];
}

function requireApiConfig(cfg) {
  const missing = ["base_url", "api_key", "model"].filter((k) => !String(cfg[k] || "").trim());
  if (missing.length) throw new Error("请在设置页完整填写 Base URL、API Key 和模型");
}

function aiStatus() {
  const cfg = settings.effectiveApi();
  const [provider, providerName] = providerInfo(cfg);
  const available = Boolean(String(cfg.base_url || "").trim() && String(cfg.api_key || "").trim() && String(cfg.model || "").trim());
  return {
    available,
    provider,
    provider_name: providerName,
    model: cfg.model || "",
    mode: available ? "ai" : "nokey",
    label: available ? "文章生成 API 已配置" : "未配置文章生成 API",
    display: available ? `${providerName} · ${cfg.model || ""}` : "未配置文章生成 API",
    quota: {},
  };
}

async function testAiConfig(payload) {
  const cfg = settings.effectiveApiFrom(payload || {});
  try {
    requireApiConfig(cfg);
    const [provider, providerName] = providerInfo(cfg);
    const response = await llm.complete({
      skillName: "connection_test",
      promptVersion: "connection-test-v1",
      messages: [{ role: "user", content: "Reply with OK only." }],
      config: cfg,
      temperature: 0,
      timeout: [10, 30],
      metadata: { connection_test: true },
    });
    return {
      status: "ok", available: true, provider, provider_name: providerName,
      model: response.metrics.model || cfg.model, mode: "ai", message: "连接测试成功",
    };
  } catch (err) {
    if (/请在设置页完整填写/.test(err.message)) {
      return { status: "warning", available: false, mode: "nokey", message: err.message };
    }
    return { status: "error", available: false, mode: "error", message: `连接失败：${err.message}` };
  }
}

async function fetchAiModels(payload) {
  const cfg = settings.effectiveApiFrom(payload || {});
  if (!cfg.base_url || !cfg.api_key) {
    return { ok: false, models: [], message: "请先填写 Base URL 和 API Key" };
  }
  const [provider, providerName] = providerInfo(cfg);
  try {
    const url = `${cfg.base_url.replace(/\/+$/, "")}/models`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.api_key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(40000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const items = data && typeof data === "object" && Array.isArray(data.data) ? data.data : [];
    const models = [...new Set(items.filter((i) => i && typeof i === "object" && i.id).map((i) => String(i.id).trim()))].sort();
    return {
      ok: Boolean(models.length), models, provider, provider_name: providerName, base_url: cfg.base_url,
      message: models.length ? `已获取 ${models.length} 个模型` : "接口未返回模型",
    };
  } catch (err) {
    return { ok: false, models: [], provider, provider_name: providerName, base_url: cfg.base_url, message: `模型查询失败：${err.message}` };
  }
}

function normalizeLevel(level) {
  return LEVELS[level] ? level : "junior";
}

function normalizeParams(params) {
  const out = {};
  const src = params && typeof params === "object" ? params : {};
  for (const key of PARAM_KEYS) {
    let v = Number.parseInt(src[key] !== undefined ? src[key] : 5, 10);
    if (!Number.isFinite(v)) v = 5;
    out[key] = Math.max(1, Math.min(10, v));
  }
  let length = Number.parseInt(src.length !== undefined ? src.length : 220, 10);
  if (!Number.isFinite(length)) length = 220;
  out.length = Math.max(180, Math.min(600, length));
  out.genre = GENRES.includes(src.genre) ? src.genre : "daily-science";
  out.tone = TONES.includes(src.tone) ? src.tone : "clear";
  out.structure = STRUCTURES.includes(src.structure) ? src.structure : "scene-explain";
  return out;
}

function buildSourceNote(source, sourcePayload) {
  if (source === "original" || !sourcePayload || typeof sourcePayload !== "object") {
    return "来源：AI 原创生成｜Bookwords 英语学习材料";
  }
  const title = String(sourcePayload.title || "").trim();
  if (!title) return "来源：AI 原创生成｜Bookwords 英语学习材料";
  const labels = { zhihu_search: "知乎精选", hot: "知乎热榜", story: "知乎故事", knowledge: "知乎知识" };
  let note = `来源：${labels[source] || "知乎"}《${title}》`;
  const author = String(sourcePayload.author || "").trim();
  if (author) note += `｜作者：${author}`;
  const votes = Number(sourcePayload.vote_up_count) || 0;
  if (votes) note += `｜赞同 ${votes}`;
  return note;
}

function safeSourcePayload(sourcePayload) {
  if (!sourcePayload || typeof sourcePayload !== "object") return null;
  return {
    title: String(sourcePayload.title || "").slice(0, 240),
    summary: String(sourcePayload.summary || sourcePayload.excerpt || sourcePayload.description || "").slice(0, 1000),
    author: String(sourcePayload.author || "").slice(0, 80),
    labels: (sourcePayload.labels || []).slice(0, 10).map((v) => String(v).slice(0, 50)),
    url: String(sourcePayload.url || "").slice(0, 500),
    vote_up_count: Number(sourcePayload.vote_up_count) || 0,
    /* 透传生成所需的正文与概括字段（截断后仅进提示词，不回传前端） */
    excerpt: String(sourcePayload.excerpt || "").slice(0, 1600),
    digest: String(sourcePayload.digest || "").slice(0, 1200),
    content: String(sourcePayload.content || "").slice(0, 1600),
  };
}

function containsRestrictedContent(...values) {
  return RESTRICTED_RE.test(values.map((v) => String(v || "")).join(" "));
}

/* ---------------- 输出解析（标签 / JSON / 双语自然文本） ---------------- */

function parseArticleText(content) {
  let text = String(content || "").replace(/\r\n/g, "\n").trim();
  text = text.replace(/^```(?:json|markdown|text)?\s*/i, "").replace(/\s*```$/, "").trim();
  text = text.replace(/^\s*(\[?(?:TITLE|GENRE|ENGLISH|CHINESE|TAKEAWAY|EN|ZH|CN|T|G|E|C|K|标题|类型|英文|中文|翻译|总结)\]?)\s*[：:]\s*(\S.+)$/gim, "$1\n$2");

  /* 1) JSON */
  try {
    const raw = extractJson(text);
    const aliases = {
      title: ["title", "headline", "name"],
      genre: ["genre", "type"],
      en: ["en", "english", "content_en", "article"],
      zh: ["zh", "cn", "chinese", "content_zh", "translation"],
      takeaway: ["takeaway", "summary", "lesson"],
    };
    const payload = {};
    for (const [key, names] of Object.entries(aliases)) {
      payload[key] = names.map((n) => raw[n]).find((v) => v) || "";
    }
    if (payload.title && payload.en && payload.zh) return payload;
  } catch (err) { /* 继续走标签解析 */ }

  /* 2) 标记行 */
  const markerAliases = {
    T: "title", TITLE: "title", "标题": "title", G: "genre", GENRE: "genre", "类型": "genre",
    E: "en", EN: "en", ENGLISH: "en", "英文": "en",
    C: "zh", ZH: "zh", CN: "zh", CHINESE: "zh", "中文": "zh", "翻译": "zh",
    K: "takeaway", TAKEAWAY: "takeaway", "总结": "takeaway",
  };
  const markerRe = /^\s*(?:#{1,4}\s*)?(?:\[|<)?(ENGLISH(?:\s+(?:ARTICLE|VERSION))?|CHINESE(?:\s+(?:TRANSLATION|VERSION))?|TAKEAWAY|TITLE|GENRE|英文(?:正文|版本)?|中文(?:翻译|版本)?|EN|ZH|CN|标题|类型|翻译|总结|T|G|E|C|K)(?:\]|>)?\s*[：:]?\s*$/im;
  const linesAll = text.split("\n");
  const matches = [];
  linesAll.forEach((line, index) => {
    const m = line.match(markerRe);
    if (m) matches.push({ index, token: m[1] });
  });
  if (matches.length) {
    const sections = {};
    matches.forEach((match, i) => {
      const token = match.token;
      const normalized = /^[\x00-\x7F]*$/.test(token) ? token.toUpperCase() : token;
      let key;
      if (/^(ENGLISH|英文)/.test(normalized)) key = "en";
      else if (/^(CHINESE|中文)/.test(normalized)) key = "zh";
      else key = markerAliases[normalized];
      const end = i + 1 < matches.length ? matches[i + 1].index : linesAll.length;
      sections[key] = linesAll.slice(match.index + 1, end).join("\n").trim();
    });
    if (!sections.title && matches.length) {
      const preface = linesAll.slice(0, matches[0].index).join("\n").trim();
      if (preface) {
        let firstLine = preface.split("\n")[0].trim();
        firstLine = firstLine.replace(/^#{1,6}\s*/, "").replace(/^\*\*(.*)\*\*$/, "$1").trim();
        if (firstLine && firstLine.length <= 140) sections.title = firstLine;
      }
    }
    if (sections.title && sections.en && sections.zh) {
      return { title: sections.title, genre: sections.genre || "", en: sections.en, zh: sections.zh, takeaway: sections.takeaway || "" };
    }
  }

  /* 3) 自然双语文本：首行标题，第一个中文密集行起为中文 */
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 3) {
    let heading = lines[0].replace(/^#{1,6}\s*/, "").replace(/^\*\*(.*)\*\*$/, "$1").trim();
    const start = heading.length <= 140 ? 1 : 0;
    const cjkCount = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;
    const splitAt = lines.findIndex((line, index) => index > start && cjkCount(line) >= Math.max(4, Math.floor(line.length / 5)));
    if (splitAt !== -1) {
      const english = lines.slice(start, splitAt).join("\n\n").trim();
      const chinese = lines.slice(splitAt).join("\n\n").trim();
      if (english && chinese && /[A-Za-z]/.test(english)) {
        return { title: heading || "Everyday Words in Context", genre: "", en: english, zh: chinese, takeaway: "" };
      }
    }
  }
  throw new Error("模型返回了文本，但未能识别完整的英文正文和中文对照");
}

function normalizeTargetMarkup(text, cards, { allowMissing = true } = {}) {
  let normalized = String(text || "");
  for (const card of cards) {
    const word = String(card.word || "").trim();
    if (!word) continue;
    const boldRe = new RegExp(`\\*\\*${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*\\*`, "i");
    if (boldRe.test(normalized)) continue;
    const plainRe = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (!plainRe.test(normalized)) {
      if (allowMissing) continue;
      throw new Error(`目标词未出现在文章中：${word}`);
    }
    normalized = normalized.replace(plainRe, (m) => `**${m}**`);
  }
  return normalized;
}

function countEnglishWords(text) {
  return (String(text).match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length;
}

/* 分步生成用的宽松解析：只要求指定段落存在
   （草稿阶段要 title+en，本地化阶段要 zh，takeaway 可选）。 */
function parsePartialStory(content, { need = [] } = {}) {
  let text = String(content || "")
    .replace(/\r\n/g, "\n")
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
  /* 行内标记拆成独立行：[T] 标题 / [E] 正文 这种写法很常见。
     单字母标记必须带方括号才算标记，避免误伤正文里以 T/E/C/K 开头的英文句子。 */
  text = text.replace(/^[ \t]*\[([TEGCK])\][ \t]*([^\n]*)$/gim, (_all, tag, rest) => (rest.trim() ? `[${tag}]\n${rest.trim()}` : `[${tag}]`));
  text = text.replace(/^[ \t]*(TITLE|GENRE|ENGLISH|CHINESE|TAKEAWAY|EN|ZH|CN|标题|类型|英文|中文|翻译|总结)[ \t]*[：:][ \t]*([^\n]+)$/gim, "$1\n$2");
  const markerRe = /^\s*(?:#{1,4}\s*)?(?:\[|<)?(ENGLISH|CHINESE|TAKEAWAY|TITLE|GENRE|英文(?:正文)?|中文(?:翻译)?|翻译|标题|类型|总结|EN|ZH|CN|T|G|E|C|K)(?:\]|>)?\s*[：:]?\s*$/im;
  const lines = text.split("\n");
  const found = [];
  lines.forEach((line, index) => {
    const match = line.match(markerRe);
    if (match) found.push({ index, token: match[1].toUpperCase() });
  });
  const keyOf = (token) => {
    if (/^(ENGLISH|EN|E|英文)/.test(token)) return "en";
    if (/^(CHINESE|ZH|CN|C|中文|翻译)/.test(token)) return "zh";
    if (/^(TAKEAWAY|K|总结)/.test(token)) return "takeaway";
    if (/^(TITLE|T|标题)/.test(token)) return "title";
    if (/^(GENRE|G|类型)/.test(token)) return "genre";
    return "";
  };
  const sections = {};
  found.forEach((match, i) => {
    const key = keyOf(match.token);
    if (!key) return;
    const end = i + 1 < found.length ? found[i + 1].index : lines.length;
    sections[key] = lines.slice(match.index + 1, end).join("\n").trim();
  });
  /* 没有标记行时退一步：整段当正文（草稿场景模型偶尔直接给正文） */
  if (!found.length && need.includes("en")) sections.en = text;
  const missing = need.filter((key) => !String(sections[key] || "").trim());
  if (missing.length) throw new Error(`模型输出缺少段落：${missing.join("、")}`);
  return sections;
}

/* 草稿阶段：只有英文正文，中文留空，等 localize 阶段补上。
   模型偶尔漏掉 [T] 标题段（尤其带知乎素材时），这里用素材标题/正文首句兜底，
   不让整篇文章因为一个标记缺失而作废。 */
function normalizeDraft(payload, cards, params, { fallbackTitle = "" } = {}) {
  let title = String(payload.title || "").trim();
  let en = String(payload.en || "").trim();
  if (!title && fallbackTitle) title = fallbackTitle.slice(0, 160);
  if (!title && en) {
    const firstLine = en.split("\n")[0].replace(/^[#*\s]+/, "").trim();
    title = firstLine && firstLine.length <= 140 ? firstLine : "Everyday Words in Context";
  }
  if (!title || !en) throw new Error("输出结构不完整：缺少英文标题或正文");
  if (containsRestrictedContent(title, en)) throw new Error("文章触发内容安全规则");
  const missingWords = [];
  const validationWarnings = [];
  if (cards.length) {
    for (const card of cards) {
      const word = String(card.word || "").trim();
      if (!word) continue;
      const wordRe = new RegExp(`(?<![A-Za-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "i");
      if (!wordRe.test(en)) missingWords.push(word);
    }
    if (missingWords.length) validationWarnings.push(`目标词遗漏：${missingWords.join("、")}`);
    en = normalizeTargetMarkup(en, cards, { allowMissing: true });
  }
  if (title.length > 160) throw new Error("英文标题过长");
  if ((en.match(/[.!?](?:\s|$)/g) || []).length < 3) throw new Error("文章缺少基本叙事结构：至少需要 3 个完整句子");
  if (cards.length) {
    const count = countEnglishWords(en);
    const target = Math.max(180, Math.min(600, Number(params.length) || 220));
    const lower = Math.floor(target * 0.7);
    const upper = Math.floor(target * 1.3) + 20;
    if (count < lower || count > upper) {
      validationWarnings.push(`正文长度为 ${count} 词，目标约 ${target} 词（允许 ${lower}–${upper} 词）`);
    }
  }
  let genre = String(payload.genre || params.genre || "daily-science").trim();
  if (!GENRES.includes(genre)) genre = "daily-science";
  return {
    story: {
      publication: "知乎英语日报 · Zhihu English Daily",
      genre,
      dateline: "知乎英语日报 · Learning Edition",
      title,
      en,
      takeaway: "",
      cn: "",
      zh: "",
      hooks: cards.map(hookLine).filter(Boolean),
      disclaimer: "本文为基于知乎公开内容生成的英语学习材料；已进行摘要与改写，不替代原文。",
      source_note: "",
      missing_words: missingWords,
      validation_warnings: validationWarnings,
      validation_status: "pending_localize",
    },
  };
}

function hookLine(card) {
  const word = String(card.word || "").trim();
  const meaning = String(card.meaning_cn || card.meaning || card.meaning_en || "").trim();
  return word ? `**${word}**：${meaning}` : "";
}

function normalizeStory(payload, cards, params) {
  if (!payload || typeof payload !== "object") throw new Error("输出结构不完整：应为 JSON 对象");
  const title = String(payload.title || "").trim();
  let en = String(payload.en || "").trim();
  let zh = String(payload.zh || "").trim();
  let takeaway = String(payload.takeaway || "").trim();
  if (!title || !en || !zh) throw new Error("输出结构不完整：缺少 title、en 或 zh 中文翻译");
  if (containsRestrictedContent(title, en, zh, takeaway)) throw new Error("文章触发内容安全规则");
  const missingWords = [];
  const validationWarnings = [];
  if (cards.length) {
    for (const card of cards) {
      const word = String(card.word || "").trim();
      if (!word) continue;
      const wordRe = new RegExp(`(?<![A-Za-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "i");
      if (!wordRe.test(en) || !wordRe.test(zh)) missingWords.push(word);
    }
    if (missingWords.length) validationWarnings.push(`目标词遗漏：${missingWords.join("、")}`);
    en = normalizeTargetMarkup(en, cards, { allowMissing: true });
    zh = normalizeTargetMarkup(zh, cards, { allowMissing: true });
  }
  if (title.length > 160) throw new Error("英文标题过长");
  if ((en.match(/[.!?](?:\s|$)/g) || []).length < 3) throw new Error("文章缺少基本叙事结构：至少需要 3 个完整句子");
  if (cards.length) {
    const count = countEnglishWords(en);
    const target = Math.max(180, Math.min(600, Number(params.length) || 220));
    const lower = Math.floor(target * 0.7);
    const upper = Math.floor(target * 1.3) + 20;
    if (count < lower || count > upper) {
      validationWarnings.push(`正文长度为 ${count} 词，目标约 ${target} 词（允许 ${lower}–${upper} 词）`);
    }
  }
  let genre = String(payload.genre || params.genre || "daily-science").trim();
  if (!GENRES.includes(genre)) genre = "daily-science";
  const hooks = cards.map(hookLine).filter(Boolean);
  takeaway = takeaway || "Review the highlighted words and use them in your own sentence.";
  return {
    story: {
      publication: "知乎英语日报 · Zhihu English Daily",
      genre,
      dateline: "知乎英语日报 · Learning Edition",
      title,
      en,
      takeaway: takeaway.slice(0, 240),
      cn: zh,
      zh,
      hooks,
      disclaimer: "本文为基于知乎公开内容生成的英语学习材料；已进行摘要与改写，不替代原文。",
      source_note: "",
      missing_words: missingWords,
      validation_warnings: validationWarnings,
      validation_status: validationWarnings.length ? "warning" : "valid",
    },
  };
}

function articleCacheKey(cards, level, params, source, sourcePayload, cfg, memoryScope, confirmedGroup) {
  const value = {
    cards, level, params, source, source_payload: sourcePayload,
    model: cfg.model, base_url: cfg.base_url, memory_scope: memoryScope,
    confirmed_group: confirmedGroup || {}, prompt: prompts.version("story"),
  };
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cachedArticle(key) {
  const item = articleCache.get(key);
  if (!item) return null;
  if (item.expires <= Date.now()) {
    articleCache.delete(key);
    return null;
  }
  const result = JSON.parse(JSON.stringify(item.result));
  result.cache_hit = true;
  result.debug = result.debug || {};
  result.debug.cache_hit = true;
  return result;
}

function storeArticle(key, result) {
  articleCache.set(key, { expires: Date.now() + ARTICLE_CACHE_TTL, result: JSON.parse(JSON.stringify(result)) });
  if (articleCache.size > 64) {
    const oldest = [...articleCache.entries()].sort((a, b) => a[1].expires - b[1].expires);
    for (const [k] of oldest.slice(0, articleCache.size - 64)) articleCache.delete(k);
  }
}

function recommendTopics(cards, candidates) {
  const safeCandidates = [];
  for (const item of (candidates || []).slice(0, 80)) {
    if (!item || typeof item !== "object") continue;
    safeCandidates.push({
      id: String(item.id || "").slice(0, 80),
      source: String(item.source || "").slice(0, 32),
      title: String(item.title || "").slice(0, 180),
      summary: String(item.summary || "").slice(0, 360),
      labels: (item.labels || []).slice(0, 8).map((x) => String(x).slice(0, 40)),
    });
  }
  if (!safeCandidates.length) return { error: "当前没有可供推荐的知乎题材" };
  const words = new Set(cards.map((card) => String(card.word || "").toLowerCase()).filter(Boolean));
  const scored = safeCandidates.map((item, index) => {
    const text = `${item.title} ${item.summary}`.toLowerCase();
    let matched = 0;
    for (const word of words) if (word && text.includes(word)) matched++;
    return { item, matched, index };
  });
  scored.sort((a, b) => (b.matched - a.matched) || (Math.min(b.item.summary.length, 360) - Math.min(a.item.summary.length, 360)) || (a.index - b.index));
  return {
    ok: true,
    fallback: false,
    provider: "local-ranking",
    recommendations: scored.slice(0, 3).map(({ item }) => ({
      ...item,
      reason: "标题或摘要与当前词汇存在共同语境",
      angle: item.title,
    })),
  };
}

async function generate(mode, cards, level = "junior", params = null, { source = "original", sourcePayload = null,
                       language = "en", memoryScope = "pool", confirmedGroup = null, lockedWords = [],
                       excludedWords = [], originalTopic = "", stage = "full" } = {}) {
  if (mode !== "story") return { error: "未知模式" };
  source = SOURCES.includes(source) ? source : "original";
  originalTopic = String(originalTopic || "").trim().slice(0, 120);
  sourcePayload = safeSourcePayload(sourcePayload);
  if (source === "original" && originalTopic) {
    sourcePayload = { title: originalTopic, summary: originalTopic, author: "", labels: [], url: "", vote_up_count: 0 };
  }
  language = language === "zh" ? "zh" : "en";
  memoryScope = memoryScope === "recent_3d" ? "recent_3d" : "pool";
  level = normalizeLevel(level);
  params = normalizeParams(params);
  const cfg0 = settings.effectiveApi();
  const requestId = crypto.randomBytes(6).toString("hex");
  try {
    requireApiConfig(cfg0);
  } catch (err) {
    throw new GenerationError(err.message, { code: "AI_NOT_CONFIGURED", statusCode: 503, retryable: false, requestId });
  }
  const [provider, providerName] = providerInfo(cfg0);
  const cfg = { ...cfg0, provider, provider_name: providerName };

  const allowed = new Map(cards.filter((c) => c.word).map((card) => [String(card.word).toLowerCase(), String(card.word)]));
  const uniqAllowed = (values) => [...new Set((values || []).map((v) => String(v).toLowerCase()))].map((k) => allowed.get(k)).filter(Boolean);
  lockedWords = uniqAllowed(lockedWords);
  excludedWords = uniqAllowed(excludedWords);
  const excluded = new Set(excludedWords.map((w) => w.toLowerCase()));

  let sorting;
  if (confirmedGroup && typeof confirmedGroup === "object") {
    const groupWords = [];
    for (const value of Array.isArray(confirmedGroup.words) ? confirmedGroup.words : []) {
      const canonical = allowed.get(String(value).toLowerCase());
      if (canonical && !excluded.has(canonical.toLowerCase()) && !groupWords.includes(canonical)) groupWords.push(canonical);
    }
    if (groupWords.length < 3 || groupWords.length > grouping.MAX_ARTICLE_WORDS) {
      throw new GenerationError("确认词组必须包含 3–20 个有效单词", { code: "AI_GROUP_INVALID", statusCode: 422, retryable: false, requestId, stage: "grouping" });
    }
    const groupKeys = new Set(groupWords.map((w) => w.toLowerCase()));
    if (!lockedWords.every((w) => groupKeys.has(w.toLowerCase()))) {
      throw new GenerationError("确认词组缺少已锁定的必用词", { code: "AI_GROUP_INVALID", statusCode: 422, retryable: false, requestId, stage: "grouping" });
    }
    let coherence = Number(confirmedGroup.coherence);
    if (!Number.isFinite(coherence)) coherence = 0.8;
    sorting = {
      provider: "user-confirmed",
      groups: [],
      selected_group: {
        id: String(confirmedGroup.id || "confirmed-group").slice(0, 64),
        theme: String(confirmedGroup.theme || "共同语境").slice(0, 80),
        reason: String(confirmedGroup.reason || "用户确认的成文词组").slice(0, 240),
        coherence: Math.max(0, Math.min(1, coherence)),
        words: groupWords,
        estimated_length: Number(params.length) || 220,
        estimated_genre: String(confirmedGroup.estimated_genre || "daily-science").slice(0, 40),
      },
    };
  } else {
    sorting = await grouping.groupCards(cards, sourcePayload, { lockedWords, excludedWords });
  }

  const cacheKey = articleCacheKey(cards, level, params, source, sourcePayload, cfg, memoryScope, sorting.selected_group);
  const hit = cachedArticle(cacheKey);
  if (hit) {
    trace("cache_hit", { source });
    hit.language = { selected: language, available: ["en", "zh"], content: hit.story[language === "zh" ? "zh" : "en"] };
    hit.story.language = language;
    return hit;
  }

  const selectedKeys = new Set(sorting.selected_group.words.map((w) => w.toLowerCase()));
  let selectedCards = cards.filter((card) => selectedKeys.has(String(card.word || "").toLowerCase()));
  if (selectedCards.length < 3) {
    throw new GenerationError("当前词汇无法形成至少 3 个词的连贯语境，请调整词汇范围", { code: "AI_OUTPUT_INVALID", statusCode: 422, retryable: false, requestId });
  }
  cards = selectedCards.slice(0, grouping.MAX_ARTICLE_WORDS);
  trace("generate_start", { source, level, length: params.length, language, words: cards.length });
  trace("group_selected", {
    provider: sorting.provider, theme: sorting.selected_group.theme,
    words: sorting.selected_group.words.join(" "), reason: sorting.selected_group.reason,
  });

  const traceInfo = {
    provider, provider_name: providerName, model: cfg.model, base_url: cfg.base_url,
    level, params, source, memory_scope: memoryScope, language, sorting,
    words: cards.map((c) => String(c.word || "")),
    prompt_version: prompts.version("story"), attempts: [],
  };
  const messages = prompts.messages("story", cards, level, params, source, sourcePayload, sorting.selected_group, originalTopic, stage);
  const entry = { n: 1, messages };
  traceInfo.attempts.push(entry);
  const started = Date.now();
  let response;
  try {
    response = await llm.complete({
      skillName: "story_generation",
      promptVersion: prompts.version("story"),
      messages,
      config: cfg,
      jsonMode: false,
      metadata: { source, word_count: cards.length },
    });
  } catch (err) {
    entry.elapsed_ms = Date.now() - started;
    entry.error = `网络 / HTTP 错误：${err.message}`;
    trace("generate_error", { stage: "llm", error: String(err.message) });
    throw upstreamGenerationError(err, requestId);
  }
  entry.elapsed_ms = Date.now() - started;
  entry.raw = response.content;
  entry.usage = response.usage;
  entry.metrics = response.metrics;

  let result;
  try {
    if (stage === "draft") {
      /* 只写英文正文；中文与总结留给 localize 阶段（各自都在线上时长上限内）。
         标题缺失时用素材标题兜底，别让一个标记缺失废掉整篇。 */
      const sections = parsePartialStory(response.content, { need: ["en"] });
      result = normalizeDraft(sections, cards, params, {
        fallbackTitle: String((sourcePayload && sourcePayload.title) || originalTopic || "").trim(),
      });
    } else {
      const payload = parseArticleText(response.content);
      result = normalizeStory(payload, cards, params);
    }
  } catch (err) {
    if (err instanceof GenerationError) throw err;
    const reason = err.message;
    entry.error = `输出校验失败：${reason}`;
    trace("validate_fail", { reason });
    const missingWord = cards.map((c) => String(c.word || "")).find((word) => reason.includes(word)) || "";
    const suggestions = missingWord
      ? [{ action: "exclude_word", word: missingWord, label: `移除 ${missingWord}` }]
      : [{ action: "change_topic", label: "更换题材" }];
    throw new GenerationError(`模型输出无法整理成文章：${reason}`, { code: "AI_OUTPUT_INVALID", requestId, stage: "validation", suggestions });
  }

  result.story.source_note = buildSourceNote(source, sourcePayload);
  trace("validate_ok", { title: String(result.story.title || "").slice(0, 120), en_words: countEnglishWords(result.story.en) });
  traceInfo.ok = true;
  traceInfo.fallback = false;
  traceInfo.request_id = requestId;
  result.fallback = false;
  result.provider = response.metrics.provider || providerName;
  result.model = response.metrics.model || cfg.model;
  result.quota = response.metrics.quota || {};
  result.request_id = requestId;
  result.cache_hit = false;
  result.source = { type: source, ...(sourcePayload || {}) };
  result.memory_scope = memoryScope;
  result.sorting = sorting;
  const contentField = stage === "draft" ? "en" : (language === "zh" ? "zh" : "en");
  result.language = { selected: language, available: ["en", "zh"], content: result.story[contentField] };
  result.story.language = language;
  result.story.content_en = result.story.en;
  result.story.content_zh = result.story.zh;
  result.story.memory_scope = memoryScope;
  result.story.sorting = result.sorting;
  result.story.source_url = String((sourcePayload || {}).url || "").slice(0, 500);
  result.story.source_type = source;
  result.stage = stage === "draft" ? "draft" : "full";
  result.debug = traceInfo;
  /* 草稿不是完整文章，不能写进完整文章缓存（否则之后会被当成成品命中）；
     把缓存键交给客户端回传，等 localize 补全后再落缓存。 */
  if (stage === "draft") result.cache_key = cacheKey;
  else storeArticle(cacheKey, result);
  return result;
}

/* 第二步：把草稿阶段的英文正文翻成中文并补一句总结。
   输入是客户端回传的草稿对象（服务端不保存中间态），输出是补全后的完整结果。 */
async function localizeStory(draft, { language = "en" } = {}) {
  const story = draft && typeof draft === "object" ? draft.story : null;
  if (!story || !String(story.en || "").trim()) {
    throw new GenerationError("缺少待翻译的英文正文，请重新生成", { code: "AI_OUTPUT_INVALID", statusCode: 422, retryable: false });
  }
  const cfg0 = settings.effectiveApi();
  const requestId = crypto.randomBytes(6).toString("hex");
  try {
    requireApiConfig(cfg0);
  } catch (err) {
    throw new GenerationError(err.message, { code: "AI_NOT_CONFIGURED", statusCode: 503, retryable: false, requestId });
  }
  const [provider, providerName] = providerInfo(cfg0);
  const cfg = { ...cfg0, provider, provider_name: providerName };

  const debugWords = Array.isArray(draft.debug && draft.debug.words) ? draft.debug.words : [];
  const groupWords = Array.isArray(draft.sorting && draft.sorting.selected_group && draft.sorting.selected_group.words)
    ? draft.sorting.selected_group.words : [];
  const words = (debugWords.length ? debugWords : groupWords).map((w) => ({ word: String(w) }));

  const messages = prompts.localizeMessages(story, words.map((card) => card.word));
  const started = Date.now();
  let response;
  try {
    response = await llm.complete({
      skillName: "story_localize",
      promptVersion: prompts.version("story_localize"),
      messages,
      config: cfg,
      jsonMode: false,
      metadata: { stage: "localize", word_count: words.length },
    });
  } catch (err) {
    trace("localize_error", { error: String(err.message) });
    throw upstreamGenerationError(err, requestId);
  }
  const elapsed = Date.now() - started;

  let sections;
  try {
    sections = parsePartialStory(response.content, { need: ["zh"] });
  } catch (err) {
    throw new GenerationError(`翻译输出无法整理成中文：${err.message}`, { code: "AI_OUTPUT_INVALID", requestId, stage: "validation" });
  }
  let zh = String(sections.zh || "").trim();
  if (words.length) zh = normalizeTargetMarkup(zh, words, { allowMissing: true });
  const takeaway = String(sections.takeaway || "").trim();
  if (containsRestrictedContent(story.title, story.en, zh, takeaway)) {
    throw new GenerationError("文章触发内容安全规则", { code: "AI_OUTPUT_INVALID", requestId, stage: "validation" });
  }

  const missingWords = [];
  for (const card of words) {
    const word = String(card.word || "").trim();
    if (!word) continue;
    const re = new RegExp(`(?<![A-Za-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "i");
    if (!re.test(String(story.en || "")) || !re.test(zh)) missingWords.push(word);
  }
  const validationWarnings = missingWords.length ? [`目标词遗漏：${missingWords.join("、")}`] : [];
  const selected = language === "zh" ? "zh" : "en";

  const result = { ...draft };
  result.story = {
    ...story,
    zh,
    cn: zh,
    takeaway: takeaway.slice(0, 240) || "Review the highlighted words and use them in your own sentence.",
    missing_words: missingWords,
    validation_warnings: validationWarnings,
    validation_status: validationWarnings.length ? "warning" : "valid",
    language: selected,
    content_en: story.en,
    content_zh: zh,
    memory_scope: draft.memory_scope || draft.story.memory_scope || "pool",
    sorting: draft.sorting || story.sorting || null,
  };
  result.stage = "full";
  result.provider = (response.metrics && response.metrics.provider) || providerName;
  result.model = (response.metrics && response.metrics.model) || cfg.model;
  result.request_id = requestId;
  result.language = { selected, available: ["en", "zh"], content: selected === "zh" ? zh : story.en };
  const attempts = Array.isArray(draft.debug && draft.debug.attempts) ? draft.debug.attempts.slice() : [];
  attempts.push({ n: attempts.length + 1, messages, elapsed_ms: elapsed, raw: response.content, usage: response.usage, metrics: response.metrics, stage: "localize" });
  result.debug = { ...(draft.debug || {}), attempts, ok: true, request_id: requestId, localized: true };
  /* 补全后才是完整文章：用草稿回传的缓存键落缓存（键由服务端算出，客户端只是带回来） */
  if (typeof draft.cache_key === "string" && draft.cache_key) {
    delete result.cache_key;
    storeArticle(draft.cache_key, result);
  }
  trace("localize_ok", { zh_chars: zh.length, ms: elapsed });
  return result;
}

function upstreamGenerationError(err, requestId) {
  const message = String(err.message || err);
  const lowered = message.toLowerCase();
  const status = err.status;
  if (status === 429 || lowered.includes("429") || lowered.includes("too many requests") || message.includes("额度")) {
    return new GenerationError(`文章生成 API 请求受限或额度已耗尽：${message}`, { code: "AI_QUOTA_EXHAUSTED", statusCode: 429, retryable: false, requestId });
  }
  if (status === 401 || lowered.includes("unauthorized") || lowered.includes("invalid api key") || lowered.includes("authentication")) {
    return new GenerationError(`文章生成 API 认证失败：${message}`, { code: "AI_AUTH_FAILED", statusCode: 502, retryable: false, requestId });
  }
  if (message.includes("配置不完整") || message.includes("未配置")) {
    return new GenerationError(message, { code: "AI_NOT_CONFIGURED", statusCode: 503, retryable: false, requestId });
  }
  return new GenerationError(`文章生成 API 连接失败：${message}`, { requestId });
}

module.exports = {
  GenerationError,
  providerCatalog, providerDeterminationRules, aiStatus, testAiConfig, fetchAiModels,
  normalizeLevel, normalizeParams, recommendTopics, generate, localizeStory,
};
