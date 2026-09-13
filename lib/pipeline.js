/* pipeline.js — 可观察的词到刊物流水线（pipeline-debug 页面专用）。 */

const prompts = require("./prompts");
const llm = require("./llm");
const settings = require("./settings");
const grouping = require("./grouping");
const { extractJson } = require("./util");

function importWords(raw, source) {
  const items = Array.isArray(raw) ? raw : [];
  const valid = [];
  const anomalies = [];
  const seen = new Set();
  items.slice(0, 200).forEach((item, index) => {
    const card = typeof item === "string" ? { word: item } : item && typeof item === "object" ? item : null;
    if (!card) {
      anomalies.push({ index, value: String(item).slice(0, 80), reason: "不是字符串或词条对象" });
      return;
    }
    const word = String(card.word || "").trim();
    if (!word) {
      anomalies.push({ index, value: String(item).slice(0, 80), reason: "缺少 word" });
      return;
    }
    if (!/^[A-Za-z][A-Za-z' -]{0,62}$/.test(word)) {
      anomalies.push({ index, value: word.slice(0, 80), reason: "单词格式异常" });
      return;
    }
    const key = word.toLowerCase();
    if (seen.has(key)) {
      anomalies.push({ index, value: word, reason: "重复词条" });
      return;
    }
    seen.add(key);
    valid.push({
      word,
      pos: String(card.pos || "").trim().slice(0, 24),
      meaning_cn: String(card.meaning_cn || card.meaning || "").trim().slice(0, 160),
      meaning_en: String(card.meaning_en || "").trim().slice(0, 200),
      level: String(card.level || (Array.isArray(card.levels) && card.levels.length ? card.levels[0] : "") || "").trim().slice(0, 40),
    });
  });
  return {
    source: source || "manual",
    raw_entries: items.slice(0, 200),
    raw_count: items.length,
    valid_count: valid.length,
    anomaly_count: anomalies.length,
    valid_entries: valid,
    anomalies,
  };
}

function sortWords(cards, runId) {
  /* 同步使用本地语境分组（pipeline 调试页允许纯本地排序）。 */
  const grouped = grouping.localGroup(cards);
  const groups = grouped.groups.map((group, index) => ({ id: `G${String(index + 1).padStart(2, "0")}`, ...group }));
  const output = {
    provider: grouped.provider,
    groups: grouped.groups,
    selected_group: grouped.selected_group,
    semantic_clusters: groups.map((group) => ({ theme: group.theme, words: group.words })),
    difficulty_layers: { foundation: [], intermediate: [], advanced: [] },
    cooccurrence: [],
    optimal_groups: groups,
  };
  const metric = grouped.provider === "external-api" ? null : {
    skill: "word_sort", prompt_version: prompts.version("word_sort"),
    provider: "local-semantic", model: "none", fallback: true,
    cache_hit: false, status: "fallback", input_tokens: 0,
    output_tokens: 0, total_tokens: 0, elapsed_ms: 0,
    metadata: { run_id: runId, word_count: cards.length },
  };
  return { output, metric };
}

function sourceContext(source, payload) {
  const item = payload && typeof payload === "object" ? payload : {};
  return {
    type: source || "original",
    question_or_title: String(item.title || item.question || "").slice(0, 240),
    summary: String(item.summary || item.excerpt || item.description || "").slice(0, 800),
    answer_outline: String(item.content || item.answer_outline || "").slice(0, 1800),
    tags: ((item.labels || item.tags || []).slice(0, 10)).map((tag) => String(tag).slice(0, 50)),
    author: String(item.author || "").slice(0, 80),
    url: String(item.url || "").slice(0, 500),
    vote_up_count: Number(item.vote_up_count) || 0,
  };
}

function sourceNote(ctx) {
  const title = String(ctx.question_or_title || "").trim();
  if (!title) return "来源：AI 原创生成｜Bookwords 英语学习材料";
  if (ctx.type === "zhihu_search") {
    let note = `来源：知乎《${title}》`;
    if (ctx.author) note += `｜作者：${ctx.author}`;
    if (ctx.vote_up_count) note += `｜赞同 ${ctx.vote_up_count}`;
    return note;
  }
  if (ctx.type === "hot") return `来源：知乎热榜《${title}》`;
  if (ctx.type === "story") return `来源：知乎故事《${title}》`;
  if (ctx.type === "knowledge") return `来源：知乎知识《${title}》`;
  return "来源：AI 原创生成｜Bookwords 英语学习材料";
}

async function generateStory(group, ctx, runId) {
  const words = [...(group.words || [])];
  const version = prompts.version("pipeline_story");
  const system = (
    "你是知乎英语日报生文编辑。给定词集和题材约束，写一篇真实语境感的短文。知乎问题可作标题或切入点，" +
    "回答摘要只作为论点骨架，不得逐句复制。" +
    "标题必须是4至9词的编辑式陈述标题，提炼具体场景、机制、结果或反差；不得以 Why、What、How、Can、" +
    "Could、Do、Does、Did、Is、Are、Should 开头，不得机械复述知乎问题，通常不用问号。" +
    "每个目标词须以 **word** 出现在英文中。" +
    "输出 JSON：{title,en,zh}。en 为 120-220 词英文短文，zh 为忠实中文呈现，不得增加事实。"
  );
  const response = await llm.complete({
    skillName: "story_generation",
    promptVersion: version,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify({ word_group: group, topic_constraint: ctx }) },
    ],
    config: settings.effectiveApi(),
    jsonMode: true,
    temperature: 0.65,
    metadata: { run_id: runId, words, source: ctx.type },
  });
  const payload = extractJson(response.content);
  const story = {
    title: String(payload.title || "").trim(),
    en: String(payload.en || "").trim(),
    zh: String(payload.zh || "").trim(),
    mode: "article",
    source_note: sourceNote(ctx),
  };
  for (const key of ["title", "en", "zh"]) {
    if (!story[key]) throw new Error("生文结果缺少 title、en 或 zh");
  }
  for (const word of words) {
    if (!new RegExp(`\\*\\*${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*\\*`, "i").test(story.en)) {
      throw new Error(`目标词未加粗：${word}`);
    }
  }
  return { story, metrics: response.metrics };
}

