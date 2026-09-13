/* prompts.js — 运行时从 prompts/*.txt 读取提示词并拼装消息。 */

const fs = require("fs");
const path = require("path");

const PROMPTS_DIR = path.join(__dirname, "..", "prompts");

const PROMPT_VERSIONS = {
  story: "story.v2.3.0-staged",
  story_localize: "story-localize.v1.0.0",
  topic_recommend: "topic-recommend.v1.1.0-zhida",
  word_sort: "word-sort.v2.0.0-article-coherence",
  word_screening: "word-screening.v2.0.0",
  zhihu_query_planning: "zhihu-query-planning.v1.0.0",
  zhihu_topic_coverage: "zhihu-topic-coverage.v2.1.0-theme-groups",
  source_digest: "source-digest.v1.0.0",
  pipeline_story: "pipeline-story.v1.2.0-zhida",
  periodical_digest: "periodical-digest.v1.1.0-zhida",
  connection_test: "connection-test.v1.0.0",
};

const MIN_CARDS = { story: 3 };
const FENCE_MARKERS = ["```", "~~~"];
const OUTPUT_TAGS = new Set(["[T]", "[E]", "[C]", "[K]", "[TITLE]", "[GENRE]", "[EN]", "[ZH]", "[TAKEAWAY]"]);

const cache = new Map();

function clean(text) {
  const lines = [];
  let inFence = false;
  for (const raw of String(text).split("\n")) {
    const stripped = raw.trim();
    if (FENCE_MARKERS.some((m) => stripped.startsWith(m))) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && stripped.startsWith("[") && stripped.endsWith("]") && stripped.length < 40 && !OUTPUT_TAGS.has(stripped.toUpperCase())) {
      continue;
    }
    lines.push(raw);
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n").trim();
}

function loadPrompt(filename) {
  if (!cache.has(filename)) {
    const file = path.join(PROMPTS_DIR, filename);
    cache.set(filename, clean(fs.readFileSync(file, "utf8")));
  }
  return cache.get(filename);
}

function getStagePrompt(name) {
  /* word_screening 等阶段提示词：prompts/<name>_prompt.txt */
  const mapping = { word_screening: "word_screening_prompt.txt" };
  const file = mapping[name];
  if (!file) throw new Error(`未知阶段提示词: ${name}`);
  return loadPrompt(file);
}

function basePrompt() {
  return loadPrompt("base_system_prompt.txt");
}

function modePrompt(mode) {
  if (mode !== "story") throw new Error(`未知模式: ${mode}（仅支持 story）`);
  return loadPrompt("story_prompt.txt");
}

/* 线上单次请求有约 12–15 秒的硬上限（实测：服务端延时 12s 通过、18s 被掐成 HTTP 554），
   一次跑完「英文正文 + 中文翻译 + 总结」需要 20 秒以上，必然被掐。
   因此把故事分两步：draft 只写英文正文，localize 再翻译成中文。
   两个阶段各自独立成请求，中间结果由客户端回传，服务端不保存任何中间态。 */
const STORY_STAGE_DIRECTIVE = {
  draft: [
    "",
    "",
    "[This run — step 1 of 2]",
    "Output ONLY the [T] and [E] blocks: [T] the English title, [E] the complete English body.",
    "Do NOT output [C] or [K]. The Chinese rendering and the takeaway are produced in a separate later step.",
  ].join("\n"),
};

/* 第二步：把已写好的英文正文翻成中文，并给一句英文总结。
   必须把目标词一并交给模型：分步之后模型只看得到英文正文，
   若不点名，中文里往往把目标词直译成中文，目标词就丢了。 */
function localizeMessages(story = {}, words = []) {
  return [
    { role: "system", content: `${basePrompt()}\n\n${loadPrompt("story_localize_prompt.txt")}` },
    {
      role: "user",
      content: JSON.stringify({
        title: String(story.title || "").slice(0, 200),
        words: (words || []).map((w) => String(w || "")).filter(Boolean).slice(0, 40),
        en: String(story.en || "").slice(0, 8000),
      }),
    },
  ];
}

function systemMessage(mode, stage = "full") {
  const base = `${basePrompt()}\n\n${modePrompt(mode)}`;
  return base + (STORY_STAGE_DIRECTIVE[stage] || "");
}

function userMessage(mode, cards, level = "junior", params = {}, source = "original",
                    sourcePayload = null, groupContext = null, originalTopic = "") {
  const msg = {
    words: (cards || [])
      .filter((card) => card.word)
      .map((card) => ({
        w: String(card.word || ""),
        m: String(card.meaning_cn || card.meaning_en || "").slice(0, 80),
        p: String(card.pos || "").slice(0, 16),
      })),
    level,
    options: params || {},
  };
  if (groupContext && typeof groupContext === "object") {
    msg.context = {
      theme: String(groupContext.theme || "").slice(0, 80),
      reason: String(groupContext.reason || "").slice(0, 240),
    };
  }
  if (originalTopic) msg.topic = String(originalTopic).slice(0, 120);
  if (source && source !== "original") {
    msg.sourceType = source;
    if (sourcePayload && typeof sourcePayload === "object") {
      const src = {
        title: String(sourcePayload.title || "").slice(0, 180),
        summary: String(sourcePayload.summary || sourcePayload.excerpt || "").slice(0, 700),
        labels: (sourcePayload.labels || []).slice(0, 6).map((v) => String(v).slice(0, 40)),
      };
      const digest = String(sourcePayload.digest || "").trim();
      if (digest) src.digest = digest.slice(0, 1200);
      const content = String(sourcePayload.content || sourcePayload.excerpt || "").trim();
      if (content) src.content = content.slice(0, 1200);
      msg.source = src;
    }
  }
  return JSON.stringify(msg);
}

function messages(mode, cards, level = "junior", params = {}, source = "original",
                 sourcePayload = null, groupContext = null, originalTopic = "", stage = "full") {
  return [
    { role: "system", content: systemMessage(mode, stage) },
    { role: "user", content: userMessage(mode, cards, level, params, source, sourcePayload, groupContext, originalTopic) },
  ];
}

function minCards(mode) {
  return MIN_CARDS[mode];
}

function version(skillName) {
  return PROMPT_VERSIONS[skillName] || "unversioned";
}

function versions() {
  return { ...PROMPT_VERSIONS };
}

module.exports = { getStagePrompt, systemMessage, messages, localizeMessages, minCards, version, versions };