function buildDigest(story, sortedWords, ctx, runId) {
  const words = [...new Set(sortedWords.optimal_groups.flatMap((group) => group.words))];
  return {
    digests: {
      weekly: {
        format: "vocabulary_map",
        title: "本周词汇地图",
        summary: `以“${story.title}”为起点，将 ${words.length} 个目标词按语义与难度重新组织。`,
        themes: [{ name: "当前主题", words }],
        source_note: sourceNote(ctx),
      },
      monthly: {
        format: "theme_collection",
        title: "本月主题合辑",
        summary: "将每日文章沉淀为科技、商业、文化等主题单元，数据积累后再生成跨文综述。",
        candidate_themes: ["科技", "商业", "文化"],
        source_note: sourceNote(ctx),
      },
    },
    metric: {
      skill: "periodical_digest", prompt_version: prompts.version("periodical_digest"),
      provider: "local-aggregation", model: "none", fallback: false,
      cache_hit: false, status: "success", input_tokens: 0,
      output_tokens: 0, total_tokens: 0, elapsed_ms: 0,
      metadata: { run_id: runId, word_count: words.length, ai_calls: 0 },
    },
  };
}

async function runPipeline(payload, resolvedSource = null) {
  const body = payload && typeof payload === "object" ? payload : {};
  const runId = Math.random().toString(16).slice(2, 14);
  const language = body.language === "zh" ? "zh" : "en";
  const imported = importWords(body.words, String(body.import_source || "manual"));
  const cards = imported.valid_entries;
  if (cards.length < 3) {
    return { ok: false, run_id: runId, error: "至少需要 3 个有效词条", import: imported };
  }
  const { output: sortedOutput, metric: sortMetric } = sortWords(cards, runId);
  const primaryGroup = sortedOutput.optimal_groups[0];
  const ctx = sourceContext(String(body.source || "original"), resolvedSource || body.source_payload);
  let story;
  let storyMetric;
  try {
    ({ story, metrics: storyMetric } = await generateStory(primaryGroup, ctx, runId));
  } catch (err) {
    llm.recordFallback("story_generation", prompts.version("pipeline_story"), String(err.message || err), settings.effectiveApi(), { run_id: runId, words: primaryGroup.words });
    throw new Error(`文章生成 API 失败：${err.message}`);
  }
  const { digests, metric: digestMetric } = buildDigest(story, sortedOutput, ctx, runId);
  const selectedContent = language === "zh" ? story.zh : story.en;
  const fallback = [sortMetric, storyMetric, digestMetric].some((m) => m && m.fallback);
  return {
    ok: true,
    run_id: runId,
    import: imported,
    sorting: sortedOutput,
    story: {
      input_words: primaryGroup.words,
      topic_constraint: ctx,
      title: story.title,
      en: story.en,
      zh: story.zh,
      mode: story.mode,
      prompt_version: prompts.version("pipeline_story"),
      fallback: Boolean(storyMetric && storyMetric.fallback),
      source_note: story.source_note,
    },
    language: { selected: language, available: ["zh", "en"], content: selectedContent },
    daily: {
      date: new Date().toISOString().slice(0, 10),
      word_set: primaryGroup.words,
      title: story.title,
      content: selectedContent,
      content_en: story.en,
      content_zh: story.zh,
      language,
      status: fallback ? "fallback_success" : "success",
      source_note: story.source_note,
    },
    weekly: digests.weekly,
    monthly: digests.monthly,
    metrics: [sortMetric, storyMetric, digestMetric].filter(Boolean),
    prompt_versions: prompts.versions(),
  };
}

module.exports = { runPipeline };
